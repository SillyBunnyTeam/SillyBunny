#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { drawGrid } from './lib/grid-image.mjs';

const USAGE = 'Usage: grid-image.mjs --image <png> [--step 100] [--crop x,y,w,h] [--zoom 1] [--out out/grid/<name>-grid.png]';

try {
    const { values } = parseArgs({
        options: {
            image: { type: 'string' },
            step: { type: 'string', default: '100' },
            crop: { type: 'string' },
            zoom: { type: 'string', default: '1' },
            out: { type: 'string' },
        },
    });
    if (!values.image) {
        throw new Error(USAGE);
    }
    const parts = values.crop?.split(',').map(Number);
    if (parts && (parts.length !== 4 || !parts.every(Number.isFinite))) {
        throw new Error('--crop must be x,y,w,h in source pixels.');
    }
    const [x, y, width, height] = parts ?? [];
    const image = resolve(values.image);
    const grid = await drawGrid(image, { step: Number(values.step), zoom: Number(values.zoom), crop: parts && { x, y, width, height } });
    const suffix = parts ? `-grid-${parts.join('-')}` : '-grid';
    const out = resolve(values.out ?? join('out', 'grid', `${basename(image, extname(image))}${suffix}.png`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, grid);
    process.stdout.write(`${out}\n`);
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
