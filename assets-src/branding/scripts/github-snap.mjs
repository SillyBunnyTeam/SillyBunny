#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertStage, commitSnapLog, planSnapLog } from './lib/github-snap-log.mjs';
import { loadScenes, loggedScenes, snapScene } from './lib/github-snap-run.mjs';
import { repairSheet, scenesSheet } from './lib/github-sheets.mjs';
import { LINEUP_RANGE } from './lib/github-lineup.mjs';
import { readSnapConfig } from './lib/snap-config.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: github-snap.mjs [--scene name]... (default: every scene of github-scenes.json) [--no-sheet] [--root dir] [--stage s8]\n  Without --stage this is a preview: it writes under out/ and logs nothing.\n  With --stage it also writes each snap to raw/<stage>/pixel/<scene>.png and logs it; approve.mjs then approves it.';
const say = (line) => process.stdout.write(`${line}\n`);

async function main() {
    const { values } = parseArgs({ options: { scene: { type: 'string', multiple: true, default: [] }, 'no-sheet': { type: 'boolean', default: false }, root: { type: 'string' }, stage: { type: 'string' }, help: { type: 'boolean', default: false } } });
    if (values.help) {
        say(USAGE);
        return;
    }
    if (values.stage !== undefined) {
        assertStage(values.stage);
    }
    const rootDir = values.root ? resolve(values.root) : ROOT_DIR;
    const scenes = loadScenes(rootDir);
    const { lineupRatio } = readSnapConfig(rootDir);
    const names = values.scene.length > 0 ? values.scene : Object.keys(scenes);
    const results = [];
    for (const name of names) {
        if (!scenes[name]) {
            throw new Error(`"${name}" is not a scene of github-scenes.json. Scenes: ${Object.keys(scenes).join(', ')}.`);
        }
        const result = await snapScene({ rootDir, name, scene: scenes[name] });
        results.push(result);
        const { lineup: line, margins: m } = result;
        say(`${name}: cell ${result.cell.toFixed(3)} (${result.cellSource}), offset ${result.offset.x},${result.offset.y}; snapped ${result.size.width}x${result.size.height}, drawn ${result.drawn.width}x${result.drawn.height}; margins L${m.left} T${m.top} R${m.right} B${m.bottom}`);
        say(`  rings measured rim ${result.rings.measured.rim} + band ${result.rings.measured.band} (asked ${result.rings.asked.rim} + ${result.rings.asked.band})${result.padded.length ? `; master padded ${result.padded.map(({ edge, rows, pixels }) => `${edge} +${rows} rows (${pixels} clipped px)`).join(', ')}` : ''}${Object.values(result.marginAdded).some((rows) => rows > 0) ? `; transparent margin added ${Object.entries(result.marginAdded).filter(([, rows]) => rows > 0).map(([side, rows]) => `${side} +${rows}`).join(', ')} master px` : ''}${result.repaired.length ? `; repaired: erased ${result.repaired[0].erased} px, ring grown ${result.repaired[0].grown} px` : ''}`);
        say(`  line-up: Tewi ${line.tewi} / Reisen ${line.reisen} = ${line.ratio.toFixed(3)} (line-up ${lineupRatio}, range ${LINEUP_RANGE.min}-${LINEUP_RANGE.max}): ${line.verdict.toUpperCase()}${line.comparable ? '' : ' (one kneels and one stands)'}`);
        if (result.repaired.length > 0) {
            const file = join(rootDir, `out/github/sheets/${name}-repair.png`);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, await repairSheet({ before: result.before, after: result.raster, boxes: result.repaired[0].boxes }));
            say(`  repair before/after at 8x: out/github/sheets/${name}-repair.png`);
        }
        if (result.problem) {
            say(`  PROBLEM: ${result.problem}`);
        }
    }
    if (!values['no-sheet'] && names.length === Object.keys(scenes).length) {
        const sheet = await scenesSheet(results);
        const path = join(rootDir, 'out/github/sheets/scenes-snapped.png');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, sheet);
        say('sheet: out/github/sheets/scenes-snapped.png');
    }
    if (values.stage === undefined) {
        say('preview only: nothing was logged and approved/ was not written.');
        return;
    }
    const logged = commitSnapLog(planSnapLog({ rootDir, stage: values.stage, snaps: loggedScenes(scenes, results) }), { rootDir, stage: values.stage, now: () => new Date() });
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
