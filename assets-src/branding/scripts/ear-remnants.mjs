#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULTS, detectSheet, flagList, parseHeadSpec, renderRemnantSheet } from './lib/ear-remnants.mjs';
import { formatHex } from './lib/pixel-colour.mjs';
import { readRaster } from './lib/raster.mjs';

const USAGE = 'Usage: ear-remnants.mjs --image <png> --heads <heads.json> [--name <sheet>] [--out-dir out/patches] [--scale 4] [--cols 2] [--threshold 0.07] [--open-radius 7] [--min-pixels 8]';
const NUMBER_OPTIONS = { threshold: 'threshold', 'open-radius': 'openRadius', 'min-pixels': 'minPixels' };

try {
    const { values } = parseArgs({
        options: {
            image: { type: 'string' },
            heads: { type: 'string' },
            name: { type: 'string' },
            'out-dir': { type: 'string', default: join('out', 'patches') },
            scale: { type: 'string', default: '4' },
            cols: { type: 'string', default: '2' },
            threshold: { type: 'string' },
            'open-radius': { type: 'string' },
            'min-pixels': { type: 'string' },
        },
    });
    if (!values.image || !values.heads) {
        throw new Error(USAGE);
    }
    const overrides = {};
    for (const [flag, key] of Object.entries(NUMBER_OPTIONS)) {
        if (values[flag] !== undefined) {
            const value = Number(values[flag]);
            if (!(value > 0)) {
                throw new Error(`--${flag} must be a positive number.`);
            }
            overrides[key] = value;
        }
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(resolve(values.heads), 'utf8'));
    } catch (error) {
        throw new Error(error instanceof SyntaxError ? `${values.heads} is not valid JSON: ${error.message}` : `Cannot read ${values.heads}: ${error.message}`);
    }
    const raster = await readRaster(resolve(values.image));
    const results = detectSheet(raster, parseHeadSpec(raw, raster), overrides);
    const name = values.name ?? basename(values.heads, extname(values.heads)).replace(/-heads$/, '');
    const outDir = resolve(values['out-dir']);
    mkdirSync(outDir, { recursive: true });
    const sheetPath = join(outDir, `${name}-remnants.png`);
    const flagsPath = join(outDir, `${name}-flags.json`);
    writeFileSync(sheetPath, await renderRemnantSheet(raster, results, { scale: Number(values.scale), columns: Number(values.cols) }));
    writeFileSync(flagsPath, `${JSON.stringify(flagList(results))}\n`);

    const say = (line) => process.stdout.write(`${line}\n`);
    say(`settings: ${JSON.stringify({ ...DEFAULTS, ...overrides })}`);
    for (const result of results) {
        say(`${result.name}: skin ${formatHex(result.skinColour)}  ${result.components.length} flag${result.components.length === 1 ? '' : 's'}`);
        for (const { kind, x, y, width, height, pixels } of result.components) {
            say(`  ${kind}  [${x},${y},${width},${height}]  ${pixels} px`);
        }
    }
    say(sheetPath);
    say(flagsPath);
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
