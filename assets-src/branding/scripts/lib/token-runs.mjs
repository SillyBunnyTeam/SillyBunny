import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RUNS_DIR = ['log', '.runs'];
const FORGET_AFTER_MS = 24 * 3_600_000;

/** @param {number} pid */
export function pidIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means the process exists and belongs to someone else.
        return error.code === 'EPERM';
    }
}

const runsDir = (rootDir) => join(rootDir, ...RUNS_DIR);

/** @returns {Array<{ path: string, record: { provider: string, pid: number, startedAt: number, endedAt?: number } }>} */
function readRecords(rootDir) {
    let names;
    try {
        names = readdirSync(runsDir(rootDir));
    } catch {
        return [];
    }
    return names.flatMap((name) => {
        const path = join(runsDir(rootDir), name);
        try {
            const record = JSON.parse(readFileSync(path, 'utf8'));
            const isWhole = typeof record.provider === 'string' && Number.isInteger(record.pid) && Number.isFinite(record.startedAt);
            return isWhole ? [{ path, record }] : [];
        } catch {
            return [];
        }
    });
}

// The random suffix keeps two runs of one process that start in the same millisecond apart.
/**
 * Records that a run is about to spend on a provider's token. The relay's balance counts every run on the token, so a run that
 * measures its own charge from the balance change can only trust the figure when no other run overlapped it; these records are how it knows.
 * Records stay after a run ends, because a run that started and finished inside another run's window still changed its balance.
 * @param {{ rootDir: string, provider: string, now: () => Date, pid?: number }} options
 */
export function startRun({ rootDir, provider, now, pid = process.pid }) {
    mkdirSync(runsDir(rootDir), { recursive: true });
    const startedAt = now().getTime();
    for (const { path, record } of readRecords(rootDir)) {
        if (startedAt - (record.endedAt ?? record.startedAt) > FORGET_AFTER_MS) {
            unlinkSync(path);
        }
    }
    const run = { rootDir, provider, pid, startedAt, path: join(runsDir(rootDir), `${provider}-${startedAt}-${pid}-${randomBytes(3).toString('hex')}.json`) };
    writeFileSync(run.path, JSON.stringify({ provider, pid, startedAt }));
    return run;
}

/** Stamps the end of a run on its record. */
export function endRun(run, { now }) {
    writeFileSync(run.path, JSON.stringify({ provider: run.provider, pid: run.pid, startedAt: run.startedAt, endedAt: now().getTime() }));
}

/**
 * The other runs on the same provider's token whose time overlapped this run, from its start to now. A run that never ended
 * counts as going on while its process is alive, and as a single moment when it is gone (it crashed).
 * A run that ended exactly when this one started does not overlap.
 * @returns {Array<{ pid: number, startedAt: number, endedAt?: number }>}
 */
export function otherRunsDuring(run, { now, isAlive = pidIsAlive }) {
    const windowEnd = now().getTime();
    return readRecords(run.rootDir)
        .filter(({ path, record }) => path !== run.path && record.provider === run.provider)
        .map(({ record }) => record)
        .filter((record) => {
            const end = record.endedAt ?? (isAlive(record.pid) ? Infinity : record.startedAt);
            return record.startedAt <= windowEnd && end > run.startedAt;
        });
}

/** Runs that have not ended and whose process is still there. */
export function activeRuns(rootDir, { isAlive = pidIsAlive } = {}) {
    return readRecords(rootDir)
        .map(({ record }) => record)
        .filter((record) => record.endedAt === undefined && isAlive(record.pid));
}
