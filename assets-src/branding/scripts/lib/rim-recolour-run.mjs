import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { formatHex } from './pixel-colour.mjs';
import { sniffImage } from './images.mjs';
import { appendLogEntry, makeLogEntry, sha256 } from './log.mjs';
import { readRaster } from './raster.mjs';
import { recolourRim } from './rim-recolour.mjs';
import { resolveOutDir } from './run.mjs';
import sharp from 'sharp';

const toLogPath = (rootDir, path) => relative(rootDir, path).split(sep).join('/');

/**
 * Recolours the rim of one generated picture, writes the result under raw/ or out/ and logs it as a derived output
 * (no model call, so it costs nothing; the source's sha256 is in `refs`, as for `patch-composite`).
 * @param {{ rootDir: string, inPath: string, outPath: string, target: number[], stage: string, now: () => Date }} request
 */
export async function runRimRecolour({ rootDir, inPath, outPath, target, stage, now }) {
    const absoluteOut = isAbsolute(outPath) ? outPath : resolve(outPath);
    resolveOutDir(rootDir, dirname(absoluteOut));
    if (existsSync(absoluteOut)) {
        throw new Error(`${toLogPath(rootDir, absoluteOut)} already exists; pick another name or remove it first.`);
    }
    const sourceBytes = readFileSync(inPath);
    sniffImage(sourceBytes);
    const source = await readRaster(inPath);
    const { raster, stats } = recolourRim(source, { target });

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
            rimBefore: formatHex(stats.rimBefore),
            recoloured: stats.recoloured,
        },
        refHashes: [sha256(sourceBytes)],
        size: `${raster.width}x${raster.height}`,
        outputs: [{ file: toLogPath(rootDir, absoluteOut), sha256: sha256(png) }],
        estimatedUsd: 0,
    }));
    return { ...stats, file: toLogPath(rootDir, absoluteOut) };
}
