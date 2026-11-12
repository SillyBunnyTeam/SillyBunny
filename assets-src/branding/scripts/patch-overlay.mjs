#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { renderPatchOverlay } from './lib/patch-overlay.mjs';
import { parsePatchSpec } from './lib/patch.mjs';
import { readRaster } from './lib/raster.mjs';

const USAGE = 'Usage: patch-overlay.mjs --image <png> --spec <patches.json> [--scale 2] [--cols 2] [--flags <flags.json>] [--out out/patches/<spec>-overlay.png]';

/** Reads the `[x, y, kind]` list ear-remnants.mjs writes. */
function readFlags(path) {
    let flags;
    try {
        flags = JSON.parse(readFileSync(resolve(path), 'utf8'));
    } catch (error) {
        throw new Error(`Cannot read the flags file ${path}: ${error.message}`);
    }
    const valid = Array.isArray(flags) && flags.every((entry) => Array.isArray(entry) && entry.length === 3 && entry.every(Number.isInteger) && (entry[2] === 1 || entry[2] === 2));
    if (!valid) {
        throw new Error(`${path} is not a flags list: expected [[x, y, kind], ...] with kind 1 or 2.`);
    }
    return flags;
}

try {
    const { values } = parseArgs({
        options: {
            image: { type: 'string' },
            spec: { type: 'string' },
            scale: { type: 'string', default: '2' },
            cols: { type: 'string', default: '2' },
            flags: { type: 'string' },
            out: { type: 'string' },
        },
    });
    if (!values.image || !values.spec) {
        throw new Error(USAGE);
    }
    const image = resolve(values.image);
    let raw;
    try {
        raw = JSON.parse(readFileSync(resolve(values.spec), 'utf8'));
    } catch (error) {
        throw new Error(error instanceof SyntaxError ? `${values.spec} is not valid JSON: ${error.message}` : `Cannot read ${values.spec}: ${error.message}`);
    }
    const patches = parsePatchSpec(raw, await readRaster(image));
    const flags = values.flags ? readFlags(values.flags) : [];
    const sheet = await renderPatchOverlay(image, patches, { scale: Number(values.scale), columns: Number(values.cols), flags });
    const out = resolve(values.out ?? join('out', 'patches', `${basename(values.spec, extname(values.spec))}-overlay.png`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, sheet);
    process.stdout.write(`${out}\n`);
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
