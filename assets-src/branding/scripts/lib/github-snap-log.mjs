import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendLogEntry, makeLogEntry, readLog, sha256 } from './log.mjs';
import { resolveOutDir } from './run.mjs';

const NAME = /^[\w-]+$/;

/**
 * A snapped picture that a run can write and log. `master` is the package-relative path of the generated picture it was snapped from,
 * and `patch` that of the picture that was patched into the master, when one was.
 * @typedef {{ id: string, png: Buffer, size: { width: number, height: number }, vars: object, master: string, patch?: string }} LoggedSnap
 */

/** A stage is a string: `RegExp.test` would turn `undefined`, `null` or `8` into a text that passes. @param {unknown} stage */
export function assertStage(stage) {
    if (typeof stage !== 'string' || !NAME.test(stage)) {
        throw new Error(`The stage "${stage}" may hold letters, digits, "_" and "-" only (such as s8).`);
    }
}

/** The sha256 of a picture that the log recorded as an output, or the reason it cannot be a reference. */
function loggedReference({ rootDir, entries, file }) {
    const path = join(rootDir, file);
    if (!existsSync(path)) {
        return { problem: `${file} is missing, so the snap cannot name the picture it comes from.` };
    }
    const hash = sha256(readFileSync(path));
    const isLogged = entries.some((entry) => entry.outputs?.some((output) => output.file === file && output.sha256 === hash));
    return isLogged ? { hash } : { problem: `${file} (sha256 ${hash.slice(0, 16)}) is not an output the log recorded, so the snap would link to no generation.` };
}

/**
 * Checks a logged run before anything is written, and says every problem at once. Each picture goes to raw/<stage>/pixel/<id>.png and is
 * never written over a file. If approved/pixel/<id>.png exists, the picture must be those bytes: approve.mjs puts a snap there, and
 * approved art is replaced with `approve.mjs --supersede`, never by a snap that came out differently. The pictures it comes from must be
 * outputs that the log recorded, so the log links the snap to a generation.
 * @param {{ rootDir: string, stage: string, snaps: LoggedSnap[] }} request
 * @returns {Array<LoggedSnap & { file: string, sha256: string, refHashes: string[] }>}
 */
export function planSnapLog({ rootDir, stage, snaps }) {
    assertStage(stage);
    if (snaps.length === 0) {
        throw new Error('There is nothing to log.');
    }
    const folder = `raw/${stage}/pixel`;
    resolveOutDir(rootDir, join(rootDir, folder));
    const entries = readLog(join(rootDir, 'log', 'generations.jsonl'));
    const problems = [];
    const ids = new Set();
    const planned = snaps.map((snap) => {
        if (ids.has(snap.id)) {
            problems.push(`Two pictures are called "${snap.id}", and the id names the approved copy.`);
        }
        ids.add(snap.id);
        const file = `${folder}/${snap.id}.png`;
        const hash = sha256(snap.png);
        if (existsSync(join(rootDir, file))) {
            problems.push(`${file} already exists; remove it or pick another stage.`);
        }
        const approved = join(rootDir, 'approved', 'pixel', `${snap.id}.png`);
        const approvedHash = existsSync(approved) ? sha256(readFileSync(approved)) : undefined;
        if (approvedHash !== undefined && approvedHash !== hash) {
            problems.push(`approved/pixel/${snap.id}.png exists with other content than this run makes (sha256 ${approvedHash.slice(0, 16)}, not ${hash.slice(0, 16)}). To replace approved pixel art, use approve.mjs --supersede <old> --by <new> --in-place.`);
        }
        const references = [snap.master, ...(snap.patch ? [snap.patch] : [])].map((reference) => loggedReference({ rootDir, entries, file: reference }));
        problems.push(...references.flatMap(({ problem }) => (problem ? [problem] : [])));
        return { ...snap, file, sha256: hash, refHashes: references.flatMap(({ hash: referenced }) => (referenced ? [referenced] : [])) };
    });
    if (problems.length > 0) {
        throw new Error(`Nothing was written or logged:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
    }
    return planned;
}

/**
 * Writes the planned pictures and logs one entry for each as a local tool (no model call, so no cost), the way pixel-snap does:
 * `refs` holds the sha256 of the picture it was snapped from, then that of the patch picture where there is one. The entries
 * are appended one after the other, each right after its picture, with nothing else done in between.
 * @param {ReturnType<typeof planSnapLog>} planned
 * @param {{ rootDir: string, stage: string, now: () => Date }} request
 */
export function commitSnapLog(planned, { rootDir, stage, now }) {
    const logPath = join(rootDir, 'log', 'generations.jsonl');
    return planned.map(({ id, file, png, size, vars, refHashes, sha256: hash }) => {
        mkdirSync(dirname(join(rootDir, file)), { recursive: true });
        writeFileSync(join(rootDir, file), png, { flag: 'wx' });
        appendLogEntry(logPath, makeLogEntry({
            time: now().toISOString(),
            stage,
            provider: 'local',
            model: 'pixel-snap',
            template: 'pixel-snap',
            vars,
            refHashes,
            size: `${size.width}x${size.height}`,
            outputs: [{ file, sha256: hash }],
            estimatedUsd: 0,
        }));
        return { id, file, sha256: hash };
    });
}
