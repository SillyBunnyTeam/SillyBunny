import fs from 'node:fs';
import nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PRIVATE_DIRECTORY_MODE = 0o700;
const GROUP_AND_OTHERS_WRITE = 0o022;
const PRIVATE_DIRECTORY_RULE = 'must be owned by the current user and not writable by group or others';

/**
 * A compile cache holds bytecode that Node.js runs without checking who wrote it, so a cache directory is trusted
 * only when the current user owns it and group and others cannot write to it. Windows has no such owner and mode bits.
 * @param {string} directory Cache directory to check
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {boolean} True when the directory may hold the compile cache
 */
export function isPrivateCacheDirectory(directory, { platform = process.platform } = {}) {
    if (platform === 'win32' || typeof process.getuid !== 'function') {
        return true;
    }

    try {
        const stat = fs.statSync(directory);
        return stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & GROUP_AND_OTHERS_WRITE) === 0;
    } catch {
        return false;
    }
}

/**
 * Creates the cache directory closed to group and others when it is missing. A directory that exists is only
 * tightened when `tighten` is set, which is the case for SillyBunny's own default location and never for a
 * directory that the operator chose.
 * @param {string} directory Cache directory
 * @param {{ tighten: boolean, platform?: NodeJS.Platform }} options
 */
function preparePrivateCacheDirectory(directory, { tighten, platform = process.platform }) {
    if (platform === 'win32' || typeof process.getuid !== 'function') {
        return;
    }

    try {
        fs.mkdirSync(path.dirname(directory), { recursive: true });
        fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
        if (error?.code !== 'EEXIST' || !tighten) {
            return;
        }

        // A directory that an earlier start created follows the umask, which can leave it open to the group.
        try {
            const stat = fs.statSync(directory);
            if (stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & GROUP_AND_OTHERS_WRITE) !== 0) {
                fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
            }
        } catch {
            // The check that follows decides whether the directory may be used.
        }
    }
}

/**
 * Enables Node's V8 bytecode compile cache outside git-tracked paths when supported by the runtime.
 * A NODE_COMPILE_CACHE directory from the environment is used only when it is private; otherwise the default
 * location under the install is used and the environment is corrected for child processes.
 * Node.js reads NODE_COMPILE_CACHE before any application code runs, so this process can already hold a cache that
 * it cannot switch away from. The status that Node.js returns then names that directory.
 * @param {{ moduleApi?: typeof nodeModule, env?: NodeJS.ProcessEnv, versions?: NodeJS.ProcessVersions, repoDir?: string, platform?: NodeJS.Platform, warn?: (message: string) => void }} [options]
 * @returns {string | null} Active cache directory that Node.js reports when the cache is on, or null when skipped, unsupported, disabled or failed.
 */
export function enableNodeCompileCache({
    moduleApi = nodeModule,
    env = process.env,
    versions = process.versions,
    repoDir = defaultRepoDir,
    platform = process.platform,
    warn = (message) => console.warn(message),
} = {}) {
    if (versions?.bun || typeof moduleApi?.enableCompileCache !== 'function') {
        return null;
    }

    const defaultDir = path.join(repoDir, 'node_modules', '.cache', 'sillybunny-v8');
    const requestedDir = env?.NODE_COMPILE_CACHE?.trim() || null;
    const requestsDefault = requestedDir !== null && path.resolve(requestedDir) === path.resolve(defaultDir);

    let cacheDir = requestedDir ?? defaultDir;
    let rejectedRequestedDir = null;
    if (requestedDir !== null && !requestsDefault) {
        preparePrivateCacheDirectory(requestedDir, { tighten: false, platform });
        if (!isPrivateCacheDirectory(requestedDir, { platform })) {
            rejectedRequestedDir = requestedDir;
            cacheDir = defaultDir;
        }
    }

    if (path.resolve(cacheDir) === path.resolve(defaultDir)) {
        preparePrivateCacheDirectory(defaultDir, { tighten: true, platform });
        if (!isPrivateCacheDirectory(defaultDir, { platform })) {
            cacheDir = null;
        }
    }

    if (rejectedRequestedDir !== null) {
        warn(`[SillyBunny] Ignoring NODE_COMPILE_CACHE=${rejectedRequestedDir}: it ${PRIVATE_DIRECTORY_RULE}. Child processes use ${cacheDir ?? 'no compile cache'}.`);
    } else if (cacheDir === null) {
        warn(`[SillyBunny] Compile cache stays off: ${defaultDir} ${PRIVATE_DIRECTORY_RULE}.`);
    }

    if (rejectedRequestedDir !== null || cacheDir === null) {
        // The supervised child process and any other child inherit the corrected value.
        if (cacheDir === null) {
            delete env.NODE_COMPILE_CACHE;
        } else {
            env.NODE_COMPILE_CACHE = cacheDir;
        }
    }

    if (cacheDir === null) {
        return null;
    }

    // Node.js reports an unwritable directory or a disabled cache through the status and does not throw.
    const result = moduleApi.enableCompileCache(cacheDir);
    const statuses = moduleApi.constants?.compileCacheStatus ?? nodeModule.constants?.compileCacheStatus;
    const isOn = result?.status !== undefined
        && (result.status === statuses?.ENABLED || result.status === statuses?.ALREADY_ENABLED);
    return isOn ? (result.directory ?? cacheDir) : null;
}

/**
 * Flushes pending V8 compile cache entries to disk so abrupt termination retains startup bytecode.
 * @param {{ moduleApi?: typeof nodeModule, versions?: NodeJS.ProcessVersions }} [options]
 * @returns {boolean} True when flush ran without throwing.
 */
export function flushNodeCompileCache({
    moduleApi = nodeModule,
    versions = process.versions,
} = {}) {
    if (versions?.bun || typeof moduleApi?.flushCompileCache !== 'function') {
        return false;
    }

    try {
        moduleApi.flushCompileCache();
        return true;
    } catch {
        return false;
    }
}
