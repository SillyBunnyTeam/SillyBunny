import { spawn, spawnSync } from 'node:child_process';

/** Identity used for every fixture commit and tag, so commit ids are reproducible. */
export const FIXTURE_IDENTITY = Object.freeze({ name: 'SillyBunny Fixture', email: 'fixture@sillybunny.invalid' });

/** 2026-01-01T00:00:00Z. Fixture commits are dated from here so their ids are deterministic. */
export const FIXTURE_EPOCH = 1767225600;

const DROPPED_ENV = new Set([
    'BASH_ENV',
    'ENV',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
]);

/**
 * Builds an environment for git that ignores the host's system and global configuration.
 * @param {object} [options] Options.
 * @param {string} [options.home] HOME for git; a scratch directory keeps user files out of the run.
 * @param {Record<string, string>} [options.extra] Extra variables applied last.
 * @returns {Record<string, string>} Environment.
 */
export function createGitEnv({ home, extra = {} } = {}) {
    /** @type {Record<string, string>} */
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined || key.startsWith('GIT_') || key.startsWith('SILLYBUNNY_') || DROPPED_ENV.has(key)) {
            continue;
        }
        env[key] = value;
    }
    Object.assign(env, {
        GIT_CONFIG_NOSYSTEM: '1',
        // Git for Windows maps /dev/null to NUL, so this works on every host.
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_DEFAULT_HASH: 'sha1',
        GIT_AUTHOR_NAME: FIXTURE_IDENTITY.name,
        GIT_AUTHOR_EMAIL: FIXTURE_IDENTITY.email,
        GIT_COMMITTER_NAME: FIXTURE_IDENTITY.name,
        GIT_COMMITTER_EMAIL: FIXTURE_IDENTITY.email,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
    });
    if (home) {
        env.HOME = home;
        env.USERPROFILE = home;
        env.XDG_CONFIG_HOME = home;
    }
    return Object.assign(env, extra);
}

/**
 * Formats a fixture timestamp for GIT_AUTHOR_DATE and GIT_COMMITTER_DATE.
 * @param {number} seconds Seconds since the Unix epoch.
 * @returns {string} Git raw date.
 */
export function gitDate(seconds) {
    return `${Math.trunc(seconds)} +0000`;
}

/**
 * Runs git synchronously and returns its exit status and output.
 * @param {string[]} args Arguments, including any `-C <dir>`.
 * @param {object} [options] Options.
 * @param {Record<string, string>} [options.env] Environment (defaults to an isolated one).
 * @param {string|Buffer} [options.input] Data written to stdin.
 * @param {string} [options.cwd] Working directory.
 * @returns {{status: number|null, stdout: string, stderr: string}} Result.
 */
export function gitResult(args, { env, input, cwd } = {}) {
    const result = spawnSync('git', args, {
        cwd,
        env: env ?? createGitEnv(),
        input,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
    });
    if (result.error) {
        throw result.error;
    }
    return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

/**
 * Runs git synchronously and returns trimmed stdout. Throws with stderr on failure.
 * @param {string[]} args Arguments, including any `-C <dir>`.
 * @param {object} [options] Options passed to {@link gitResult}.
 * @param {Record<string, string>} [options.env] Environment (defaults to an isolated one).
 * @param {string|Buffer} [options.input] Data written to stdin.
 * @param {string} [options.cwd] Working directory.
 * @returns {string} Trimmed stdout.
 */
export function runGit(args, options = {}) {
    const result = gitResult(args, options);
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
}

/**
 * Runs git without blocking the event loop. Use it for clients of a server in the same process.
 * @param {string[]} args Arguments, including any `-C <dir>`.
 * @param {object} [options] Options.
 * @param {Record<string, string>} [options.env] Environment (defaults to an isolated one).
 * @param {string|Buffer} [options.input] Data written to stdin.
 * @param {string} [options.cwd] Working directory.
 * @returns {Promise<{status: number|null, stdout: string, stderr: string}>} Result.
 */
export function gitResultAsync(args, { env, input, cwd } = {}) {
    return new Promise((resolve, reject) => {
        // Without input, stdin is the null device: a git that exits at once cannot race a write to it.
        const stdin = input === undefined ? 'ignore' : 'pipe';
        const child = spawn('git', args, { cwd, env: env ?? createGitEnv(), stdio: [stdin, 'pipe', 'pipe'], windowsHide: true });
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', chunk => stdout.push(chunk));
        child.stderr.on('data', chunk => stderr.push(chunk));
        child.on('error', reject);
        child.on('close', status => resolve({
            status,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
        }));
        if (child.stdin) {
            // git can exit before it reads all of its input (EPIPE); its exit status reports real failures.
            child.stdin.on('error', () => {});
            child.stdin.end(input);
        }
    });
}

/**
 * Async form of {@link runGit}.
 * @param {string[]} args Arguments, including any `-C <dir>`.
 * @param {object} [options] Options passed to {@link gitResultAsync}.
 * @param {Record<string, string>} [options.env] Environment (defaults to an isolated one).
 * @param {string|Buffer} [options.input] Data written to stdin.
 * @param {string} [options.cwd] Working directory.
 * @returns {Promise<string>} Trimmed stdout.
 */
export async function runGitAsync(args, options = {}) {
    const result = await gitResultAsync(args, options);
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
}
