#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { runIcons } from './lib/icons-run.mjs';

const USAGE = 'Usage: icons.mjs [--out-dir out/icons] [--public ../../public] [--write]';
const say = (line) => process.stdout.write(`${line}\n`);

try {
    const { values } = parseArgs({
        options: {
            'out-dir': { type: 'string', default: 'out/icons' },
            public: { type: 'string', default: resolve(ROOT_DIR, '..', '..', 'public') },
            write: { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
        },
    });
    if (values.help) {
        say(USAGE);
    } else {
        const result = await runIcons({ rootDir: ROOT_DIR, publicDir: resolve(values.public), outDir: values['out-dir'], write: values.write });
        for (const [size, { edits, changed }] of Object.entries(result.patches)) {
            say(`${size} px: ${edits} edits on the draft, ${changed} pixels changed`);
        }
        const width = Math.max(...result.files.map(({ path }) => path.length));
        for (const { path, bytes } of result.files) {
            say(`${path.padEnd(width)}  ${bytes} bytes`);
        }
        say(`drafts: ${result.drafts.join(', ')}`);
        say(`sheets: ${result.sheets.join(', ')}`);
        say(result.wrote ? 'wrote the files into public/ and added a line to log/generations.jsonl' : 'preview only: the set is under the out folder; public/ and the log are untouched (pass --write to write them)');
    }
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
