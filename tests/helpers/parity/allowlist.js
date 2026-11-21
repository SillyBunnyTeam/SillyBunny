/** Reads and writes the allow-list of the parity tool and its ratchet counts. */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ALLOWLIST_PATH = fileURLToPath(new URL('../../fixtures/parity-allowlist.json', import.meta.url));
export const RATCHET_PATH = fileURLToPath(new URL('../../fixtures/parity-allowlist-counts.json', import.meta.url));

export const FILE_VERSION = 1;

/**
 * @param {string} [file] `SB_PARITY_ALLOWLIST` when set, else the fixture.
 * @returns {{ version: number, entries: any[] }}
 */
export function readAllowlist(file = process.env.SB_PARITY_ALLOWLIST || ALLOWLIST_PATH) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== FILE_VERSION || !Array.isArray(parsed.entries)) {
        throw new Error(`${file} must be { "version": ${FILE_VERSION}, "entries": [...] }.`);
    }
    return parsed;
}

/**
 * @param {any[]} entries Sorted entries.
 * @param {string} [file]
 */
export function writeAllowlist(entries, file = ALLOWLIST_PATH) {
    // One entry to a line, so that a change to the list is a readable diff.
    const lines = entries.map(entry => `        ${JSON.stringify(entry)}`).join(',\n');
    fs.writeFileSync(file, `{\n    "version": ${FILE_VERSION},\n    "entries": [${entries.length ? `\n${lines}\n    ` : ''}]\n}\n`);
}

/**
 * @param {string} [file]
 * @returns {{ version: number, temporary: Record<string, number> } | null} Null when there is no ratchet file yet.
 */
export function readRatchet(file = RATCHET_PATH) {
    if (!fs.existsSync(file)) {
        return null;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== FILE_VERSION || !parsed.temporary || typeof parsed.temporary !== 'object') {
        throw new Error(`${file} must be { "version": ${FILE_VERSION}, "temporary": { "<family>": <count> } }.`);
    }
    return parsed;
}

/**
 * @param {Record<string, number>} temporary
 * @param {string} [file]
 */
export function writeRatchet(temporary, file = RATCHET_PATH) {
    fs.writeFileSync(file, `${JSON.stringify({ version: FILE_VERSION, temporary }, null, 4)}\n`);
}
