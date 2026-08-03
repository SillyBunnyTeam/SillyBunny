import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const lockfile = require('proper-lockfile');

const LOCK_RETRY_DELAY_MS = 25;
const LOCK_RETRY_LIMIT = 200;
const LOCK_STALE_MS = 300_000;
const activeLocks = new Set();

export function getChatFileLockPath(filePath) {
    const resolvedPath = path.resolve(filePath);
    const lockKey = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
    return path.join(path.dirname(filePath), `.sillybunny-chat-${crypto.createHash('sha256').update(lockKey).digest('hex')}.lock`);
}

export function acquireChatFileLock(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lockPath = getChatFileLockPath(filePath);
    if (activeLocks.has(lockPath)) {
        throw Object.assign(new Error(`Chat file is already locked: ${filePath}`), { code: 'ELOCKED' });
    }

    let release;
    for (let attempt = 0; attempt <= LOCK_RETRY_LIMIT; attempt++) {
        try {
            release = lockfile.lockSync(filePath, {
                lockfilePath: lockPath,
                realpath: false,
                stale: LOCK_STALE_MS,
                update: LOCK_STALE_MS / 3,
            });
            break;
        } catch (error) {
            if (error?.code !== 'ELOCKED' || attempt === LOCK_RETRY_LIMIT) {
                throw error;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_DELAY_MS);
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
