#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { findPalettePath, readPalette } from './lib/pixel-colour.mjs';
import { orphansToPatch, pixelateRaster } from './lib/pixelate.mjs';
import { parseSize, readRaster, writeRaster } from './lib/raster.mjs';

const USAGE = 'Usage: pixelate.mjs --in <png> --grid 128x128 --palette <name|file> [--out out/pixel/<name>.png] [--cell N] [--sample mode|centre] [--alpha-threshold 128] [--fix-orphans] [--orphans-patch <file.json>] [--indexed]';
const MAX_COLOURS = 32;
const MIN_COLOURS = 24;

try {
    const { values } = parseArgs({
        options: {
            in: { type: 'string' },
            grid: { type: 'string' },
            palette: { type: 'string' },
            out: { type: 'string' },
            cell: { type: 'string' },
            sample: { type: 'string', default: 'mode' },
            'alpha-threshold': { type: 'string', default: '128' },
            'fix-orphans': { type: 'boolean', default: false },
            'orphans-patch': { type: 'string' },
            indexed: { type: 'boolean', default: false },
        },
    });
    if (!values.in || !values.grid || !values.palette) {
        throw new Error(USAGE);
    }
    const input = resolve(values.in);
    const out = resolve(values.out ?? join('out', 'pixel', `${basename(input, extname(input))}.png`));
    if (out === input) {
        throw new Error('--out must be a different file from --in.');
    }
    const palette = readPalette(findPalettePath(ROOT_DIR, values.palette));
    if (palette.length > MAX_COLOURS) {
        throw new Error(`The palette has ${palette.length} colours; the style guide allows at most ${MAX_COLOURS}.`);
    }
    const cell = values.cell === undefined ? undefined : Number(values.cell);
    const alphaThreshold = Number(values['alpha-threshold']);
    if ((cell !== undefined && !(cell >= 1)) || !Number.isInteger(alphaThreshold) || alphaThreshold < 1 || alphaThreshold > 255) {
        throw new Error('--cell must be a number of 1 or more and --alpha-threshold a whole number from 1 to 255.');
    }
    const { raster, report } = pixelateRaster(await readRaster(input), {
        grid: parseSize(values.grid, '--grid'),
        palette,
        cell,
        sample: values.sample,
        alphaThreshold,
        fixOrphans: values['fix-orphans'],
    });
    if (palette.length < MIN_COLOURS) {
        report.warnings.push(`The palette has ${palette.length} colours; the style guide asks for ${MIN_COLOURS} to ${MAX_COLOURS}.`);
    }

    mkdirSync(dirname(out), { recursive: true });
    await writeRaster(out, raster, { indexed: values.indexed });
    const reportPath = out.replace(/\.png$/i, '') + '.report.json';
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (values['orphans-patch']) {
        writeFileSync(resolve(values['orphans-patch']), `${JSON.stringify(orphansToPatch(report.orphans), null, 2)}\n`);
    }

    const say = (line) => process.stdout.write(`${line}\n`);
    say(out);
    say(`grid ${report.grid.width}x${report.grid.height}  cell ${report.cell.toFixed(2)} (${report.cellSource}${report.strength === undefined ? '' : `, strength ${report.strength.toFixed(2)}`})  sample ${report.sample}`);
    say(`palette ${report.paletteSize} colours, ${report.coloursUsed} used  sprite ${report.sprite ? `${report.sprite.width}x${report.sprite.height} at ${report.sprite.x},${report.sprite.y}` : 'none'}`);
    const listed = report.orphans.slice(0, 12).map(({ x, y, kind, suggest }) => `${kind} ${x},${y} -> ${suggest}`).join('; ');
    say(report.orphansFixed
        ? `orphans: ${report.orphans.length} found and FIXED${listed ? ` (${listed})` : ''}`
        : `orphans: ${report.orphans.length} found, NOT changed${listed ? ` (${listed}${report.orphans.length > 12 ? '; more in the report' : ''})` : ''}. Pass --fix-orphans, or --orphans-patch <file> to review them as a pixel-fix patch.`);
    for (const warning of report.warnings) {
        say(`WARNING: ${warning}`);
    }
    say(`report: ${reportPath}`);
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
