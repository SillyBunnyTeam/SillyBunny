#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseSize, readRaster, writeRaster } from './lib/raster.mjs';
import { trimAlign } from './lib/trim-align.mjs';

const USAGE = 'Usage: trim-align.mjs --canvas 128x128 [--pad 0] [--baseline <pad>] [--align-x bbox|centroid] [--lock each|first] [--scale none|fit] [--nearest] [--min-alpha 1] [--out-dir out/aligned] <image> [<image> ...]';

try {
    const { values, positionals } = parseArgs({
        options: {
            canvas: { type: 'string' },
            pad: { type: 'string', default: '0' },
            baseline: { type: 'string' },
            'align-x': { type: 'string', default: 'bbox' },
            lock: { type: 'string', default: 'each' },
            scale: { type: 'string', default: 'none' },
            nearest: { type: 'boolean', default: false },
            'min-alpha': { type: 'string', default: '1' },
            'out-dir': { type: 'string', default: join('out', 'aligned') },
        },
        allowPositionals: true,
    });
    if (!values.canvas || positionals.length === 0) {
        throw new Error(USAGE);
    }
    const whole = (name, text) => {
        const value = Number(text);
        if (!Number.isInteger(value) || value < 0) {
            throw new Error(`--${name} must be a whole number of 0 or more.`);
        }
        return value;
    };
    const pad = whole('pad', values.pad);
    const results = await trimAlign(await Promise.all(positionals.map((path) => readRaster(resolve(path)))), {
        canvas: parseSize(values.canvas, '--canvas'),
        pad,
        baseline: values.baseline === undefined ? pad : whole('baseline', values.baseline),
        alignX: values['align-x'],
        lock: values.lock,
        scale: values.scale,
        nearest: values.nearest,
        minAlpha: whole('min-alpha', values['min-alpha']),
    });
    const outDir = resolve(values['out-dir']);
    mkdirSync(outDir, { recursive: true });
    for (const [index, { raster, placement, scale }] of results.entries()) {
        const path = join(outDir, `${basename(positionals[index], extname(positionals[index]))}.png`);
        if (resolve(positionals[index]) === path) {
            throw new Error(`${positionals[index]} would be overwritten; choose another --out-dir.`);
        }
        await writeRaster(path, raster);
        process.stdout.write(`${path}  ${placement.width}x${placement.height} at ${placement.x},${placement.y}${scale === 1 ? '' : `  scale ${scale}`}\n`);
    }
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
