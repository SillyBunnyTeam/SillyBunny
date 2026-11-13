import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_COUNT_VARIABLE = 'SILLYBUNNY_TEST_SERVERS';
export const SERVER_RUNTIME_VARIABLE = 'SILLYBUNNY_TEST_SERVER_RUNTIME';
export const COMPRESSION_VARIABLE = 'SILLYBUNNY_TEST_COMPRESSION';
// The main process writes the servers here before it starts any worker, and each worker inherits it.
export const SERVER_LIST_VARIABLE = 'SILLYBUNNY_TEST_SERVER_LIST';
export const SEQUENTIAL_SPECS_VARIABLE = 'SILLYBUNNY_TEST_SEQUENTIAL_SPECS';
export const READY_MESSAGE = 'SillyBunny test servers are ready';

const BASE_URL_VARIABLES = ['SILLYBUNNY_TEST_BASE_URL', 'ST_BASE_URL', 'PLAYWRIGHT_BASE_URL'];
// A server handles its requests on one main thread. Against one server, more workers than this add timeouts
// and no speed.
const SINGLE_SERVER_WORKERS = 16;
const WORKERS_PER_SERVER = 8;
const RUNTIMES = ['bun', 'node'];
const SEQUENTIAL_MODE = /describe\.configure\(\s*\{[^}]*\bmode:\s*['"](?:serial|default)['"]|describe\.serial\(/;
// Playwright writes and removes its output folders while tests run, so the search must not enter them.
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'test-results', 'playwright-report']);
// A fresh data root has one account, and the server keeps its settings here.
const SETTINGS_FILE = path.join('default-user', 'settings.json');

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(testsDirectory, '..');

/**
 * Gets the number of servers that the config starts.
 * @param {NodeJS.ProcessEnv} env Environment variables
 * @returns {number} 0 when the tests use one server that runs already
 */
export function getServerCount(env) {
    if (BASE_URL_VARIABLES.some(name => env[name])) {
        return 0;
    }
    const value = env[SERVER_COUNT_VARIABLE];
    if (value === undefined || value === '') {
        return 0;
    }
    if (!/^[1-9]\d*$/.test(value)) {
        throw new Error(`${SERVER_COUNT_VARIABLE} must be a whole number of 1 or more, not "${value}".`);
    }
    return Number(value);
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
            if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
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
        { name: 'sequential', testMatch: pattern },
        { name: 'parallel', testIgnore: pattern },
    ];
}

/**
 * Checks whether the first run of a server is over. The app shows its first-run prompt at every boot until the
 * stored settings say so.
 * @param {string} dataRoot Data root of the server
 * @returns {boolean}
 */
export function isFirstRunOver(dataRoot) {
    try {
        return !JSON.parse(fs.readFileSync(path.join(dataRoot, SETTINGS_FILE), 'utf8')).firstRun;
    } catch {
        // The server can save during this read, so the read can fail or get a part of the file.
        return false;
    }
}

/**
 * Waits until the first run of a server is over, and fails when the time limit ends first.
 * @param {string} dataRoot Data root of the server
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options] Time limit, and time between two checks
 * @returns {Promise<void>}
 */
export async function waitUntilFirstRunIsOver(dataRoot, { timeoutMs = 60_000, intervalMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (!isFirstRunOver(dataRoot)) {
        if (Date.now() >= deadline) {
            throw new Error(`The server did not store the end of its first run in ${path.join(dataRoot, SETTINGS_FILE)} within ${timeoutMs / 1000} s.`);
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

/**
 * Finds free ports. All of them are held open together, so that no port is returned twice.
 * @param {number} count Number of ports
 * @returns {Promise<number[]>}
 */
async function findFreePorts(count) {
    const listeners = await Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
        const listener = net.createServer();
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => resolve(listener));
    })));
    const ports = listeners.map(listener => listener.address().port);
    await Promise.all(listeners.map(listener => new Promise(resolve => listener.close(resolve))));
    return ports;
}

/**
 * Chooses a port and a throwaway data root for each server.
 * @param {number} count Number of servers
 * @returns {Promise<{ url: string, port: number, dataRoot: string }[]>}
 */
async function createServerList(count) {
    const ports = await findFreePorts(count);
    const servers = ports.map(port => ({
        url: `http://127.0.0.1:${port}`,
        port,
        dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-test-data-')),
    }));
    // Playwright stops the servers after globalTeardown, so the data roots are removed only when the process exits.
    process.on('exit', () => {
        for (const server of servers) {
            try {
                // Windows releases the files of a stopped server with a delay.
                fs.rmSync(server.dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            } catch (error) {
                console.warn(`Could not remove the test data root ${server.dataRoot}: ${error.message}`);
            }
        }
    });
    return servers;
}

/**
 * Gets the SillyBunny parts of the Playwright config.
 *
 * With a base URL variable set, the tests use that server. Otherwise SILLYBUNNY_TEST_SERVERS=N starts N servers,
 * each on its own port with a throwaway data root, and each worker uses one of them. Without either, the tests use
 * the server at the default base URL.
 *
 * Playwright imports the config again in each worker process after it sets TEST_PARALLEL_INDEX, so a worker reads
 * its server here. Test helpers that read SILLYBUNNY_TEST_BASE_URL when they load get the same server.
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
            if (parallelIndex === undefined && env[SERVER_COUNT_VARIABLE]) {
                console.warn(`${SERVER_COUNT_VARIABLE} has no effect, because a base URL variable names a server.`);
            }
            return { workers: getDefaultWorkers(0, cpuCount), use: getUse(false), config: {} };
        }
        getServerRuntime(env);
        servers = await createServerList(count);
        env[SERVER_LIST_VARIABLE] = JSON.stringify(servers);
    }

    const use = getUse(true);
    if (parallelIndex === undefined) {
        // The main process runs no test. A worker that did not import the config again has no base URL, so it
        // fails at its first navigation. It does not use the server of another worker.
        use.baseURL = undefined;
    } else {
        use.baseURL = getServerUrl(servers, Number(parallelIndex));
        env.SILLYBUNNY_TEST_BASE_URL = use.baseURL;
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
