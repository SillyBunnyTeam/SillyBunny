#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { loadConfig } from './lib/config.mjs';
import { capInflatedCharges } from './lib/log-fix.mjs';
import { activeRuns } from './lib/token-runs.mjs';

const USAGE = 'Usage: fix-charged.mjs --from <2026-11-01T09:10:00Z> [--write] [--root <package folder>]';

try {
    const { values } = parseArgs({
        options: { from: { type: 'string' }, write: { type: 'boolean', default: false }, root: { type: 'string' } },
        strict: true,
        allowPositionals: false,
    });
    if (!values.from) {
        throw new Error(`Pass --from. ${USAGE}`);
    }
    const rootDir = values.root ? resolve(values.root) : ROOT_DIR;
    const config = loadConfig(join(ROOT_DIR, 'config.json'));
    const priceOf = (model) => {
        const billing = config.models[model]?.billing;
        return billing?.kind === 'per-image' ? billing.usdPerImage * config.models[model].groupMultiplier : undefined;
    };
    const logPath = join(rootDir, 'log', 'generations.jsonl');
    const { text, changes } = capInflatedCharges(readFileSync(logPath, 'utf8'), { from: values.from, priceOf });
    for (const change of changes) {
        process.stdout.write(`line ${change.line}: ${change.from} -> ${change.to}  (${change.time} ${change.template}, ${change.n} image${change.n > 1 ? 's' : ''})\n`);
    }
    process.stdout.write(`${changes.length} line${changes.length === 1 ? '' : 's'} to fix.\n`);
    if (!values.write || changes.length === 0) {
        process.stdout.write(values.write ? 'nothing to write.\n' : 'nothing was written; pass --write to apply.\n');
    } else {
        const running = activeRuns(rootDir);
        if (running.length > 0) {
            throw new Error(`A generation run is still running (pid ${running.map(({ pid }) => pid).join(', ')}); it appends to the log. Wait for it to finish.`);
        }
        const temporary = `${logPath}.fix`;
        writeFileSync(temporary, text, { flag: 'wx' });
        renameSync(temporary, logPath);
        process.stdout.write(`wrote ${logPath}\n`);
    }
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
