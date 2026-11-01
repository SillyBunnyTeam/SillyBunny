import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readLog, sha256 } from './log.mjs';

// What follows a run prefix in the file name of a model result: -p<patch>-<variant>.<ext>
const RESULT_TAIL = /^-p(\d+)-(\d+)\.[a-z0-9]+$/i;

const rectText = (rect) => `[${rect.join(',')}]`;
const sameRect = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, at) => value === b[at]);
const shortHash = (hash) => String(hash).slice(0, 16);

/** The run prefix as a path relative to `rootDir` with forward slashes, which is how the log stores file names. */
export function normaliseRunPrefix(rootDir, prefix) {
    const relativePrefix = relative(rootDir, resolve(rootDir, prefix)).split(sep).join('/');
    if (relativePrefix === '..' || relativePrefix.startsWith('../') || isAbsolute(relativePrefix)) {
        throw new Error(`--reuse ${prefix} is outside ${rootDir}.`);
    }
    return relativePrefix;
}

/**
 * Finds the model results of an earlier patch run in the log and checks that they can be composited again with
 * this source and these crops. A result is only used when its file still has the sha256 the log recorded.
 * Throws on the first thing that does not fit, before anything is written.
 * @param {object} input
 * @param {string} input.rootDir
 * @param {string} input.logPath
 * @param {string} input.prefix A run prefix such as raw/s5/tails/x/20261101T125043Z-gpt-image-2.5-sunburst-h-patch.
 * @param {string} input.sourceHash sha256 of the image being patched.
 * @param {number[][]} input.crops The crop of each patch in the new spec, as [x, y, w, h].
 */
export function loadReusedRun({ rootDir, logPath, prefix: givenPrefix, sourceHash, crops }) {
    const prefix = normaliseRunPrefix(rootDir, givenPrefix);
    const found = [];
    for (const entry of readLog(logPath)) {
        const [output] = entry.outputs ?? [];
        const tail = entry.template === 'patch-edit' && output?.file.startsWith(prefix) ? RESULT_TAIL.exec(output.file.slice(prefix.length)) : null;
        if (tail) {
            found.push({ entry, output, patch: Number(tail[1]), variant: Number(tail[2]) });
        }
    }
    if (found.length === 0) {
        throw new Error(`The log has no patch-edit result under ${prefix}.`);
    }

    for (const { entry } of found) {
        if (entry.refs?.[0] !== sourceHash) {
            throw new Error(`The source image (sha256 ${shortHash(sourceHash)}) is not the one the reused run edited (sha256 ${shortHash(entry.refs?.[0])}).`);
        }
    }
    const editedPatches = new Set(found.map((item) => item.patch)).size;
    if (editedPatches !== crops.length) {
        throw new Error(`The reused run edited ${editedPatches} patch${editedPatches === 1 ? '' : 'es'}, but the spec has ${crops.length}.`);
    }

    const byKey = new Map();
    for (const item of found) {
        const key = `${item.patch}:${item.variant}`;
        if (byKey.has(key)) {
            throw new Error(`The log has two results for patch ${item.patch} variant ${item.variant} under ${prefix}.`);
        }
        byKey.set(key, item);
    }

    const variants = Math.max(...found.map((item) => item.variant));
    const results = new Map();
    const instructions = [];
    for (const [index, crop] of crops.entries()) {
        const patch = index + 1;
        for (let variant = 1; variant <= variants; variant++) {
            const item = byKey.get(`${patch}:${variant}`);
            if (!item) {
                throw new Error(`The reused run has no result for patch ${patch} variant ${variant}.`);
            }
            if (!sameRect(item.entry.vars?.crop, crop)) {
                throw new Error(`Patch ${patch}: the crop ${rectText(crop)} is not the reused run's ${rectText(item.entry.vars?.crop ?? [])}. Only the composite rects and --feather may differ.`);
            }
            const path = join(rootDir, item.output.file);
            if (!existsSync(path)) {
                throw new Error(`The result file for patch ${patch} variant ${variant} is missing: ${item.output.file}`);
            }
            const bytes = readFileSync(path);
            if (sha256(bytes) !== item.output.sha256) {
                throw new Error(`${item.output.file} is not the file the log recorded (sha256 ${shortHash(sha256(bytes))}, logged ${shortHash(item.output.sha256)}).`);
            }
            results.set(`${patch}:${variant}`, { file: item.output.file, bytes, sha256: item.output.sha256 });
        }
        instructions.push(byKey.get(`${patch}:1`).entry.vars.instruction);
    }
    return { prefix, provider: found[0].entry.provider, model: found[0].entry.model, variants, results, instructions };
}
