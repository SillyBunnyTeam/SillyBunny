/**
 * The Android smoke's runtime-lock guard (plan §7.1, task 6.2).
 *
 * The smoke APK carries the Node binaries that `android/runtime.lock` pins by GHCR digest. Until the Node
 * workflow (`android-runtime.yml`) first publishes, every digest is `null`, so there is nothing to test: the
 * smoke then skips with a `::notice::` and a job-summary line instead of failing every pull request. A lock in
 * which only some ABIs are pinned, or a malformed pin, is a broken lock and fails.
 */
import fs from 'node:fs';

/** The `outcome` the smoke reports when it skips. */
export const SKIPPED = 'skipped';

/** Machine codes of the guard's decisions. */
export const GUARD_CODES = Object.freeze({
    pinned: 'node-digests-pinned',
    unpinned: 'node-digests-unpinned',
    partial: 'node-digests-partial',
    invalidDigest: 'node-digest-invalid',
    invalidLock: 'runtime-lock-invalid',
});

const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * Decides whether the smoke can run on a parsed `android/runtime.lock`.
 * @param {unknown} lock Parsed lock.
 * @returns {{ok: boolean, run: boolean, code: string, abis: Record<string, string|null>, detail?: string}}
 *     `ok` is false for a lock the smoke must fail on; `run` is true only when every ABI is pinned.
 */
export function evaluateRuntimeLock(lock) {
    const invalid = (detail, abis = {}) => ({ ok: false, run: false, code: GUARD_CODES.invalidLock, abis, detail });
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
        return invalid('the lock is not a JSON object');
    }
    const abiNames = lock.abis;
    if (!Array.isArray(abiNames) || abiNames.length === 0 || !abiNames.every(abi => typeof abi === 'string' && abi.length > 0)) {
        return invalid('abis must be a non-empty list of ABI names');
    }
    const binaries = lock.node?.binaries;
    if (!binaries || typeof binaries !== 'object' || Array.isArray(binaries)) {
        return invalid('node.binaries must be an object');
    }

    /** @type {Record<string, string|null>} */
    const abis = {};
    for (const abi of abiNames) {
        const entry = binaries[abi];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return invalid(`node.binaries.${abi} is missing`, abis);
        }
        const { digest, sha256, size } = entry;
        if (digest === null) {
            // update-node-digests.py --reset clears all three together.
            if (sha256 !== null || size !== null) {
                return { ok: false, run: false, code: GUARD_CODES.invalidDigest, abis, detail: `node.binaries.${abi} has a sha256 or size but no digest` };
            }
            abis[abi] = null;
            continue;
        }
        if (typeof digest !== 'string' || !OCI_DIGEST.test(digest)) {
            return { ok: false, run: false, code: GUARD_CODES.invalidDigest, abis, detail: `node.binaries.${abi}.digest is not sha256:<64 hex>` };
        }
        if (typeof sha256 !== 'string' || !HEX_SHA256.test(sha256) || !Number.isSafeInteger(size) || size <= 0) {
            return { ok: false, run: false, code: GUARD_CODES.invalidDigest, abis, detail: `node.binaries.${abi} has a digest but no valid sha256 and size` };
        }
        abis[abi] = digest;
    }

    const pinned = Object.values(abis).filter(digest => digest !== null).length;
    if (pinned === abiNames.length) {
        return { ok: true, run: true, code: GUARD_CODES.pinned, abis };
    }
    if (pinned === 0) {
        return { ok: true, run: false, code: GUARD_CODES.unpinned, abis };
    }
    const missing = abiNames.filter(abi => abis[abi] === null);
    return { ok: false, run: false, code: GUARD_CODES.partial, abis, detail: `unpinned: ${missing.join(', ')}` };
}

/**
 * Reads and evaluates a lock file.
 * @param {string} file Path of `android/runtime.lock`.
 * @returns {ReturnType<typeof evaluateRuntimeLock>} Decision.
 */
export function evaluateRuntimeLockFile(file) {
    let lock;
    try {
        lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        return { ok: false, run: false, code: GUARD_CODES.invalidLock, abis: {}, detail: `cannot read ${file}: ${error.message}` };
    }
    return evaluateRuntimeLock(lock);
}

/**
 * What the guard writes for GitHub Actions: step outputs, workflow commands for the log and job-summary
 * lines. Nothing here is printed for a run that goes ahead, apart from the outputs.
 * @param {ReturnType<typeof evaluateRuntimeLock>} decision Decision.
 * @returns {{outputs: Record<string, string>, commands: string[], summary: string[]}} GitHub Actions text.
 */
export function guardReport(decision) {
    if (!decision.ok) {
        return {
            outputs: { run: 'false', reason: decision.code },
            commands: ['::error title=TODO(copy)::TODO(copy)'],
            summary: [],
        };
    }
    if (decision.run) {
        return { outputs: { run: 'true', reason: decision.code }, commands: [], summary: [] };
    }
    return {
        outputs: { run: 'false', reason: decision.code },
        commands: ['::notice title=TODO(copy)::TODO(copy)'],
        summary: ['TODO(copy)', '', `- outcome: \`${SKIPPED}\``, `- reason: \`${decision.code}\``, ''],
    };
}

/**
 * Appends `key=value` lines to a GitHub Actions file command target (`$GITHUB_OUTPUT`).
 * @param {string} file Target file.
 * @param {Record<string, string>} values Values without newlines.
 */
export function appendOutputs(file, values) {
    const lines = Object.entries(values).map(([key, value]) => {
        if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
            throw new Error(`Output ${key} must be a single line.`);
        }
        return `${key}=${value}\n`;
    });
    fs.appendFileSync(file, lines.join(''));
}

/**
 * Appends Markdown lines to the job summary (`$GITHUB_STEP_SUMMARY`).
 * @param {string} file Target file.
 * @param {string[]} lines Lines.
 */
export function appendSummary(file, lines) {
    if (lines.length > 0) {
        fs.appendFileSync(file, `${lines.join('\n')}\n`);
    }
}
