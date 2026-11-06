#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { compositeSheetFor } from './lib/composite-sheet.mjs';
import { resolveOutDir } from './lib/run.mjs';

const USAGE = 'Usage: composite-sheet.mjs --layout layouts/<name>.grid.json --smooth approved/<name>.png --grid-image raw/<stage>/pixel-body/<name>.png --out out/snap/<name>-composite-sheet.png [--name <review prefix>]';

try {
    const { values } = parseArgs({ options: { layout: { type: 'string' }, smooth: { type: 'string' }, 'grid-image': { type: 'string' }, out: { type: 'string' }, name: { type: 'string' } } });
    if (!values.layout || !values.smooth || !values['grid-image'] || !values.out) {
        throw new Error(USAGE);
    }
    const out = resolve(values.out);
    resolveOutDir(ROOT_DIR, dirname(out));
    const name = values.name ?? values.layout.replace(/^.*\//, '').replace(/\.grid\.json$/, '');
    const bytes = await compositeSheetFor({ rootDir: ROOT_DIR, gridLayoutPath: resolve(values.layout), smoothPath: resolve(values.smooth), gridPath: resolve(values['grid-image']), name });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes, { flag: 'wx' });
    process.stdout.write(`${values.out}\n`);
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
