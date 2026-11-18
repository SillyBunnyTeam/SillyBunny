import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkArt } from './check.js';
import { encoderMismatches } from './codec.js';
import { deriveAsset, isDerived } from './derive.js';
import { applyBump, keyProblems, planBump } from './keys.js';
import { applyManaged, managedProblems, planManaged } from './managed.js';
import { MANIFEST_PATH, mastersOf, outputFile, outputsOf, readManifest } from './manifest.js';
import { NOTICE_PATH, noticeState } from './notice.js';
import { ArtProblem, exitCodeOf } from './problem.js';
import { proveArt } from './prove.js';
import { sha256 } from './raster.js';

/**
 * @typedef {{ root: string, manifestPath?: string, only?: string[], write?: boolean, pixels?: boolean, today?: string, key?: string }} CommandOptions
 * @typedef {{ result: Record<string, unknown>, exitCode: number }} CommandRun
 */

/** The result of a command. Its warnings never change the exit code, which comes from its problems alone. */
function finish(command, payload, problems, warnings = []) {
    return { result: { format: 1, command, ok: problems.length === 0, ...payload, problems, warnings }, exitCode: exitCodeOf(problems) };
}

function loadManifest(command, { root, manifestPath = MANIFEST_PATH }) {
    const { manifest, problems } = readManifest(root, manifestPath);
    return { manifest, failed: problems.length > 0 ? finish(command, {}, problems) : null };
}

function unknownAssets(manifest, only) {
    return (only ?? []).filter((id) => !manifest.assets[id]).map((id) => ({ code: 'unknown-asset', asset: id, message: `The manifest has no asset "${id}".` }));
}

/** @param {CommandOptions} options @returns {Promise<CommandRun>} */
export async function runList(options) {
    const { manifest, failed } = loadManifest('list', options);
    if (failed) {
        return failed;
    }
    const assets = Object.entries(manifest.assets).map(([id, asset]) => ({
        id,
        type: asset.type,
        key: asset.key,
        ...(asset.ratio ? { ratio: asset.ratio } : {}),
        ...(asset.grid ? { grid: asset.grid } : {}),
        masters: mastersOf(asset),
        outputs: outputsOf(asset).map(({ path }) => path),
    }));
    return finish('list', { assets }, []);
}

/** @param {CommandOptions} options @returns {Promise<CommandRun>} */
export async function runCheck(options) {
    const { manifest, failed } = loadManifest('check', options);
    if (failed) {
        return failed;
    }
    const { summary, problems, warnings } = await checkArt(options.root, manifest);
    problems.push(...keyProblems(options.root, manifest));
    problems.push(...noticeState(options.root, manifest).problems);
    problems.push(...await managedProblems(options.root, manifest));
    return finish('check', { summary }, problems, warnings);
}

/**
 * Makes the generated region of NOTICE.md from the provenance records. Without `write` it only reports whether the
 * region is stale.
 * @param {CommandOptions} options
 * @returns {Promise<CommandRun>}
 */
export async function runNotice(options) {
    const { manifest, failed } = loadManifest('notice', options);
    if (failed) {
        return failed;
    }
    const { current, expected, problems } = noticeState(options.root, manifest);
    const stale = problems.some(({ code }) => code === 'notice-stale');
    if (!options.write || !stale) {
        return finish('notice', { write: Boolean(options.write), path: NOTICE_PATH, stale }, problems);
    }
    writeAtomically(join(options.root, NOTICE_PATH), expected);
    return finish('notice', { write: true, path: NOTICE_PATH, stale: false, written: current !== expected }, []);
}

/**
 * Gives a new key to every group whose files changed since its key did, and a new version to every managed item that a
 * derived entry ships and that changed since its version did, and records them. Without `write` it only reports the keys
 * and the versions it would change.
 * @param {CommandOptions} options `today` as YYYY-MM-DD, by default the UTC day.
 * @returns {Promise<CommandRun>}
 */
export async function runBump(options) {
    const { root, manifestPath = MANIFEST_PATH, write = false, today = new Date().toISOString().slice(0, 10), key } = options;
    const { manifest, failed } = loadManifest('bump', options);
    if (failed) {
        return failed;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
        return finish('bump', { write }, [{ code: 'usage', message: `--today must be YYYY-MM-DD, got ${today}.` }]);
    }
    const { bumps, problems } = planBump(root, manifest, { today: today.replaceAll('-', ''), key });
    const managed = await planManaged(root, manifest);
    problems.push(...managed.problems);
    const versions = managed.changes.map(({ asset, item, type, from, to }) => ({ asset, item, type, from, to }));
    if (problems.length > 0 || !write || (bumps.length === 0 && versions.length === 0)) {
        return finish('bump', { write, bumps, managed: versions }, problems);
    }
    let managedWritten;
    try {
        managedWritten = await applyManaged(root, manifest, managed.changes);
    } catch (error) {
        if (!(error instanceof ArtProblem)) {
            throw error;
        }
        return finish('bump', { write, bumps, managed: versions }, [error.toJSON()]);
    }
    applyBump(root, manifest, bumps);
    const manifestChanged = writeManifest(join(root, manifestPath), manifest);
    return finish('bump', { write, bumps, managed: versions, written: [...new Set([...bumps.map(({ file }) => file), ...managedWritten])], manifestChanged }, []);
}

/** @param {CommandOptions} options @returns {Promise<CommandRun>} */
export async function runProve(options) {
    const { manifest, failed } = loadManifest('prove', options);
    if (failed) {
        return failed;
    }
    const unknown = unknownAssets(manifest, options.only);
    if (unknown.length > 0) {
        return finish('prove', {}, unknown);
    }
    const { problems, ...payload } = await proveArt(options.root, manifest, { only: options.only, pixels: options.pixels });
    return finish('prove', payload, problems);
}

/**
 * Derives every derived asset and reports the outputs whose bytes would change. With `write`, it writes those outputs and
 * records their sha256 in the manifest; every file is derived before the first one is written, so a failure writes nothing.
 * @param {CommandOptions} options
 * @returns {Promise<CommandRun>}
 */
export async function runDerive(options) {
    const { root, manifestPath = MANIFEST_PATH, only, write = false } = options;
    const { manifest, failed } = loadManifest('derive', options);
    if (failed) {
        return failed;
    }
    const unknown = unknownAssets(manifest, only);
    if (unknown.length > 0) {
        return finish('derive', {}, unknown);
    }
    if (write) {
        const mismatches = encoderMismatches(manifest.encoder).map((mismatch) => ({
            code: 'encoder-mismatch',
            ...mismatch,
            message: `This install has ${mismatch.library} ${mismatch.actual}, but the shipped bytes were made with ${mismatch.expected}, so a write would change every file. Run npm ci --prefix scripts/art.`,
        }));
        if (mismatches.length > 0) {
            return finish('derive', { write }, mismatches);
        }
    }
    const problems = [];
    const changed = [];
    const recordedStale = [];
    let outputs = 0;
    for (const [id, asset] of Object.entries(manifest.assets)) {
        if ((only && !only.includes(id)) || !isDerived(asset)) {
            continue;
        }
        let files;
        try {
            files = await deriveAsset(root, id, asset, manifest);
        } catch (error) {
            if (!(error instanceof ArtProblem)) {
                throw error;
            }
            problems.push({ asset: id, ...error.toJSON() });
            continue;
        }
        for (const file of files) {
            outputs++;
            const path = outputFile(root, file.path);
            const before = existsSync(path) ? sha256(readFileSync(path)) : null;
            if (before !== file.sha256) {
                changed.push({ asset: id, path: file.path, before, after: file.sha256, bytes: file.bytes });
            }
            if (recordShaOf(asset, file.path) !== file.sha256) {
                recordedStale.push({ asset: id, path: file.path, sha256: file.sha256 });
            }
        }
    }
    const report = (entries) => entries.map(({ asset, path, before, after }) => ({ asset, path, before, after }));
    if (problems.length > 0 || !write) {
        return finish('derive', { write, summary: { outputs, changed: changed.length }, changed: report(changed), manifestStale: recordedStale.map(({ path }) => path) }, problems);
    }
    for (const { path, bytes } of changed) {
        writeAtomically(outputFile(root, path), bytes);
    }
    for (const { asset, path, sha256: digest } of recordedStale) {
        setRecordedSha(manifest.assets[asset], path, digest);
    }
    const manifestChanged = writeManifest(join(root, manifestPath), manifest);
    return finish('derive', {
        write,
        summary: { outputs, changed: changed.length },
        changed: report(changed),
        written: changed.map(({ path }) => path),
        manifestChanged,
    }, []);
}

function recordShaOf(asset, path) {
    return outputsOf(asset).find((output) => output.path === path)?.sha256;
}

function setRecordedSha(asset, path, digest) {
    if (asset.motion?.output === path) {
        asset.motion.sha256 = digest;
        return;
    }
    const lists = [
        asset.outputs,
        ...Object.values(asset.frames ?? {}).map((frame) => frame.outputs),
        asset.backdrop?.outputs ?? [],
        ...Object.values(asset.layers ?? {}).flatMap((layer) => Object.values(layer.pictures).map((picture) => picture.outputs)),
    ];
    for (const output of lists.flat()) {
        if (output.path === path) {
            output.sha256 = digest;
        }
    }
}

/** @returns {boolean} Whether the file changed. */
export function writeManifest(path, manifest) {
    const text = `${JSON.stringify(manifest, null, 4)}\n`;
    if (existsSync(path) && readFileSync(path, 'utf8') === text) {
        return false;
    }
    writeAtomically(path, text);
    return true;
}

/** A reader never sees half a file: the bytes go to a temporary file beside the target, which then replaces it. */
export function writeAtomically(path, bytes) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
}
