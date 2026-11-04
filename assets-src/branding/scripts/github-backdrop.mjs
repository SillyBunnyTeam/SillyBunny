#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { comparePlates, loadBackdropConfig, loggedPlates, snapPlate } from './lib/github-backdrop-run.mjs';
import { assertStage, commitSnapLog, planSnapLog } from './lib/github-snap-log.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: github-backdrop.mjs [--plate name]... (default: every plate of github-backdrops.json) [--variant name]... (default: every crop) [--root dir] [--stage s8]\n  Without --stage this is a preview: it writes under out/ and logs nothing.\n  With --stage it also writes each snap to raw/<stage>/pixel/backdrop-<plate>-<variant>.png and logs it; approve.mjs then approves it.';
const say = (line) => process.stdout.write(`${line}\n`);

async function main() {
    const { values } = parseArgs({ options: { plate: { type: 'string', multiple: true, default: [] }, variant: { type: 'string', multiple: true, default: [] }, root: { type: 'string' }, stage: { type: 'string' }, help: { type: 'boolean', default: false } } });
    if (values.help) {
        say(USAGE);
        return;
    }
    if (values.stage !== undefined) {
        assertStage(values.stage);
    }
    const rootDir = values.root ? resolve(values.root) : ROOT_DIR;
    const config = loadBackdropConfig(rootDir);
    const names = values.plate.length > 0 ? values.plate : Object.keys(config.plates);
    const snapped = [];
    for (const plate of names) {
        if (!config.plates[plate]) {
            throw new Error(`"${plate}" is not a plate of github-backdrops.json. Plates: ${Object.keys(config.plates).join(', ')}.`);
        }
        const result = await snapPlate({ rootDir, plate, config, only: values.variant.length > 0 ? values.variant : undefined });
        snapped.push(result);
        const { across, down } = result.grid;
        say(`${plate}: ${result.master.width}x${result.master.height}; grid ${across.cell.toFixed(3)} across (offset ${across.offset.toFixed(2)}, strength ${across.strength.toFixed(2)}) by ${down.cell.toFixed(3)} down (offset ${down.offset.toFixed(2)}, strength ${down.strength.toFixed(2)})`);
        for (const { variant, columns, rows, step, cell, file } of result.variants) {
            say(`  ${variant}: ${columns}x${rows} art px of ${cell} master px, placed at step ${step} -> ${columns * step}x${rows * step}  ${file}`);
        }
    }
    for (const { plate } of snapped) {
        const { compare } = config.plates[plate];
        const against = compare && snapped.find((other) => other.plate === compare.against);
        if (!against) {
            continue;
        }
        const own = snapped.find((other) => other.plate === plate);
        const { regions, moon } = comparePlates(against.master, own.master, compare);
        say(`${plate} against ${compare.against} (edges of the strongest 15% of colour changes, shifts searched within 8 px):`);
        for (const { name, dx, dy, overlap, overlapAtZero } of regions) {
            say(`  ${name.padEnd(22)} best shift ${dx},${dy}; edge overlap ${(100 * overlapAtZero).toFixed(1)}% at 0,0 (${(100 * overlap).toFixed(1)}% at the best shift)`);
        }
        say(`  moon: ${compare.against} centre ${moon.day.x},${moon.day.y} r ${moon.day.radius}; ${plate} centre ${moon.night.x},${moon.night.y} r ${moon.night.radius}; shift ${moon.dx},${moon.dy} r ${moon.dradius >= 0 ? '+' : ''}${moon.dradius}`);
        const grids = [against.grid, own.grid];
        say(`  grid offsets differ by ${Math.abs(grids[0].across.offset - grids[1].across.offset).toFixed(2)} across and ${Math.abs(grids[0].down.offset - grids[1].down.offset).toFixed(2)} down (cells ${grids[0].across.cell.toFixed(3)}/${grids[1].across.cell.toFixed(3)} and ${grids[0].down.cell.toFixed(3)}/${grids[1].down.cell.toFixed(3)})`);
    }
    if (values.stage === undefined) {
        say('preview only: nothing was logged and approved/ was not written.');
        return;
    }
    const logged = commitSnapLog(planSnapLog({ rootDir, stage: values.stage, snaps: loggedPlates(config, snapped) }), { rootDir, stage: values.stage, now: () => new Date() });
    for (const { file, sha256 } of logged) {
        say(`logged ${file} (sha256 ${sha256.slice(0, 16)})`);
    }
    say('approved/ was not written: approve each with approve.mjs.');
}

try {
    await main();
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
}
