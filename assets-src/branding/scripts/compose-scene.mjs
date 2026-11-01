#!/usr/bin/env node
import { relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { readRaster } from './lib/raster.mjs';
import { measureFigure } from './lib/scene-measure.mjs';
import { runComposeScene } from './lib/scene-run.mjs';

const USAGE = [
    'Usage: compose-scene.mjs --layout layouts/<name>.json --out raw/<stage>/masters/<name>.png [--stage s5] [--set <layer>=<picture>]...',
    '       compose-scene.mjs --layout layouts/<name>.json --grid --out raw/<stage>/pixel/<name>.png [--stage s5] [--set <layer>=<snapped still>]...    on the layout\'s pixel grid',
    '       compose-scene.mjs --layout layouts/<name>.json --preview --out out/<stage>/<name>.png [--set <layer>=<picture>]...',
    '       compose-scene.mjs --measure <picture.png>[:<first column>-<last column>]...',
].join('\n');
const say = (line) => process.stdout.write(`${line}\n`);

/** `a.png` or `a.png:560-1010`, the columns limiting the measure to one figure of two. */
function parseMeasureTarget(text) {
    const match = /^(.*?)(?::(\d+)-(\d+))?$/.exec(text);
    return { path: match[1], xRange: match[2] === undefined ? undefined : [Number(match[2]), Number(match[3])] };
}

function parseOverrides(pairs) {
    return Object.fromEntries(pairs.map((pair) => {
        const at = pair.indexOf('=');
        if (at < 1 || at === pair.length - 1) {
            throw new Error(`--set must be <layer>=<picture>, got "${pair}".`);
        }
        return [pair.slice(0, at), pair.slice(at + 1)];
    }));
}

try {
    const { values, positionals } = parseArgs({
        options: {
            layout: { type: 'string' },
            out: { type: 'string' },
            stage: { type: 'string' },
            set: { type: 'string', multiple: true, default: [] },
            preview: { type: 'boolean', default: false },
            grid: { type: 'boolean', default: false },
            measure: { type: 'boolean', default: false },
        },
        allowPositionals: true,
    });
    if (values.measure) {
        if (positionals.length === 0) {
            throw new Error(USAGE);
        }
        for (const target of positionals.map(parseMeasureTarget)) {
            const metrics = measureFigure(await readRaster(resolve(target.path)), target.xRange ? { xRange: target.xRange } : {});
            const how = metrics.method === 'head' ? 'head top to feet, ears left out' : 'whole box, the head could not be told from the ears';
            say(`${target.path}  box ${metrics.box.width} x ${metrics.boxHeight}  figure ${metrics.figureHeight} px (${how}); head top y ${metrics.headTop}, feet y ${metrics.feet}`);
        }
    } else {
        if (!values.layout || !values.out) {
            throw new Error(USAGE);
        }
        const outPath = resolve(values.out);
        // raw/<stage>/... names its own stage; anywhere else the caller says.
        const [top, folder] = relative(ROOT_DIR, outPath).split(sep);
        const stage = values.stage ?? (top === 'raw' ? folder : undefined);
        const result = await runComposeScene({
            rootDir: ROOT_DIR,
            layoutPath: resolve(values.layout),
            outPath,
            stage,
            overrides: parseOverrides(values.set),
            preview: values.preview,
            grid: values.grid,
            now: () => new Date(),
        });
        say(`${result.file}  ${result.size.width} x ${result.size.height}${result.grid ? ` art pixels (the layout's canvas / ${result.grid.cell})` : ''}${values.preview ? '  (preview, not logged)' : ''}`);
        for (const placement of result.placements) {
            if (result.grid) {
                const ratioNote = placement.ratio ? `; ${placement.ratio.actual} of ${placement.ratio.of} (wanted ${placement.ratio.wanted})` : '';
                say(`  ${placement.id}${result.placements.filter(({ id }) => id === placement.id).length > 1 ? ` #${placement.point + 1}` : ''}: ${placement.width} x ${placement.height} art px at ${placement.left},${placement.top}; ${placement.measure === 'figure' ? `figure ${placement.figureHeight} art px (${placement.method === 'head' ? 'head top to feet' : 'whole box'})` : `height ${placement.figureHeight} art px`}, layout wanted ${placement.targetHeight}${ratioNote}${placement.rings ? `; rings rim ${placement.rings.rimWidth} + band ${placement.rings.bandWidth}` : ''}`);
                continue;
            }
            const heightNote = placement.measure === 'figure' ? ` figure ${placement.targetHeight} px, ${placement.method === 'head' ? 'head top to feet' : 'whole box (head not found)'}` : ` height ${placement.targetHeight} px`;
            say(`  ${placement.id}${placement.point > 0 || result.placements.filter(({ id }) => id === placement.id).length > 1 ? ` #${placement.point + 1}` : ''}: ${placement.width} x ${placement.height} at ${placement.left},${placement.top}  scale ${placement.scale}${heightNote}`);
        }
        for (const [id, grade] of Object.entries(result.grades)) {
            say(`  ${id}: graded toward ${grade.toward} by ${grade.amount}, lightness ${grade.lightness}${grade.keepSticker ? ', sticker kept' : ', sticker graded too'}`);
        }
    }
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
