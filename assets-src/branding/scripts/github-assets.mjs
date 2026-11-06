#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildSheets } from './lib/github-sheets.mjs';
import { runGithubAssets } from './lib/github-run.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: github-assets.mjs [--out-dir out/github] [--write [--choose slot=layout]...]  (banner slots default to the layout of the same id)';
const say = (line) => process.stdout.write(`${line}\n`);

/** `--choose avatar=avatar-tile` pairs into an object. */
function parseChoices(list) {
    return Object.fromEntries(list.map((pair) => {
        const [slot, id, ...rest] = pair.split('=');
        if (!slot || !id || rest.length > 0) {
            throw new Error(`--choose takes slot=layout, got "${pair}". ${USAGE}`);
        }
        return [slot, id];
    }));
}

async function main() {
    const { values } = parseArgs({
        options: {
            'out-dir': { type: 'string', default: 'out/github' },
            write: { type: 'boolean', default: false },
            choose: { type: 'string', multiple: true, default: [] },
            help: { type: 'boolean', default: false },
        },
    });
    if (values.help) {
        say(USAGE);
        return;
    }
    const result = await runGithubAssets({ rootDir: ROOT_DIR, outDir: values['out-dir'], write: values.write, choose: parseChoices(values.choose), sheet: buildSheets });
    const width = Math.max(...result.files.map(({ id }) => id.length));
    for (const { id, width: w, height, bytes, placeholders } of result.files) {
        say(`${id.padEnd(width)}  ${w}x${height}  ${bytes} bytes${placeholders.length > 0 ? `  STAND-IN ART: ${placeholders.join(', ')}` : ''}`);
    }
    say(`sheets: ${result.sheets.join(', ')}`);
    say(result.wrote ? `wrote and logged: ${result.finals.map(({ name, layout }) => `${name} (${layout})`).join(', ')}` : 'preview only: nothing was written outside out/ and nothing was logged. Add --write to build the chosen layouts.');
}

try {
    await main();
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
}
