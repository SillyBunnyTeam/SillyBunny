#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { runLogoPlates } from './lib/logo-plates-run.mjs';
import { SEGMENT_LENGTH } from './lib/vectorize-run.mjs';

const USAGE = 'Usage: logo-plates.mjs --in <approved logo master.png> [--out-dir raw/s4/logo-plates] [--sheet out/s4/logo-plates.png] [--shape squircle|circle] [--colour light|dark] [--base #8b64aa] [--segment-length 8] [--k-dark px] [--k-light px] [--preview]';
const say = (line) => process.stdout.write(`${line}\n`);
const percent = (share) => `${(share * 100).toFixed(1)}%`;

try {
    const { values } = parseArgs({
        options: {
            in: { type: 'string' },
            'out-dir': { type: 'string', default: 'raw/s4/logo-plates' },
            sheet: { type: 'string' },
            shape: { type: 'string' },
            colour: { type: 'string' },
            base: { type: 'string', default: '#8b64aa' },
            'segment-length': { type: 'string', default: String(SEGMENT_LENGTH) },
            'k-dark': { type: 'string' },
            'k-light': { type: 'string' },
            preview: { type: 'boolean', default: false },
        },
    });
    if (!values.in) {
        throw new Error(USAGE);
    }
    // A run for one chosen plate has nothing to compare, so it writes a contact sheet only when asked to.
    const sheetPath = values.sheet ?? (values.shape && values.colour ? undefined : 'out/s4/logo-plates.png');
    const segmentLength = Number(values['segment-length']);
    // vtracer accepts 3.5 to 10 and panics outside it, so the range is checked here with a message.
    if (!Number.isFinite(segmentLength) || segmentLength < 3.5 || segmentLength > 10) {
        throw new Error(`--segment-length must be from 3.5 to 10, got "${values['segment-length']}".`);
    }
    const band = (name) => {
        const text = values[name];
        if (text === undefined) {
            return undefined;
        }
        const value = Number(text);
        if (!Number.isInteger(value) || value < 1) {
            throw new Error(`--${name} must be a whole number of pixels, 1 or more, got "${text}".`);
        }
        return value;
    };
    const result = await runLogoPlates({
        rootDir: ROOT_DIR,
        inPath: resolve(values.in),
        outDir: resolve(values['out-dir']),
        sheetPath: sheetPath && resolve(sheetPath),
        shape: values.shape,
        colour: values.colour,
        baseHex: values.base,
        segmentLength,
        kDark: band('k-dark'),
        kLight: band('k-light'),
        preview: values.preview,
        now: () => new Date(),
    });
    say(`tones used: ${result.tones.map((tone) => tone.hex).join(' ')}`);
    say(`ears and dome traced: ${percent(result.bodyCheck.wrongShape)} of the shape differs by more than a pixel`);
    say(`lines: ${result.fits.length} found; one width ${result.lineWidth} px (measured ${result.fits.map((fit) => fit.measured.widths.join('/')).join(', ')}), dots r ${result.dotRadius.toFixed(2)} px; bands dark ${result.bands.dark} px, light ${result.bands.light} px`);
    result.fits.forEach((fit, at) => {
        const { deviation } = fit;
        say(`  line ${at + 1} (${fit.towards === 1 ? 'dot at the left' : 'dot at the right'}): dot centre moved ${deviation.dot.moved.toFixed(2)} px, radius ${deviation.dot.radiusChange >= 0 ? '+' : ''}${deviation.dot.radiusChange.toFixed(2)} px, circle fit rms ${deviation.dot.rms.toFixed(2)}; furthest any pixel of the redraw is from the picture: ${deviation.moved} px; ${percent(deviation.differentShare)} of the area differs`);
    });
    say(`plate colours: L ${result.colours.L.plate} (lip ${result.colours.L.lip}), D ${result.colours.D.plate} (lip ${result.colours.D.lip})`);
    for (const [id, placed] of Object.entries(result.placements)) {
        say(`emblem scale on ${id}: ${placed.withoutLines.scale.toFixed(4)} without lines, ${placed.withLines.scale.toFixed(4)} with lines`);
    }
    for (const file of result.files) {
        say(`${file.file}  ${file.bytes} bytes, ${file.gzipBytes} gzipped`);
    }
    if (values.preview) {
        say('preview: written under out/ only, nothing logged');
    }
    if (result.sheet) {
        say(result.sheet);
    }
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
