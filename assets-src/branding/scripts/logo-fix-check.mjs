#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { CROP_SCALE, buildFixSheet } from './lib/fix-check.mjs';
import { boxOf } from './lib/outline-fit.mjs';
import { findHoles } from './lib/pixel-draft.mjs';
import { readRaster } from './lib/raster.mjs';
import { resolveOutDir } from './lib/run.mjs';
import { checkFinalSvg } from './lib/svg-checks.mjs';

const USAGE = 'Usage: logo-fix-check.mjs --master <approved logo master.png> [--old approved] [--new raw/s4/logo-final-2] [--sheet out/s4/logo-fix-check.png] [--scale 4]';
const PLATES = ['logo-plate-nolines', 'logo-plate'];
const say = (line) => process.stdout.write(`${line}\n`);

const readPlate = (directory, name) => {
    const path = join(directory, `${name}.svg`);
    if (!existsSync(path)) {
        throw new Error(`${relative(ROOT_DIR, path)} is missing.`);
    }
    const svg = readFileSync(path, 'utf8');
    const { bytes, gzipBytes } = checkFinalSvg(svg, `${name}.svg`);
    return { svg, bytes, gzipBytes, shown: relative(ROOT_DIR, path).split(sep).join('/') };
};

try {
    const { values } = parseArgs({ options: { master: { type: 'string' }, old: { type: 'string', default: 'approved' }, new: { type: 'string', default: 'raw/s4/logo-final-2' }, sheet: { type: 'string', default: 'out/s4/logo-fix-check.png' }, scale: { type: 'string', default: String(CROP_SCALE) }, help: { type: 'boolean', default: false } } });
    if (values.help || !values.master) {
        throw new Error(USAGE);
    }
    const scale = Number(values.scale);
    if (!Number.isInteger(scale) || scale < 1 || scale > 8) {
        throw new Error(`--scale must be a whole number from 1 to 8, got "${values.scale}".`);
    }
    const sheetPath = isAbsolute(values.sheet) ? values.sheet : resolve(values.sheet);
    resolveOutDir(ROOT_DIR, dirname(sheetPath));
    const shown = relative(ROOT_DIR, sheetPath).split(sep).join('/');
    if (!shown.startsWith('out/')) {
        throw new Error(`The check sheet is written under out/ only, not ${shown}.`);
    }
    if (existsSync(sheetPath)) {
        throw new Error(`${shown} already exists; remove it first.`);
    }
    const master = await readRaster(resolve(values.master));
    const letters = boxOf(findHoles(master), master.width, master.height);
    if (!letters) {
        throw new Error(`${values.master} has no letters cut out of it, so the regions cannot be placed.`);
    }
    const plates = PLATES.map((name) => {
        const [oldPlate, newPlate] = [readPlate(resolve(values.old), name), readPlate(resolve(values.new), name)];
        say(`${name}  old ${oldPlate.bytes} bytes, ${oldPlate.gzipBytes} gzipped  new ${newPlate.bytes} bytes, ${newPlate.gzipBytes} gzipped`);
        return { label: name, oldSvg: oldPlate.svg, newSvg: newPlate.svg };
    });
    const sheet = await buildFixSheet({ letters, plates, scale });
    mkdirSync(dirname(sheetPath), { recursive: true });
    writeFileSync(sheetPath, sheet, { flag: 'wx' });
    say(shown);
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
