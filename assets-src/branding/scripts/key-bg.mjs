#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { keyBackgroundFile, parseHexColour } from './lib/key.mjs';

const USAGE = 'Usage: key-bg.mjs [--out-dir out/keyed] [--key #00FF00] [--tolerance 80] [--softness 40] <image> [<image> ...]';

try {
    const { values, positionals } = parseArgs({
        options: {
            'out-dir': { type: 'string', default: 'out/keyed' },
            key: { type: 'string', default: '#00FF00' },
            tolerance: { type: 'string', default: '80' },
            softness: { type: 'string', default: '40' },
        },
        allowPositionals: true,
    });
    if (positionals.length === 0) {
        throw new Error(USAGE);
    }
    const options = {
        key: parseHexColour(values.key),
        tolerance: Number(values.tolerance),
        softness: Number(values.softness),
    };
    if (![options.tolerance, options.softness].every((value) => Number.isFinite(value) && value >= 0)) {
        throw new Error('--tolerance and --softness must be numbers of 0 or more.');
    }
    const outDir = resolve(values['out-dir']);
    mkdirSync(outDir, { recursive: true });
    for (const input of positionals) {
        const output = join(outDir, `${basename(input, extname(input))}.png`);
        await keyBackgroundFile(resolve(input), output, options);
        process.stdout.write(`${output}\n`);
    }
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
