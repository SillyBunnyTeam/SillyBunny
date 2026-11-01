#!/usr/bin/env node
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { formatHex } from './lib/pixel-colour.mjs';
import { parseHexColour } from './lib/rim-recolour.mjs';
import { runRimRecolour } from './lib/rim-recolour-run.mjs';

const USAGE = 'Usage: rim-recolour.mjs --in <picture.png> --out raw/<stage>/masters/<name>.png [--target #b99bf2] [--stage s3]';
const DEFAULT_TARGET = '#b99bf2';

try {
    const { values } = parseArgs({
        options: {
            in: { type: 'string' },
            out: { type: 'string' },
            target: { type: 'string', default: DEFAULT_TARGET },
            stage: { type: 'string' },
        },
    });
    if (!values.in || !values.out) {
        throw new Error(USAGE);
    }
    const target = parseHexColour(values.target);
    const outPath = resolve(values.out);
    // raw/<stage>/... names its own stage; anywhere else the caller says.
    const [top, folder] = relative(ROOT_DIR, outPath).split(sep);
    const stage = values.stage ?? (top === 'raw' ? folder : undefined);
    if (!stage) {
        throw new Error(`Pass --stage when --out is not under raw/<stage>/. ${USAGE}`);
    }
    const result = await runRimRecolour({ rootDir: ROOT_DIR, inPath: resolve(values.in), outPath, target, stage, now: () => new Date() });
    const say = (line) => process.stdout.write(`${line}\n`);
    say(join(ROOT_DIR, result.file));
    say(`rim ${formatHex(result.rimBefore)} -> ${formatHex(target)}  ${result.recoloured} pixels recoloured (depth cap ${result.depthCap}); alpha and everything inside the white band unchanged`);
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
