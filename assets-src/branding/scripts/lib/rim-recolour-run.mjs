import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { formatHex } from './pixel-colour.mjs';
import { sniffImage } from './images.mjs';
import { appendLogEntry, makeLogEntry, sha256 } from './log.mjs';
import { readRaster } from './raster.mjs';
import { addRimMeasured, measureRimWidth } from './rim-add.mjs';
import { median, recolourRim } from './rim-recolour.mjs';
import { resolveOutDir } from './run.mjs';
import sharp from 'sharp';

const toLogPath = (rootDir, path) => relative(rootDir, path).split(sep).join('/');

/**
 * The rim width of every approved master, and their median. A sheet (its name starts with the timestamp of its generation) and a
 * picture with no rim to measure are listed as skipped, with the reason.
 * @param {string} approvedDir
 */
export async function measureApprovedRims(approvedDir) {
    if (!existsSync(approvedDir)) {
        throw new Error(`${approvedDir} does not exist, so there is nothing to measure the rim width on.`);
    }
    const widths = [];
    const skipped = [];
    for (const file of readdirSync(approvedDir).filter((name) => name.endsWith('.png')).sort()) {
        if (/^\d/.test(file)) {
            skipped.push({ file, reason: 'a design sheet, not a master' });
            continue;
        }
        try {
            widths.push({ file, width: measureRimWidth(await readRaster(join(approvedDir, file))) });
        } catch (error) {
            skipped.push({ file, reason: error.message });
        }
    }
    if (widths.length === 0) {
        throw new Error(`No approved master in ${approvedDir} has a rim to measure.`);
    }
    return { widths, skipped, median: median(widths.map(({ width }) => width)) };
}

/**
 * Recolours the rim of one generated picture, or with `addRim` draws one that is missing, writes the result under raw/ or out/
 * and logs it as a derived output (no model call, so it costs nothing; the source's sha256 is in `refs`, as for `patch-composite`).
 * @param {{ rootDir: string, inPath: string, outPath: string, target: number[], stage: string, now: () => Date, addRim?: { width: number } }} request. `addRim.width` is the rim width as `--measure` reads it.
 */
export async function runRimRecolour({ rootDir, inPath, outPath, target, stage, now, addRim: drawRim }) {
    const absoluteOut = isAbsolute(outPath) ? outPath : resolve(outPath);
    resolveOutDir(rootDir, dirname(absoluteOut));
    if (existsSync(absoluteOut)) {
        throw new Error(`${toLogPath(rootDir, absoluteOut)} already exists; pick another name or remove it first.`);
    }
    const sourceBytes = readFileSync(inPath);
    sniffImage(sourceBytes);
    const source = await readRaster(inPath);
    const { raster, stats } = drawRim ? addRimMeasured(source, { target, measuredWidth: drawRim.width }) : recolourRim(source, { target });

    const png = await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
    mkdirSync(dirname(absoluteOut), { recursive: true });
    writeFileSync(absoluteOut, png, { flag: 'wx' });
    appendLogEntry(join(rootDir, 'log', 'generations.jsonl'), makeLogEntry({
        time: now().toISOString(),
        stage,
        provider: 'local',
        model: 'rim-recolour',
        template: 'rim-recolour',
        vars: {
            source: toLogPath(rootDir, resolve(inPath)),
            target: formatHex(target),
            ...(drawRim
                ? { mode: 'add-rim', width: drawRim.width, drawnWidth: Math.round(stats.width * 100) / 100, added: stats.added, replaced: stats.replaced }
                : { rimBefore: formatHex(stats.rimBefore), recoloured: stats.recoloured }),
        },
        refHashes: [sha256(sourceBytes)],
        size: `${raster.width}x${raster.height}`,
        outputs: [{ file: toLogPath(rootDir, absoluteOut), sha256: sha256(png) }],
        estimatedUsd: 0,
    }));
    return { ...stats, file: toLogPath(rootDir, absoluteOut) };
}
