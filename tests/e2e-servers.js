import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_COUNT_VARIABLE = 'SILLYBUNNY_TEST_SERVERS';
export const SERVER_RUNTIME_VARIABLE = 'SILLYBUNNY_TEST_SERVER_RUNTIME';
export const COMPRESSION_VARIABLE = 'SILLYBUNNY_TEST_COMPRESSION';
export const ACCOUNT_ISOLATION_VARIABLE = 'SILLYBUNNY_TEST_ISOLATE_ACCOUNTS';
// The main process writes the servers here before it starts any worker, and each worker inherits it.
export const SERVER_LIST_VARIABLE = 'SILLYBUNNY_TEST_SERVER_LIST';
export const SEQUENTIAL_SPECS_VARIABLE = 'SILLYBUNNY_TEST_SEQUENTIAL_SPECS';
export const STORAGE_STATE_VARIABLE = 'SILLYBUNNY_TEST_STORAGE_STATE';
export const WORKER_HANDLE_VARIABLE = 'SILLYBUNNY_TEST_WORKER_HANDLE';
export const READY_MESSAGE = 'SillyBunny test servers are ready';
export const DEFAULT_SERVER_COUNT = 1;
export const DEFAULT_USER_HANDLE = 'default-user';
export const STORAGE_DIRECTORY = '_e2e-storage';

const BASE_URL_VARIABLES = ['SILLYBUNNY_TEST_BASE_URL', 'ST_BASE_URL', 'PLAYWRIGHT_BASE_URL'];
const MAINTAINER_PORT = 4444;
// A server handles its requests on one main thread. Against one server, more workers than this add timeouts
// and no speed.
const SINGLE_SERVER_WORKERS = 16;
const WORKERS_PER_SERVER = 8;
const RUNTIMES = ['bun', 'node'];
const SEQUENTIAL_MODE = /describe\.configure\(\s*\{[^}]*\bmode:\s*['"](?:serial|default)['"]|describe\.serial\(/;
// Playwright writes and removes its output folders while tests run, so the search must not enter them.
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'test-results', 'playwright-report']);
/**
 * Folders of the tests directory that the default suite does not run: `foundation/` runs under its own config and `audit/`
 * under the audit config. A project replaces the config's `testIgnore` instead of adding to it, so the projects carry these.
 */
export const SUITE_IGNORED_DIRECTORIES = Object.freeze(['foundation', 'audit']);
export const SUITE_IGNORE = Object.freeze(SUITE_IGNORED_DIRECTORIES.map(name => `**/${name}/**`));

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(testsDirectory, '..');

/**
 * Gets the number of servers that the config starts.
 * Without a base URL variable, defaults to one managed server on a free port so tests never touch port 4444.
 * Set `SILLYBUNNY_TEST_SERVERS=0` or a base URL variable to use a server that runs already.
 * @param {NodeJS.ProcessEnv} env Environment variables
 * @returns {number} 0 when the tests use one server that runs already
 */
export function getServerCount(env) {
    if (BASE_URL_VARIABLES.some(name => env[name])) {
        return 0;
    }
    const value = env[SERVER_COUNT_VARIABLE];
    if (value === undefined || value === '') {
        return DEFAULT_SERVER_COUNT;
    }
    if (value === '0') {
        return 0;
    }
    if (!/^[1-9]\d*$/.test(value)) {
        throw new Error(`${SERVER_COUNT_VARIABLE} must be a whole number of 0 or more, not "${value}".`);
    }
    return Number(value);
}

/**
 * Checks whether managed test servers isolate parallel workers in separate user accounts.
 * @param {NodeJS.ProcessEnv} env Environment variables
 * @param {boolean} startsServers Whether the config starts the servers
 * @returns {boolean}
 */
export function isAccountIsolationEnabled(env, startsServers) {
    if (!startsServers) {
        return false;
    }
    const value = env[ACCOUNT_ISOLATION_VARIABLE];
    if (value === undefined || value === '' || value === '1') {
        return true;
    }
    if (value === '0') {
        return false;
    }
    throw new Error(`${ACCOUNT_ISOLATION_VARIABLE} must be "0" or "1", not "${value}".`);
}

/**
 * Gets the user account handle assigned to a parallel worker index.
 * @param {number} parallelIndex Parallel index of the worker
 * @returns {string}
 */
export function getWorkerAccountHandle(parallelIndex) {
    return `worker-${parallelIndex}`;
}

/**
 * Gets the storage-state JSON path inside a managed server's scratch data root.
 * @param {{ dataRoot: string }} server Managed server entry
 * @param {number} parallelIndex Parallel index of the worker
 * @param {{ isolateAccounts?: boolean }} [options]
 * @returns {string}
 */
export function getWorkerStorageStatePath(server, parallelIndex, { isolateAccounts = true } = {}) {
    const fileName = isolateAccounts ? `${getWorkerAccountHandle(parallelIndex)}.json` : `${DEFAULT_USER_HANDLE}.json`;
    return path.join(server.dataRoot, STORAGE_DIRECTORY, fileName);
}

/**
 * Gets the number of workers when the command line does not set one.
 * @param {number} serverCount Servers that the config starts, or 0 for one server that runs already
 * @param {number} cpuCount Logical CPUs of the machine
 * @returns {number}
 */
export function getDefaultWorkers(serverCount, cpuCount) {
    const servers = Math.max(serverCount, 1);
    const perServer = servers > 1 ? WORKERS_PER_SERVER : SINGLE_SERVER_WORKERS;
    return Math.max(1, Math.min(servers * perServer, Math.floor(cpuCount / 2)));
}

/**
 * Gets the server of a worker. A worker that replaces a failed one keeps the parallel index, so it keeps the server.
 * @param {{ url: string }[]} servers Servers that the config started
 * @param {number} parallelIndex Parallel index of the worker
 * @returns {string} Base URL of the server
 */
export function getServerUrl(servers, parallelIndex) {
    return servers[parallelIndex % servers.length].url;
}

/**
 * Gets the headers that the browser adds to every request.
 *
 * Response compression is the largest server cost of an app boot, and it saves no time on a loopback connection.
 * So the browser asks for uncompressed responses when many workers share the servers that the config starts. Runs
 * against a server that runs already keep compression, because real browsers always ask for it, and the release
 * tests must cover it. SILLYBUNNY_TEST_COMPRESSION=1 or 0 sets it for any run.
 * @param {NodeJS.ProcessEnv} env Environment variables
 * @param {boolean} startsServers Whether the config starts the servers
 * @returns {Record<string, string>}
 */
export function getRequestHeaders(env, startsServers) {
    const setting = env[COMPRESSION_VARIABLE];
    const compress = setting === '1' || (setting !== '0' && !startsServers);
    return compress ? {} : { 'Accept-Encoding': 'identity' };
}

/**
 * Gets the runtime that starts the servers.
 * @param {NodeJS.ProcessEnv} env Environment variables
 * @returns {'bun' | 'node'}
 */
export function getServerRuntime(env) {
    const runtime = env[SERVER_RUNTIME_VARIABLE] || 'bun';
    if (!RUNTIMES.includes(runtime)) {
        throw new Error(`${SERVER_RUNTIME_VARIABLE} must be "bun" or "node", not "${runtime}".`);
    }
    return runtime;
}

/**
 * Gets the program and arguments that start one server. No shell runs them, so no character in a path needs quoting.
 * @param {NodeJS.ProcessEnv} env Environment variables
 * @param {{ port: number, dataRoot: string }} server Port and data root of the server
 * @returns {{ command: string, args: string[] }}
 */
export function getServerCommand(env, { port, dataRoot }) {
    const args = [
        'server.js', '--browserLaunchEnabled=false', '--port', String(port), '--dataRoot', dataRoot,
        // The default config file is in the repository root. It holds the settings of the developer's own server,
        // and a server writes it there when it is absent.
        '--configPath', path.join(dataRoot, 'config.yaml'),
    ];
    return getServerRuntime(env) === 'node'
        ? { command: process.execPath, args: ['--no-warnings', ...args] }
        : { command: 'bun', args };
}

/**
 * Finds the spec files that run some of their tests one after another in one worker.
 * @param {string} directory Directory to search
 * @returns {string[]} Paths relative to the directory, with forward slashes
 */
export function findSequentialSpecs(directory) {
    const specs = [];
    const walk = relative => {
        let entries;
        try {
            entries = fs.readdirSync(path.join(directory, relative), { withFileTypes: true });
        } catch (error) {
            // Another run in the same checkout can remove a folder during the search.
            if (error.code === 'ENOENT') {
                return;
            }
            throw error;
        }
        for (const entry of entries) {
            const file = relative ? `${relative}/${entry.name}` : entry.name;
            const ignoredBySuite = !relative && SUITE_IGNORED_DIRECTORIES.includes(entry.name);
            if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name) && !ignoredBySuite && !entry.name.startsWith('.')) {
                walk(file);
            } else if (entry.isFile() && entry.name.endsWith('.e2e.js')) {
                specs.push(file);
            }
        }
    };
    walk('');
    return specs.filter(file => SEQUENTIAL_MODE.test(fs.readFileSync(path.join(directory, file), 'utf8'))).sort();
}

/**
 * Gets projects that dispatch the sequential spec files first. Playwright dispatches the files in name order. A long
 * sequential file late in that order starts late, and the run then waits for it at the end.
 * @param {string[]} sequentialSpecs Paths relative to the tests directory
 * @returns {object[] | undefined}
 */
export function getProjects(sequentialSpecs) {
    if (!sequentialSpecs.length) {
        return undefined;
    }
    const escaped = sequentialSpecs.map(file => file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]'));
    const pattern = new RegExp(`(^|[\\\\/])(${escaped.join('|')})$`);
    return [
        { name: 'sequential', testMatch: pattern, testIgnore: [...SUITE_IGNORE] },
        { name: 'parallel', testIgnore: [pattern, ...SUITE_IGNORE] },
    ];
}

/**
 * Checks whether the first run of a server account is over and Welcome will not reopen on the next boot.
 * @param {string} dataRoot Data root of the server
 * @param {string} [handle] User account handle
 * @returns {boolean}
 */
export function isFirstRunOver(dataRoot, handle = DEFAULT_USER_HANDLE) {
    try {
        const settings = JSON.parse(fs.readFileSync(path.join(dataRoot, handle, 'settings.json'), 'utf8'));
        return !settings.firstRun && settings.accountStorage?.WelcomePage_ShowAtStartup !== 'true';
    } catch {
        // The server can save during this read, so the read can fail or get a part of the file.
        return false;
    }
}

/**
 * Waits until the first run of a server account is over, and fails when the time limit ends first.
 * @param {string} dataRoot Data root of the server
 * @param {{ handle?: string, timeoutMs?: number, intervalMs?: number }} [options] Account handle, time limit, and poll interval
 * @returns {Promise<void>}
 */
export async function waitUntilFirstRunIsOver(dataRoot, { handle = DEFAULT_USER_HANDLE, timeoutMs = 60_000, intervalMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (!isFirstRunOver(dataRoot, handle)) {
        if (Date.now() >= deadline) {
            throw new Error(`The server did not store the end of its first run in ${path.join(dataRoot, handle, 'settings.json')} within ${timeoutMs / 1000} s.`);
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

/**
 * Removes the storage-state folder of each managed server. Safe to run in globalTeardown while servers still run.
 * @param {{ dataRoot: string }[]} servers Managed servers
 */
export function removeStorageDirectories(servers) {
    for (const server of servers) {
        const directory = path.join(server.dataRoot, STORAGE_DIRECTORY);
        if (!fs.existsSync(directory)) {
            continue;
        }
        try {
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch (error) {
            console.warn(`Could not remove the test storage state directory ${directory}: ${error.message}`);
        }
    }
}

/**
 * Removes the throwaway data root of each managed server.
 * @param {{ dataRoot: string }[]} servers Managed servers
 */
export function cleanupServerDataRoots(servers) {
    for (const server of servers) {
        if (!fs.existsSync(server.dataRoot)) {
            continue;
        }
        try {
            // Windows releases the files of a stopped server with a delay.
            fs.rmSync(server.dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch (error) {
            console.warn(`Could not remove the test data root ${server.dataRoot}: ${error.message}`);
        }
    }
}

/**
 * Finds free ports other than the maintainer's default port. All of them are held open together, so no port is returned twice.
 * @param {number} count Number of ports
 * @returns {Promise<number[]>}
 */
async function findFreePorts(count) {
    const listeners = [];
    const discarded = [];
    try {
        while (listeners.length < count) {
            const listener = await new Promise((resolve, reject) => {
                const candidate = net.createServer();
                candidate.once('error', reject);
                candidate.listen(0, '127.0.0.1', () => resolve(candidate));
            });
            if (listener.address().port === MAINTAINER_PORT) {
                discarded.push(listener);
            } else {
                listeners.push(listener);
            }
        }
        return listeners.map(listener => listener.address().port);
    } finally {
        await Promise.all([...listeners, ...discarded].map(listener => new Promise(resolve => listener.close(resolve))));
    }
}

/**
 * Chooses a port and a throwaway data root for each server, and writes an isolated config.yaml when accounts are enabled.
 * @param {number} count Number of servers
 * @param {{ isolateAccounts?: boolean }} [options]
 * @returns {Promise<{ url: string, port: number, dataRoot: string }[]>}
 */
async function createServerList(count, { isolateAccounts = true } = {}) {
    const ports = await findFreePorts(count);
    const servers = ports.map(port => {
        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-test-data-'));
        if (isolateAccounts) {
            // initConfig() merges default/config.yaml around any key already present in this scratch config.
            fs.writeFileSync(path.join(dataRoot, 'config.yaml'), 'enableUserAccounts: true\n');
        }
        return {
            url: `http://127.0.0.1:${port}`,
            port,
            dataRoot,
        };
    });
    // Playwright stops the servers after globalTeardown, so the data roots are removed when the process exits.
    process.on('exit', () => cleanupServerDataRoots(servers));
    return servers;
}

/**
 * Gets the SillyBunny parts of the Playwright config.
 *
 * With a base URL variable set (or `SILLYBUNNY_TEST_SERVERS=0`), the tests use that server. Otherwise the config
 * starts one managed server (or `SILLYBUNNY_TEST_SERVERS=N` servers) on free ports with throwaway data roots, enables
 * per-worker user accounts by default (`SILLYBUNNY_TEST_ISOLATE_ACCOUNTS=0` opts out), and spreads workers over them.
 *
 * Playwright imports the config again in each worker process after it sets TEST_PARALLEL_INDEX, so a worker reads
 * its server and storage state here. Test helpers that read SILLYBUNNY_TEST_BASE_URL or SILLYBUNNY_TEST_STORAGE_STATE
 * when they load get the same server and account.
 * @param {NodeJS.ProcessEnv} [env] Environment variables
 * @returns {Promise<{ workers: number, use: object, config: object }>}
 */
export async function getServerConfig(env = process.env) {
    const cpuCount = os.cpus().length;
    // Only Playwright gives a worker its index. An empty value comes from the shell that started the run, and a
    // main process that took it for an index would start no server.
    const parallelIndex = env.TEST_PARALLEL_INDEX || undefined;
    const getUse = startsServers => {
        const headers = getRequestHeaders(env, startsServers);
        return Object.keys(headers).length ? { extraHTTPHeaders: headers } : {};
    };

    let servers = env[SERVER_LIST_VARIABLE] ? JSON.parse(env[SERVER_LIST_VARIABLE]) : null;
    if (!servers) {
        const count = parallelIndex === undefined ? getServerCount(env) : 0;
        if (count === 0) {
            const hasExplicitBaseUrl = BASE_URL_VARIABLES.some(name => env[name]);
            if (parallelIndex === undefined && hasExplicitBaseUrl && env[SERVER_COUNT_VARIABLE] && env[SERVER_COUNT_VARIABLE] !== '0') {
                console.warn(`${SERVER_COUNT_VARIABLE} has no effect, because a base URL variable names a server.`);
            }
            return { workers: getDefaultWorkers(0, cpuCount), use: getUse(false), config: {} };
        }
        getServerRuntime(env);
        const isolateAccounts = isAccountIsolationEnabled(env, true);
        servers = await createServerList(count, { isolateAccounts });
        env[SERVER_LIST_VARIABLE] = JSON.stringify(servers);
    }

    const isolateAccounts = isAccountIsolationEnabled(env, true);
    const use = getUse(true);
    if (parallelIndex === undefined) {
        // The main process runs no test. A worker that did not import the config again has no base URL, so it
        // fails at its first navigation. It does not use the server of another worker.
        use.baseURL = undefined;
        use.storageState = undefined;
    } else {
        const workerIndex = Number(parallelIndex);
        const server = servers[workerIndex % servers.length];
        use.baseURL = server.url;
        use.storageState = getWorkerStorageStatePath(server, workerIndex, { isolateAccounts });
        env.SILLYBUNNY_TEST_BASE_URL = use.baseURL;
        env[STORAGE_STATE_VARIABLE] = use.storageState;
        if (isolateAccounts) {
            env[WORKER_HANDLE_VARIABLE] = getWorkerAccountHandle(workerIndex);
        }
    }

    // The main process searches once, and the workers take its result.
    if (!env[SEQUENTIAL_SPECS_VARIABLE]) {
        env[SEQUENTIAL_SPECS_VARIABLE] = JSON.stringify(findSequentialSpecs(testsDirectory));
    }
    const projects = getProjects(JSON.parse(env[SEQUENTIAL_SPECS_VARIABLE]));
    return {
        workers: getDefaultWorkers(servers.length, cpuCount),
        use,
        config: {
            ...(projects && { projects }),
            globalSetup: path.join(testsDirectory, 'e2e-servers-prime.js'),
            globalTeardown: path.join(testsDirectory, 'e2e-servers-teardown.js'),
            webServer: {
                command: `"${process.execPath}" "${path.join(testsDirectory, 'e2e-servers-launch.js')}"`,
                cwd: repositoryDirectory,
                name: 'test servers',
                wait: { stdout: new RegExp(READY_MESSAGE) },
                timeout: 150_000,
                stdout: 'ignore',
                stderr: 'pipe',
                env: { SILLYBUNNY_LAUNCHER: '1', SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH: '1', NODE_NO_WARNINGS: '1' },
            },
        },
    };
}
