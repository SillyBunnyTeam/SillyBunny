#!/usr/bin/env node
import { readFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { findPalettePath, readPalette } from './lib/pixel-colour.mjs';
import { applyPixelPatch, offPaletteColours, parsePixelPatch } from './lib/pixel-patch.mjs';
import { readRaster, writeRaster } from './lib/raster.mjs';

const USAGE = 'Usage: pixel-fix.mjs --in <native.png> --patch <patch.json> [--palette <name|file>] [--allow-off-palette] [--out out/pixel-fixed/<name>.png] [--indexed]';

try {
    const { values } = parseArgs({
        options: {
            in: { type: 'string' },
            patch: { type: 'string' },
            palette: { type: 'string' },
            'allow-off-palette': { type: 'boolean', default: false },
            out: { type: 'string' },
            indexed: { type: 'boolean', default: false },
        },
    });
    if (!values.in || !values.patch) {
        throw new Error(USAGE);
    }
    const input = resolve(values.in);
    const out = resolve(values.out ?? join('out', 'pixel-fixed', `${basename(input, extname(input))}.png`));
    if (out === input) {
        throw new Error('--out must be a different file from --in, so the picture being fixed is never overwritten.');
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(resolve(values.patch), 'utf8'));
    } catch (error) {
        throw new Error(`${values.patch} is not valid JSON: ${error.message}`);
    }
    const raster = await readRaster(input);
    const ops = parsePixelPatch(raw, raster);
    if (values.palette) {
        const off = offPaletteColours(ops, readPalette(findPalettePath(ROOT_DIR, values.palette)));
        if (off.length > 0 && !values['allow-off-palette']) {
            throw new Error(`The patch paints colours that are not in the palette: ${off.join(', ')}. Use palette colours, or pass --allow-off-palette.`);
        }
    }
    const { raster: fixed, changed } = applyPixelPatch(raster, ops);
    mkdirSync(dirname(out), { recursive: true });
    await writeRaster(out, fixed, { indexed: values.indexed });
    process.stdout.write(`${out}\n${ops.length} edit${ops.length === 1 ? '' : 's'}, ${changed} pixel${changed === 1 ? '' : 's'} changed\n`);
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
