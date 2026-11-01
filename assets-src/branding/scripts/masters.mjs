#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR, runDeps } from './lib/cli.mjs';
import { loadEnvironment } from './lib/env.mjs';
import { dryRunMasters, formatTable, generateMasters, loggedUsd, parseMastersSpec, summarise } from './lib/masters.mjs';
import { redactText } from './lib/redact.mjs';
import { usd } from './lib/run.mjs';

const USAGE = 'Usage: masters.mjs [--spec prompts/s5-masters.json] [--only id,id] [--n 1] [--dry-run] [--prompt id,id|all] [--yes]';
const say = (line) => process.stdout.write(`${line}\n`);
const splitList = (value) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : undefined);

const env = loadEnvironment({ dotenvPath: join(ROOT_DIR, '.env') });
const secrets = Object.values(env).map((settings) => settings.apiKey);

try {
    const { values } = parseArgs({
        options: {
            spec: { type: 'string', default: join('prompts', 's5-masters.json') },
            only: { type: 'string' },
            n: { type: 'string', default: '1' },
            'dry-run': { type: 'boolean', default: false },
            prompt: { type: 'string' },
            yes: { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.help) {
        say(USAGE);
    } else {
        const n = Number(values.n);
        if (!Number.isInteger(n) || n < 1) {
            throw new Error('--n must be a whole number of 1 or more.');
        }
        const spec = parseMastersSpec(JSON.parse(readFileSync(resolve(ROOT_DIR, values.spec), 'utf8')));
        const only = splitList(values.only);
        const promptIds = values.prompt === 'all' ? (only ?? spec.assets.map((asset) => asset.id)) : splitList(values.prompt);
        const deps = runDeps(env);
        if (values['dry-run']) {
            const rows = await dryRunMasters({ spec, deps, only });
            for (const id of promptIds ?? []) {
                if (!rows.some((row) => row.id === id)) {
                    throw new Error(`--prompt names "${id}", which is not among the slots that were run.`);
                }
            }
            formatTable(rows).forEach(say);
            const { oneEach, twoEach, runningUsd, capUsd } = summarise(rows, { runningUsd: loggedUsd(ROOT_DIR), capUsd: deps.config.costCapUsd });
            const perImage = rows[0].perImageUsd;
            for (const [label, count, totals] of [['1 image per slot', rows.length, oneEach], ['2 images per slot', rows.length * 2, twoEach]]) {
                const verdict = totals.withinCap ? 'within the cap' : 'WOULD REFUSE: passes the cap';
                say(`${label}: ${count} x ${usd(perImage)} = ${usd(totals.totalUsd)}   logged so far ${usd(runningUsd)} + this = ${usd(totals.projectedUsd)}   cap ${usd(capUsd)}   ${verdict}`);
            }
            for (const row of rows.filter(({ id }) => promptIds?.includes(id))) {
                say(`--- prompt: ${row.id} ---`);
                say(row.prompt);
            }
            say('dry run: nothing was sent, saved or logged.');
        } else {
            await generateMasters({ spec, deps, only, n, yes: values.yes });
        }
    }
} catch (error) {
    process.stderr.write(`error: ${redactText(error.message, secrets)}\n`);
    process.exitCode = 1;
}
