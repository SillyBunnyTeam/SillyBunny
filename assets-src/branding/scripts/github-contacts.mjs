#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadArt } from './lib/github-art.mjs';
import { proposeContacts } from './lib/github-contact.mjs';
import { rulerCrop } from './lib/github-contact-ruler.mjs';
import { loadGithubConfig, resolveGithubOutDir } from './lib/github-run.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `Usage: node scripts/github-contacts.mjs [--scene <art name>]... [--rows 150] [--zoom 5] [--out-dir out/github]

Helps to place the contacts of github-config.json by eye. For each scene it prints the runs that the lowest pixels suggest (contact, and
raised for parts that end higher) and writes a ruler crop of the bottom of the scene to <out-dir>/contacts/<scene>.png, with a line and
a number every 10 art pixels. Detection cannot tell a foot on the ground from one in the air: the contacts in the config are the
answer, and this only proposes.
`;
const say = (line) => process.stdout.write(`${line}\n`);

function positiveWhole(text, flag) {
    const number = Number(text);
    if (!/^\d+$/.test(text) || number < 1) {
        throw new Error(`${flag} must be a whole number of 1 or more, got "${text}".`);
    }
    return number;
}

async function main() {
    const { values } = parseArgs({
        options: {
            scene: { type: 'string', multiple: true },
            rows: { type: 'string', default: '150' },
            zoom: { type: 'string', default: '5' },
            'out-dir': { type: 'string', default: 'out/github' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    if (values.help) {
        process.stdout.write(USAGE);
        return;
    }
    const rows = positiveWhole(values.rows, '--rows');
    const zoom = positiveWhole(values.zoom, '--zoom');
    const config = loadGithubConfig(rootDir);
    const names = values.scene ?? Object.keys(config.sources.art);
    for (const name of names) {
        if (!Object.hasOwn(config.sources.art, name)) {
            throw new Error(`"${name}" is not an art source. The art sources are: ${Object.keys(config.sources.art).join(', ')}.`);
        }
    }
    const outDir = join(resolveGithubOutDir(rootDir, values['out-dir']), 'contacts');
    mkdirSync(outDir, { recursive: true });
    for (const name of names) {
        const art = await loadArt(join(rootDir, config.sources.art[name]));
        say(`${name} (${art.width}x${art.height} art pixels)`);
        for (const { kind, x0, x1, y } of proposeContacts(art)) {
            say(`  ${kind.padEnd(8)} x0 ${String(x0).padStart(3)}  x1 ${String(x1).padStart(3)}  y ${y}`);
        }
        const path = join(outDir, `${name}.png`);
        writeFileSync(path, await rulerCrop(art, { rows, zoom }));
        say(`  ruler: ${path}`);
    }
}

try {
    await main();
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
}
