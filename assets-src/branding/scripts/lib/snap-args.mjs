import { parseArgs } from 'node:util';
import { SAMPLES } from './pixel-snap.mjs';

export const SNAP_USAGE = [
    'Usage:',
    '  snap.mjs --in <master.png> --stage s5 [--id name] [--character reisen|tewi] [--body-height N | --figure-height N | --cell N | --detect] [--sample median|mode] [--colours K]',
    '           [--rim #b99bf2] [--band #ffffff] [--rim-width N] [--band-width N] [--no-ring-repair] [--fixes <file.json>] [--out <png>] [--sheet <png>]',
    '           with none of the four sizes, the body height snap-config.json sets for the picture\'s character is used',
    '  snap.mjs --in <master.png> --preview [same options]    writes out/snap/<id>-preview.png and logs nothing',
    '  snap.mjs --batch snap-batch.json --stage s5 [--out-dir raw/s5/pixel-body] [--sheet-dir out/snap] [--dry-run]    every picture of the file, one after the other',
    '  snap.mjs --measure [--approved approved] [--only id,id] [--figure-height N] [--body-sheet <png>]    pitch, head top and feet of every approved master',
    '  snap.mjs --compare --in <master.png> [--colours K] [same size options] [--sheet <png>]    sampling and palette comparison',
].join('\n');

const OPTIONS = {
    in: { type: 'string' },
    id: { type: 'string' },
    cell: { type: 'string' },
    'figure-height': { type: 'string' },
    'body-height': { type: 'string' },
    character: { type: 'string' },
    detect: { type: 'boolean', default: false },
    batch: { type: 'string' },
    'out-dir': { type: 'string' },
    'sheet-dir': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'body-sheet': { type: 'string' },
    sample: { type: 'string', default: 'median' },
    colours: { type: 'string' },
    rim: { type: 'string' },
    band: { type: 'string' },
    'rim-width': { type: 'string' },
    'band-width': { type: 'string' },
    'no-ring-repair': { type: 'boolean', default: false },
    fixes: { type: 'string' },
    out: { type: 'string' },
    stage: { type: 'string' },
    sheet: { type: 'string' },
    preview: { type: 'boolean', default: false },
    measure: { type: 'boolean', default: false },
    compare: { type: 'boolean', default: false },
    approved: { type: 'string', default: 'approved' },
    only: { type: 'string' },
};

const number = (value, flag, test, expectation) => {
    if (value === undefined) {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !test(parsed)) {
        throw new Error(`${flag} must be ${expectation}, got "${value}".`);
    }
    return parsed;
};

/**
 * Turns snap.mjs argv into a trusted request. Anything wrong fails here, before a file is read.
 * @param {string[]} argv
 */
export function parseSnapArgs(argv) {
    const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
    const modes = ['measure', 'compare'].filter((mode) => values[mode]);
    if (modes.length > 1) {
        throw new Error('Pass --measure or --compare, not both.');
    }
    if (!SAMPLES.includes(values.sample)) {
        throw new Error(`--sample must be one of ${SAMPLES.join(', ')}, got "${values.sample}".`);
    }
    const cell = number(values.cell, '--cell', (value) => value > 1, 'a number above 1 (master pixels per art pixel)');
    const figureHeight = number(values['figure-height'], '--figure-height', (value) => value >= 8, 'a number of 8 or more (art pixels)');
    const bodyHeight = number(values['body-height'], '--body-height', (value) => value >= 8, 'a number of 8 or more (art pixels, head top to feet)');
    const sizes = [['--cell', cell], ['--figure-height', figureHeight], ['--body-height', bodyHeight], ['--detect', values.detect || undefined]].filter(([, given]) => given !== undefined);
    if (sizes.length > 1) {
        throw new Error(`Pass one of --cell, --figure-height, --body-height and --detect, not ${sizes.map(([flag]) => flag).join(' and ')}.`);
    }
    const colours = number(values.colours, '--colours', (value) => Number.isInteger(value) && value >= 2, 'a whole number of 2 or more');
    const rimWidth = number(values['rim-width'], '--rim-width', (value) => Number.isInteger(value) && value >= 1, 'a whole number of 1 or more (art pixels)');
    const bandWidth = number(values['band-width'], '--band-width', (value) => Number.isInteger(value) && value >= 1, 'a whole number of 1 or more (art pixels)');
    const ringRepair = !values['no-ring-repair'];
    if (!ringRepair && [values.rim, values.band, rimWidth, bandWidth].some((value) => value !== undefined)) {
        throw new Error('--no-ring-repair builds no rings, so --rim, --band, --rim-width and --band-width have no effect.');
    }
    const options = {
        cell,
        figureHeight,
        bodyHeight,
        sample: values.sample,
        colours,
        ringRepair,
        ...(values.rim === undefined ? {} : { rim: values.rim }),
        ...(values.band === undefined ? {} : { band: values.band }),
        rimWidth,
        bandWidth,
    };
    if (values.measure) {
        return { mode: 'measure', approved: values.approved, only: values.only?.split(',').map((id) => id.trim()).filter(Boolean), figureHeight, bodySheet: values['body-sheet'] };
    }
    if (values.batch) {
        if (values.in || sizes.length > 0 || values.id || values.fixes || values.out || values.sheet || values.character) {
            throw new Error('--batch takes its pictures and their sizes from the batch file; pass only --stage, --out-dir, --sheet-dir, --sample and --dry-run with it.');
        }
        if (!values['dry-run'] && !values.stage) {
            throw new Error('Pass --stage (such as s5) for a batch that is logged, or --dry-run.');
        }
        return { mode: 'batch', batchPath: values.batch, stage: values.stage, outDir: values['out-dir'], sheetDir: values['sheet-dir'], dryRun: values['dry-run'], sample: values.sample === 'median' ? undefined : values.sample };
    }
    if (!values.in) {
        throw new Error(`Pass --in <master.png>.\n${SNAP_USAGE}`);
    }
    if (values.compare) {
        return { mode: 'compare', inPath: values.in, id: values.id, options, character: values.character, detect: values.detect, sheetPath: values.sheet };
    }
    if (values.preview && values.stage) {
        throw new Error('--preview logs nothing, so it takes no --stage. Drop one of them.');
    }
    return { mode: 'snap', inPath: values.in, id: values.id, options, character: values.character, detect: values.detect, fixesPath: values.fixes, outPath: values.out, stage: values.stage, preview: values.preview, sheetPath: values.sheet };
}
