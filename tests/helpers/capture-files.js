/**
 * The files of a capture run: what each test writes when it ends, and the summary that the last test (or
 * `audit/capture-summary.js`) writes from them. Plain `node:fs`, no Playwright.
 *
 * Layout of the capture directory (`SB_CAPTURE_DIR`):
 *   captures/<name>.png   every capture of the run
 *   diffs/<name>.png      the diff image of a changed capture; actual and baseline are the files named in the summary
 *   captures/<name>.json  what the capture measured (roots, masks, scroller), next to its png
 *   .results/<key>.json   one fragment per test, written when it ends
 *   .run.json             who started the run (see `startRun`)
 *   summary.json, summary.md
 *
 * Layout of the baseline directory (`SB_VISUAL_BASELINE_DIR`): `baseline.json` (what it was recorded with) and, next to each
 * baseline png, the same sidecar `<name>.json` that a capture has.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildSummary, captureMode, isSameRun, renderSummary, selectCaptures, selectPages } from './capture-plan.js';

const CAPTURES = 'captures';
const DIFFS = 'diffs';
const RESULTS = '.results';
const SUMMARY_FILES = ['summary.json', 'summary.md'];
const RUN_MARKER = '.run.json';
const STAMP = 'baseline.json';

export const capturesPath = dir => path.join(dir, CAPTURES);
export const diffsPath = dir => path.join(dir, DIFFS);

/** Writes a file so that a reader never sees half of it: to a name of its own, then a rename. */
export function writeFileAtomic(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, file);
}

/**
 * Removes what an earlier run left in the capture directory (its captures, diffs, fragments and summary), and nothing else.
 * @param {string} dir
 */
export function cleanRunFiles(dir) {
    for (const name of [CAPTURES, DIFFS, RESULTS]) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
    for (const name of SUMMARY_FILES) {
        fs.rmSync(path.join(dir, name), { force: true });
    }
}

/** The sidecar of a capture or baseline png: what was measured when it was taken. */
export const sidecarPath = pngPath => pngPath.replace(/\.png$/, '.json');

/** @param {string} pngPath @param {object} data */
export function writeSidecar(pngPath, data) {
    writeFileAtomic(sidecarPath(pngPath), JSON.stringify(data));
}

/** @param {string} pngPath @returns {any | null} */
export function readSidecar(pngPath) {
    try {
        return JSON.parse(fs.readFileSync(sidecarPath(pngPath), 'utf8'));
    } catch {
        return null;
    }
}

/** A short fingerprint of the files that make the captures: a baseline and a run that differ in it were not made by the same tools. */
export function toolsFingerprint(files) {
    const hash = createHash('sha1');
    for (const file of [...files].sort()) {
        hash.update(path.basename(file));
        hash.update(fs.existsSync(file) ? fs.readFileSync(file) : '');
    }
    return hash.digest('hex').slice(0, 12);
}

const readJson = (file) => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
};

/** `baseline.json` of a baseline directory, or null. */
export const readBaselineStamp = baselineDir => (baselineDir ? readJson(path.join(baselineDir, STAMP)) : null);

/** Whether a directory, or a directory in it, holds a capture png. */
export function holdsCaptures(dir) {
    if (!dir || !fs.existsSync(dir)) {
        return false;
    }
    return fs.readdirSync(dir, { withFileTypes: true }).some(entry => (entry.isDirectory()
        ? fs.readdirSync(path.join(dir, entry.name)).some(name => name.endsWith('.png'))
        : entry.name.endsWith('.png')));
}

/** Removes the captures and sidecars of a baseline directory and its stamp, and nothing else. */
function clearBaseline(dir) {
    fs.rmSync(path.join(dir, STAMP), { force: true });
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const folder = entry.isDirectory() ? path.join(dir, entry.name) : null;
        for (const name of folder ? fs.readdirSync(folder) : []) {
            if (name.endsWith('.png') || name.endsWith('.json')) {
                fs.rmSync(path.join(folder, name), { force: true });
            }
        }
        if (!folder && (entry.name.endsWith('.png'))) {
            fs.rmSync(path.join(dir, entry.name), { force: true });
        }
    }
}

const gitHead = () => {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null;
    }
};

/**
 * What a run does once, before its tests: clears the files of an earlier run in the capture directory, and, when it records,
 * refuses a baseline directory that already holds captures (unless `SB_VISUAL_RECORD=replace`) and writes `baseline.json`.
 * Only the process that the runner starts calls this, and never for `--list`. A shard of the same run (the same parent
 * process, and no summary yet) leaves everything alone, so that it does not delete what another shard has captured.
 * @param {{ env?: Record<string, string | undefined>, ppid?: number, list?: boolean, tools?: string, now?: Date }} input
 * @returns {{ problem: string | null }}
 */
export function startRun({ env = process.env, ppid = process.ppid, list = process.argv.includes('--list'), tools, now = new Date() }) {
    if (list) {
        return { problem: null };
    }
    const dir = env.SB_CAPTURE_DIR?.trim() || null;
    const marker = dir ? readJson(path.join(dir, RUN_MARKER)) : null;
    if (isSameRun(marker, ppid, dir ? fs.existsSync(path.join(dir, 'summary.json')) : false)) {
        return { problem: null };
    }
    const mode = captureMode(env);
    if (mode.mode === 'record' && !mode.replace && holdsCaptures(mode.baselineDir)) {
        return { problem: `${mode.baselineDir} already holds captures. Recording would replace the before set; set SB_VISUAL_RECORD=replace if that is what you want.` };
    }
    if (dir) {
        cleanRunFiles(dir);
        writeFileAtomic(path.join(dir, RUN_MARKER), JSON.stringify({ ppid, startedAt: now.toISOString() }));
    }
    if (mode.mode === 'record') {
        fs.mkdirSync(mode.baselineDir, { recursive: true });
        if (mode.replace) {
            clearBaseline(mode.baselineDir);
        }
        const selection = selectCaptures(env);
        const listOf = key => String(env[key] ?? '').split(',').map(item => item.trim()).filter(Boolean);
        writeFileAtomic(path.join(mode.baselineDir, STAMP), `${JSON.stringify({
            commit: gitHead(),
            tools,
            set: selection.set,
            pages: selectPages(env).maxPages,
            selection: { families: listOf('SURFACE_FAMILY'), surfaceIds: listOf('SURFACE_ID'), viewports: selection.viewports, variants: selection.variants },
            date: now.toISOString(),
        }, null, 2)}\n`);
    }
    return { problem: null };
}

/**
 * @param {string} dir
 * @param {import('./capture-plan.js').Fragment & { baselineFilesDir?: string | null }} fragment
 */
export function writeFragment(dir, fragment) {
    writeFileAtomic(path.join(dir, RESULTS, `${fragment.key}.json`), JSON.stringify(fragment));
}

/**
 * @param {string} dir
 * @returns {(import('./capture-plan.js').Fragment & { baselineFilesDir?: string | null })[]}
 */
export function readFragments(dir) {
    const directory = path.join(dir, RESULTS);
    if (!fs.existsSync(directory)) {
        return [];
    }
    return fs.readdirSync(directory)
        .filter(name => name.endsWith('.json'))
        .sort()
        .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
}

/** The capture file names in a baseline directory; none when it does not exist yet. */
export function listBaselineNames(baselineFilesDir) {
    return baselineFilesDir && fs.existsSync(baselineFilesDir)
        ? fs.readdirSync(baselineFilesDir).filter(name => name.endsWith('.png')).sort()
        : [];
}

/**
 * Writes `summary.json` and `summary.md` from the fragments in the capture directory.
 * @param {{ dir: string, env?: Record<string, string | undefined>, planned?: readonly string[] }} input
 * @returns {ReturnType<typeof buildSummary>}
 */
export function writeSummary({ dir, env = process.env, planned = [] }) {
    const fragments = readFragments(dir);
    const { mode, baselineDir } = captureMode(env);
    const selection = selectCaptures(env);
    const baselineFilesDir = fragments.find(fragment => fragment.baselineFilesDir)?.baselineFilesDir ?? null;
    const families = String(env.SURFACE_FAMILY ?? '').split(',').map(item => item.trim()).filter(Boolean);
    const surfaceIds = String(env.SURFACE_ID ?? '').split(',').map(item => item.trim()).filter(Boolean);
    const summary = buildSummary({
        mode,
        fragments,
        planned,
        baselineDir,
        selection: { set: selection.set, viewports: selection.viewports, variants: selection.variants, families, surfaceIds },
        baselineNames: mode === 'compare' ? listBaselineNames(baselineFilesDir) : null,
        scope: { families, surfaceIds, viewports: selection.viewports, variants: selection.variants, maxPages: selectPages(env).maxPages },
        stamp: mode === 'compare' ? readBaselineStamp(baselineDir) : undefined,
    });
    writeFileAtomic(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileAtomic(path.join(dir, 'summary.md'), renderSummary(summary));
    return summary;
}

/**
 * Writes the summary when every planned test has left its fragment, which the test that ends last finds. Returns
 * whether it wrote. A run that is cut short (a crashed worker) leaves no summary; `audit/capture-summary.js` writes it then.
 * @param {{ dir: string, env?: Record<string, string | undefined>, planned: readonly string[] }} input
 */
export function writeSummaryWhenComplete({ dir, env = process.env, planned }) {
    const have = new Set(readFragments(dir).map(fragment => fragment.key));
    if (!planned.every(key => have.has(key))) {
        return false;
    }
    writeSummary({ dir, env, planned });
    return true;
}
