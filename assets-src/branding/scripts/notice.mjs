#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT_DIR } from './lib/cli.mjs';
import { readLog } from './lib/log.mjs';
import { applyGeneratedRegion, detectTools, renderGeneratedRegion } from './lib/notice.mjs';

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });

try {
    const noticePath = join(ROOT_DIR, 'NOTICE.md');
    if (!existsSync(noticePath)) {
        throw new Error('NOTICE.md is missing. It holds hand-written sections that this script cannot recreate, so restore it first.');
    }
    const generated = renderGeneratedRegion({
        entries: readLog(join(ROOT_DIR, 'log', 'generations.jsonl')),
        tools: detectTools(run, { sharp: sharp.versions.sharp, node: process.version }),
        checkedOn: new Date().toISOString().slice(0, 10),
    });
    writeFileSync(noticePath, applyGeneratedRegion(readFileSync(noticePath, 'utf8'), generated));
    process.stdout.write(`updated ${noticePath}\n`);
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
