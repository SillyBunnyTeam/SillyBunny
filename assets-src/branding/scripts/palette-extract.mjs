#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { paletteToGpl, paletteToHex, proposePalette, renderPalettePreview } from './lib/palette-extract.mjs';
import { readRaster, writeRaster } from './lib/raster.mjs';

const USAGE = 'Usage: palette-extract.mjs --in <approved sheet.png> --name <character> [--colours 28] [--out-dir out/palettes]';

try {
    const { values } = parseArgs({
        options: {
            in: { type: 'string' },
            name: { type: 'string' },
            colours: { type: 'string', default: '28' },
            'out-dir': { type: 'string', default: join('out', 'palettes') },
        },
    });
    if (!values.in || !values.name) {
        throw new Error(USAGE);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(values.name)) {
        throw new Error('--name must be lowercase letters, digits and hyphens, such as reisen.');
    }
    const proposal = proposePalette(await readRaster(resolve(values.in)), { colours: Number(values.colours) });
    const outDir = resolve(values['out-dir']);
    mkdirSync(outDir, { recursive: true });
    const stem = join(outDir, `${values.name}-draft`);
    writeFileSync(`${stem}.hex`, paletteToHex(proposal.colours));
    writeFileSync(`${stem}.gpl`, paletteToGpl(`${values.name}-draft`, proposal.colours));
    await writeRaster(`${stem}.preview.png`, renderPalettePreview(proposal, { swatch: 24, gap: 6 }));

    const say = (line) => process.stdout.write(`${line}\n`);
    say(`${stem}.hex  ${stem}.gpl  ${stem}.preview.png`);
    say(`${proposal.colours.length} colours from ${basename(values.in, extname(values.in))}: ${proposal.families.length} families (shadow, base, highlight, some with a deep shade) plus white and the sticker rim`);
    for (const { hex, role } of proposal.colours) {
        say(`  ${hex}  ${role}`);
    }
    for (const warning of proposal.warnings) {
        say(`WARNING: ${warning}`);
    }
    say('This is a DRAFT. Review the preview with the user, then copy the .hex to palettes/<name>.hex to lock it.');
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
