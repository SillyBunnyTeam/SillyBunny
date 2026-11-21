#!/usr/bin/env node
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { formatHex } from './lib/pixel-colour.mjs';
import { measureRimWidth } from './lib/rim-add.mjs';
import { parseHexColour } from './lib/rim-recolour.mjs';
import { measureApprovedRims, runRimRecolour } from './lib/rim-recolour-run.mjs';
import { readRaster } from './lib/raster.mjs';

const USAGE = [
    'Usage: rim-recolour.mjs --in <picture.png> --out raw/<stage>/masters/<name>.png [--target #b99bf2] [--stage s3]',
    '       rim-recolour.mjs --add-rim --in <picture.png> --out raw/<stage>/masters/<name>.png [--rim-width <px>] [--approved approved] [--target #b99bf2] [--stage s5]',
    '       rim-recolour.mjs --measure <picture.png>...',
].join('\n');
const DEFAULT_TARGET = '#b99bf2';
const say = (line) => process.stdout.write(`${line}\n`);

try {
    const { values, positionals } = parseArgs({
        options: {
            in: { type: 'string' },
            out: { type: 'string' },
            target: { type: 'string', default: DEFAULT_TARGET },
            stage: { type: 'string' },
            'add-rim': { type: 'boolean', default: false },
            'rim-width': { type: 'string' },
            approved: { type: 'string', default: 'approved' },
            measure: { type: 'boolean', default: false },
        },
        allowPositionals: true,
    });
    if (values.measure) {
        if (positionals.length === 0) {
            throw new Error(USAGE);
        }
        for (const file of positionals) {
            say(`${file}  ${measureRimWidth(await readRaster(resolve(file))).toFixed(2)} px`);
        }
    } else {
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
        let addRim;
        if (values['add-rim']) {
            addRim = { width: await ringWidth(values) };
        }
        const result = await runRimRecolour({ rootDir: ROOT_DIR, inPath: resolve(values.in), outPath, target, stage, now: () => new Date(), addRim });
        say(join(ROOT_DIR, result.file));
        if (addRim) {
            say(`rim drawn: measures ${addRim.width.toFixed(2)} px (${result.width.toFixed(2)} px ring) of ${formatHex(target)} around the white band, ${result.added} pixels written (${result.replaced} of an old translucent fringe replaced); the band and the character are unchanged`);
        } else {
            say(`rim ${formatHex(result.rimBefore)} -> ${formatHex(target)}  ${result.recoloured} pixels recoloured (depth cap ${result.depthCap}); alpha and everything inside the white band unchanged`);
        }
    }
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}

/** --rim-width, or the median width of the approved masters' own rims. */
async function ringWidth({ 'rim-width': given, approved }) {
    if (given !== undefined) {
        const width = Number(given);
        if (!Number.isFinite(width) || width <= 0) {
            throw new Error(`--rim-width must be a positive number of pixels, got "${given}".`);
        }
        return width;
    }
    const { widths, skipped, median: width } = await measureApprovedRims(resolve(ROOT_DIR, approved));
    say(`rim width ${width.toFixed(2)} px: the median of ${widths.length} approved masters (${Math.min(...widths.map((entry) => entry.width)).toFixed(2)} to ${Math.max(...widths.map((entry) => entry.width)).toFixed(2)}); ${skipped.length} skipped`);
    return width;
}
