import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One set for the whole process, found by a global key, so the bun preload and every test file add to and empty the same one.
const KEY = Symbol.for('sillybunny.branding.tempDirs');
const made = (globalThis[KEY] ??= new Set());

/**
 * Removes every folder `tempDir` made. node runs it when the test process ends, which it does whether the tests passed, failed or threw;
 * bun never emits `exit` under `bun test`, so test-support/bun-preload.mjs (named in bunfig.toml) runs it after the last test instead.
 */
export function removeTempDirs() {
    for (const directory of made) {
        rmSync(directory, { recursive: true, force: true });
    }
    made.clear();
}

process.on('exit', removeTempDirs);

/**
 * A new folder under the system temp folder, removed when the test run ends. A test makes its scratch folders with this and never
 * with `mkdtempSync` directly, so a run leaves nothing behind, even a run with failures.
 * @param {string} prefix the start of the folder's name, such as `sb-run-`
 * @returns {string} the folder's absolute path
 */
export function tempDir(prefix) {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    made.add(directory);
    return directory;
}
