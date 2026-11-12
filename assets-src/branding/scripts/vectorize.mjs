#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { CENTRINGS, SEGMENT_LENGTH, runVectorize } from './lib/vectorize-run.mjs';

const USAGE = 'Usage: vectorize.mjs --in <approved logo master.png> [--out-dir raw/s4/logo-vector] [--sheet out/s4/logo-vector.png] [--base #8b64aa] [--centre both|base|bbox] [--segment-length 8] [--k-dark px] [--k-light px] [--preview]';
const PREVIEW_NOTE = 'preview: written under out/ only, nothing logged';
const say = (line) => process.stdout.write(`${line}\n`);
const percent = (share) => `${(share * 100).toFixed(1)}%`;

try {
    const { values } = parseArgs({
        options: {
            in: { type: 'string' },
            'out-dir': { type: 'string', default: 'raw/s4/logo-vector' },
            sheet: { type: 'string', default: 'out/s4/logo-vector.png' },
            base: { type: 'string', default: '#8b64aa' },
            centre: { type: 'string', default: 'both' },
            'segment-length': { type: 'string', default: String(SEGMENT_LENGTH) },
            'k-dark': { type: 'string' },
            'k-light': { type: 'string' },
            preview: { type: 'boolean', default: false },
        },
    });
    if (!values.in) {
        throw new Error(USAGE);
    }
    const centrings = values.centre === 'both' ? CENTRINGS : [values.centre];
    if (!centrings.every((centring) => CENTRINGS.includes(centring))) {
        throw new Error(`--centre must be both, base or bbox, got "${values.centre}". ${USAGE}`);
    }
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
    const result = await runVectorize({
        rootDir: ROOT_DIR,
        inPath: resolve(values.in),
        outDir: resolve(values['out-dir']),
        sheetPath: resolve(values.sheet),
        baseHex: values.base,
        centrings,
        segmentLength,
        kDark: band('k-dark'),
        kLight: band('k-light'),
        preview: values.preview,
        now: () => new Date(),
    });
    say('tones found (most used first):');
    for (const tone of result.found) {
        say(`  ${tone.hex}  ${percent(tone.share)}`);
    }
    say(`tones used: ${result.tones.map((tone) => tone.hex).join(' ')}  (the one nearest ${values.base} is set to exactly that)`);
    const { box, base, centres } = result;
    say(`emblem box x ${box.x}..${box.x + box.width} (centre ${centres.box.toFixed(1)}), y ${box.y}..${box.y + box.height}; SB dome centre ${centres.dome.toFixed(1)} (x ${base.left}..${base.right}); centre of mass ${centres.mass.toFixed(1)}; canvas centre ${centres.canvas}`);
    say(`the box centre is ${Math.abs(centres.gap).toFixed(1)} px ${centres.gap >= 0 ? 'right' : 'left'} of the dome centre: ${percent(centres.gapShareOfBox)} of the box width, ${percent(centres.gapShareOfCanvas)} of the canvas width`);
    say(`trace against the snapped picture: ${percent(result.check.wrongShape)} of the shape differs, ${percent(result.check.wrongTone)} has another tone (edge pixels)`);
    const { lines } = result;
    const { existingShading } = lines;
    say(`existing shading (px): dome dark lower band ${existingShading.domeDark}, dome light top band ${existingShading.domeLight}, tall ear light edge ${existingShading.earLight.toFixed(1)} (across the edge)`);
    say(`lines and dots: ${lines.parts} pieces found outside the ears and dome (thin width ${result.thinWidth} px); lines are ${lines.thickness} px thick; bands: dark ${lines.bands.dark} px, light ${lines.bands.light} px`);
    for (const file of result.files) {
        say(`${file.file}  ${file.side} x ${file.side}  ${file.bytes} bytes, ${file.gzipBytes} gzipped  (${file.label})`);
    }
    say(`pixel drafts: ears and dome only (anything thinner than ${result.thinWidth} px dropped), centred on the dome, reduced by area coverage`);
    if (values.preview) {
        say(PREVIEW_NOTE);
    }
    say(result.sheet);
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
