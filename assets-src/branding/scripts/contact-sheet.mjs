#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildContactSheet } from './lib/contact-sheet.mjs';

const USAGE = 'Usage: contact-sheet.mjs [--out out/contact-sheet.png] [--cols 4] [--cell 384] [--cell-width N] [--cell-height N] [--gap 12] [--label-height 28] [--labels a,b,c] [--nearest] [--scales 1,4] <image> [<image> ...]';

try {
    const { values, positionals } = parseArgs({
        options: {
            out: { type: 'string', default: 'out/contact-sheet.png' },
            cols: { type: 'string' },
            cell: { type: 'string', default: '384' },
            'cell-width': { type: 'string' },
            'cell-height': { type: 'string' },
            gap: { type: 'string', default: '12' },
            'label-height': { type: 'string', default: '28' },
            labels: { type: 'string' },
            nearest: { type: 'boolean', default: false },
            scales: { type: 'string' },
        },
        allowPositionals: true,
    });
    if (positionals.length === 0) {
        throw new Error(USAGE);
    }
    const labels = values.labels?.split(',') ?? [];
    const items = positionals.map((path, index) => ({
        path: resolve(path),
        label: labels[index] ?? basename(path, extname(path)).replace(/^\d{8}T\d{6}Z-/, ''),
    }));
    const numeric = (name) => {
        const value = Number(values[name]);
        if (!Number.isInteger(value) || value < 0) {
            throw new Error(`--${name} must be a whole number.`);
        }
        return value;
    };
    const scales = values.scales?.split(',').map(Number);
    const sheet = await buildContactSheet(items, {
        scales,
        // With scales, one row per image is the natural shape: each image beside its enlargements.
        cols: Math.max(1, values.cols === undefined ? (scales?.length ?? 4) : numeric('cols')),
        cellWidth: Math.max(16, numeric(values['cell-width'] ? 'cell-width' : 'cell')),
        cellHeight: Math.max(16, numeric(values['cell-height'] ? 'cell-height' : 'cell')),
        gap: numeric('gap'),
        labelHeight: numeric('label-height'),
        nearest: values.nearest,
    });
    const out = resolve(values.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, sheet);
    process.stdout.write(`${out}\n`);
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
