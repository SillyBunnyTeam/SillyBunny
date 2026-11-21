#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANIFEST_FILE_NAME, buildManifest, readManifest } from '../src/sillybunny-managed-content.js';

const ITEM_TYPES = ['character', 'sprites', 'world'];
const USAGE = `Usage: node scripts/build-managed-manifest.js <bundled directory> [<type>:<filename>...]
  type is one of ${ITEM_TYPES.join(', ')}; filename is a card or world file, or a sprite folder, inside the directory.
  Items that are already in the manifest stay in it. Run it again after the bundled files change.`;

/**
 * @param {string[]} argv
 * @returns {{ bundledDirectory: string, entries: { type: string, filename: string }[] }}
 */
export function parseArguments(argv) {
    const [bundledDirectory, ...items] = argv;
    if (!bundledDirectory) {
        throw new Error(USAGE);
    }
    const entries = items.map((item) => {
        const separator = item.indexOf(':');
        const type = item.slice(0, separator);
        if (separator < 1 || !ITEM_TYPES.includes(type)) {
            throw new Error(`"${item}" is not <type>:<filename> with a type of ${ITEM_TYPES.join(', ')}.\n${USAGE}`);
        }
        return { type, filename: item.slice(separator + 1) };
    });
    return { bundledDirectory, entries };
}

/**
 * Writes the manifest of a bundled directory: the items already in it and the given ones, fingerprinted. The file is
 * left alone when its content would not change.
 * @param {{ bundledDirectory: string, entries: { type: string, filename: string }[] }} options
 * @returns {{ changed: boolean, manifestPath: string }}
 */
export function updateManagedManifest({ bundledDirectory, entries }) {
    const manifestPath = path.join(bundledDirectory, MANIFEST_FILE_NAME);
    const existingText = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : null;
    const previous = existingText === null ? null : readManifest(bundledDirectory);
    const listed = (previous?.items ?? []).map(({ filename, type }) => ({ filename, type }));
    const added = entries.filter(entry => !listed.some(item => item.filename === entry.filename));
    const items = [...listed, ...added];
    if (items.length === 0) {
        throw new Error(`No items are listed and there is no ${MANIFEST_FILE_NAME} to take them from.\n${USAGE}`);
    }
    const text = `${JSON.stringify(buildManifest({ bundledDirectory, entries: items, previous }), null, 4)}\n`;
    if (text === existingText) {
        return { changed: false, manifestPath };
    }
    fs.writeFileSync(manifestPath, text);
    return { changed: true, manifestPath };
}

function isDirectRun() {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
    try {
        const { changed, manifestPath } = updateManagedManifest(parseArguments(process.argv.slice(2)));
        console.log(changed ? `Wrote ${manifestPath}` : `${manifestPath} is up to date`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
