#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { parseExportSpec } from './lib/export-art.mjs';
import { exportAssets, variantLines } from './lib/export-run.mjs';
import { renderExportSheets } from './lib/export-sheets.mjs';

const USAGE = 'Usage: export-art.mjs --spec <export-specs/art.json> [--out-dir out/export] [--only id,id] [--sheets]';
const say = (line) => process.stdout.write(`${line}\n`);
const kilobytes = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

try {
    const { values } = parseArgs({
        options: {
            spec: { type: 'string' },
            'out-dir': { type: 'string', default: join('out', 'export') },
            only: { type: 'string' },
            sheets: { type: 'boolean', default: false },
        },
    });
    if (!values.spec) {
        throw new Error(USAGE);
    }
    const spec = parseExportSpec(JSON.parse(readFileSync(resolve(values.spec), 'utf8')));
    const only = values.only?.split(',').map((id) => id.trim()).filter(Boolean);
    const { assets, outDir } = await exportAssets({ rootDir: ROOT_DIR, spec, outDir: values['out-dir'], only });

    for (const asset of assets) {
        const { totals, mode, quality } = asset.encoding;
        const totalText = Object.entries(totals).map(([name, bytes]) => `${name} ${kilobytes(bytes)}`).join(', ');
        say(`${asset.id}  frame ${asset.frame.width}x${asset.frame.height} from ${asset.master}  stored ${mode}${quality ? ` q${quality}` : ''}  (all sizes together: ${totalText})`);
        for (const variant of asset.variants) {
            const others = Object.entries(variant.candidates)
                .map(([name, figures]) => `${name} ${kilobytes(figures.bytes)}${figures.mean === 0 ? '' : ` dE ${figures.mean.toFixed(2)}/${figures.p99.toFixed(2)}${figures.passes ? '' : ' over'}`}`)
                .join('  ');
            say(`  ${variantLines(asset, variant)[0].padEnd(34)} ${String(variant.width).padStart(3)}x${String(variant.height).padEnd(3)} ${kilobytes(variant.bytes).padStart(9)}   ${others}`);
        }
    }
    say(join(outDir, 'manifest.json'));
    if (values.sheets) {
        for (const path of await renderExportSheets(assets, outDir)) {
            say(path);
        }
    }
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
