import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const lockfile = require('proper-lockfile');

const LOCK_RETRY_DELAY_MS = 25;
const ASYNC_LOCK_RETRY_LIMIT = 200;
const SYNC_LOCK_MAX_WAIT_MS = 1500;
const LOCK_STALE_MS = 300_000;
const activeLocks = new Set();
const inProcessMutexQueues = new Map();
const syncWaitArray = new Int32Array(new SharedArrayBuffer(4));

function sleepAsync(delayMs) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
    });
}

function acquireInProcessMutex(lockKey) {
    const previous = inProcessMutexQueues.get(lockKey) ?? Promise.resolve();
    let releaseCurrent;
    const current = new Promise(resolve => {
        releaseCurrent = resolve;
    });
    const tail = previous.then(() => current, () => current);
    inProcessMutexQueues.set(lockKey, tail);

    return previous.then(() => {
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            if (inProcessMutexQueues.get(lockKey) === tail) {
                inProcessMutexQueues.delete(lockKey);
            }
            releaseCurrent();
        };
    });
}

export function getChatFileLockPath(filePath) {
    const resolvedPath = path.resolve(filePath);
    const lockKey = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
    return path.join(path.dirname(filePath), `.sillybunny-chat-${crypto.createHash('sha256').update(lockKey).digest('hex')}.lock`);
}

/**
 * Acquires a chat file lock asynchronously using an in-process FIFO mutex queue
 * and non-blocking cross-process retry backoff (never calling Atomics.wait).
 * @param {string} filePath Target chat file path
 * @param {object} [options] Optional retry/staleness settings
 * @param {number} [options.staleMs] Stale lock age threshold in ms
 * @param {number} [options.retryLimit] Max cross-process ELOCKED retries
 * @param {number} [options.retryDelayMs] Delay between retries in ms
 * @returns {Promise<() => Promise<void>>} Async release callback
 */
export async function acquireChatFileLockAsync(filePath, {
    staleMs = LOCK_STALE_MS,
    retryLimit = ASYNC_LOCK_RETRY_LIMIT,
    retryDelayMs = LOCK_RETRY_DELAY_MS,
} = {}) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const lockPath = getChatFileLockPath(filePath);
    const releaseInProcess = await acquireInProcessMutex(lockPath);

    let releaseFileLock;
    try {
        for (let attempt = 0; attempt <= retryLimit; attempt++) {
            try {
                releaseFileLock = await lockfile.lock(filePath, {
                    lockfilePath: lockPath,
                    realpath: false,
                    stale: staleMs,
                    update: Math.max(1000, Math.floor(staleMs / 3)),
                });
                break;
            } catch (error) {
                if (error?.code !== 'ELOCKED' || attempt === retryLimit) {
                    throw error;
                }
                await sleepAsync(retryDelayMs);
            }
        }
    } catch (error) {
        releaseInProcess();
        throw error;
    }

    activeLocks.add(lockPath);
    let released = false;
    return async () => {
        if (released) {
            return;
        }
        released = true;
        try {
            await releaseFileLock?.();
        } finally {
            activeLocks.delete(lockPath);
            releaseInProcess();
        }
    };
}

/**
 * Acquires locks for multiple chat files in deterministic path order asynchronously.
 * @param {string[]} filePaths Target chat file paths
 * @param {object} [options] Optional retry/staleness settings
 * @returns {Promise<() => Promise<void>>} Async release callback
 */
export async function acquireChatFileLocksAsync(filePaths, options = {}) {
    const uniquePaths = [...new Map(filePaths.map(filePath => [getChatFileLockPath(filePath), filePath])).entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, filePath]) => filePath);
    const releases = [];
    try {
        for (const filePath of uniquePaths) {
            releases.push(await acquireChatFileLockAsync(filePath, options));
        }
    } catch (error) {
        for (const release of releases.reverse()) {
            await release();
        }
        throw error;
    }

    return async () => {
        for (const release of releases.reverse()) {
            await release();
        }
    };
}

/**
 * Runs an async callback under the non-blocking chat file lock.
 * @template T
 * @param {string} filePath Target chat file path
 * @param {() => Promise<T> | T} callback Work to run while locked
 * @param {object} [options] Optional retry/staleness settings
 * @returns {Promise<T>}
 */
export async function withChatFileLockAsync(filePath, callback, options = {}) {
    const release = await acquireChatFileLockAsync(filePath, options);
    try {
        return await callback();
    } finally {
        await release();
    }
}

export function acquireChatFileLock(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lockPath = getChatFileLockPath(filePath);
    if (activeLocks.has(lockPath)) {
        throw Object.assign(new Error(`Chat file is already locked: ${filePath}`), { code: 'ELOCKED' });
    }

    let release;
    let waitedMs = 0;
    let nextDelayMs = 5;
    for (;;) {
        try {
            release = lockfile.lockSync(filePath, {
                lockfilePath: lockPath,
                realpath: false,
                stale: LOCK_STALE_MS,
                update: LOCK_STALE_MS / 3,
            });
            break;
        } catch (error) {
            if (error?.code !== 'ELOCKED' || waitedMs >= SYNC_LOCK_MAX_WAIT_MS) {
                throw error;
            }
            const delayMs = Math.min(nextDelayMs, SYNC_LOCK_MAX_WAIT_MS - waitedMs);
            Atomics.wait(syncWaitArray, 0, 0, delayMs);
            waitedMs += delayMs;
            nextDelayMs = Math.min(LOCK_RETRY_DELAY_MS, nextDelayMs + 5);
        }
    }

    activeLocks.add(lockPath);
    return () => {
        try {
            release?.();
        } finally {
            activeLocks.delete(lockPath);
        }
    };
}

export function acquireChatFileLocks(filePaths) {
    const uniquePaths = [...new Map(filePaths.map(filePath => [getChatFileLockPath(filePath), filePath])).entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, filePath]) => filePath);
    const releases = [];
    try {
        for (const filePath of uniquePaths) {
            releases.push(acquireChatFileLock(filePath));
        }
    } catch (error) {
        for (const release of releases.reverse()) {
            release();
        }
        throw error;
    }

    return () => {
        for (const release of releases.reverse()) {
            release();
        }
    };
}
