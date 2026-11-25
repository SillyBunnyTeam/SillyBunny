import nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Enables Node's V8 bytecode compile cache outside git-tracked paths when supported by the runtime.
 * @param {{ moduleApi?: typeof nodeModule, env?: NodeJS.ProcessEnv, versions?: NodeJS.ProcessVersions, repoDir?: string }} [options]
 * @returns {string | null} Active cache directory when enabled, or null when skipped or unsupported.
 */
export function enableNodeCompileCache({
    moduleApi = nodeModule,
    env = process.env,
    versions = process.versions,
    repoDir = defaultRepoDir,
} = {}) {
    if (versions?.bun || typeof moduleApi?.enableCompileCache !== 'function') {
        return null;
    }

    const cacheDir = env?.NODE_COMPILE_CACHE?.trim()
        || path.join(repoDir, 'node_modules', '.cache', 'sillybunny-v8');

    try {
        moduleApi.enableCompileCache(cacheDir);
        return cacheDir;
    } catch {
        // Read-only filesystems continue without persistent bytecode caching.
        return null;
    }
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
