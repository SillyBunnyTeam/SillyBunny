import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** @param {Buffer} bytes */
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Builds one generations.jsonl entry. Key order is the order the art plan documents.
 * References are stored only as hashes; nothing here can hold a credential.
 */
export function makeLogEntry({ time, stage, provider, model, template, vars, refHashes, size, outputs, estimatedUsd, chargedUsd }) {
    return {
        time,
        stage,
        provider,
        model,
        template,
        vars,
        refs: refHashes,
        size,
        n: outputs.length,
        outputs,
        estimatedUsd,
        // The relay's measured charge; present only when --balance could read it.
        ...(chargedUsd === undefined ? {} : { chargedUsd }),
        approved: false,
    };
}

/** @param {string} logPath */
export function readLog(logPath) {
    if (!existsSync(logPath)) {
        return [];
    }
    return readFileSync(logPath, 'utf8').split('\n').flatMap((line, index) => {
        if (!line.trim()) {
            return [];
        }
        try {
            return [JSON.parse(line)];
        } catch {
            throw new Error(`${logPath} line ${index + 1} is not valid JSON. Fix or remove it before running again.`);
        }
    });
}

/** All-time spend the cost cap is measured against: the measured charge where known, the estimate otherwise. */
export function runningTotalUsd(entries) {
    return Math.round(entries.reduce((sum, entry) => sum + (entry.chargedUsd ?? entry.estimatedUsd ?? 0), 0) * 1e6) / 1e6;
}

// log/ is not tracked until the first line exists, so a fresh checkout has no such folder.
export function appendLogEntry(logPath, entry) {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}
