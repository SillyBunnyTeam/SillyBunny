#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { buildFinalCheck } from './lib/final-check.mjs';
import { resolveOutDir } from './lib/run.mjs';
import { checkFinalSvg } from './lib/svg-checks.mjs';

const USAGE = 'Usage: logo-final-check.mjs [--dir raw/s4/logo-final] [--sheet out/s4/logo-final-check.png]';
const FILES = { emblem: 'logo-emblem.svg', emblemNolines: 'logo-emblem-nolines.svg', plate: 'logo-plate.svg', plateNolines: 'logo-plate-nolines.svg' };
const say = (line) => process.stdout.write(`${line}\n`);

try {
    const { values } = parseArgs({ options: { dir: { type: 'string', default: 'raw/s4/logo-final' }, sheet: { type: 'string', default: 'out/s4/logo-final-check.png' }, help: { type: 'boolean', default: false } } });
    if (values.help) {
        throw new Error(USAGE);
    }
    const directory = resolve(values.dir);
    const sheetPath = isAbsolute(values.sheet) ? values.sheet : resolve(values.sheet);
    resolveOutDir(ROOT_DIR, dirname(sheetPath));
    const shown = relative(ROOT_DIR, sheetPath).split(sep).join('/');
    if (!shown.startsWith('out/')) {
        throw new Error(`The check sheet is written under out/ only, not ${shown}.`);
    }
    if (existsSync(sheetPath)) {
        throw new Error(`${shown} already exists; remove it first.`);
    }
    const svgs = {};
    for (const [key, name] of Object.entries(FILES)) {
        const path = join(directory, name);
        if (!existsSync(path)) {
            throw new Error(`${relative(ROOT_DIR, path)} is missing.`);
        }
        svgs[key] = readFileSync(path, 'utf8');
        const { bytes, gzipBytes } = checkFinalSvg(svgs[key], name);
        say(`${name}  ${bytes} bytes, ${gzipBytes} gzipped  (viewBox, no width or height, no metadata, under 12 KB: ok)`);
    }
    const sheet = await buildFinalCheck(svgs);
    mkdirSync(dirname(sheetPath), { recursive: true });
    writeFileSync(sheetPath, sheet, { flag: 'wx' });
    say(shown);
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
