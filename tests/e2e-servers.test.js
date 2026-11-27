import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    ACCOUNT_ISOLATION_VARIABLE,
    DEFAULT_SERVER_COUNT,
    DEFAULT_USER_HANDLE,
    READY_MESSAGE,
    SEQUENTIAL_SPECS_VARIABLE,
    SERVER_LIST_VARIABLE,
    STORAGE_DIRECTORY,
    STORAGE_STATE_VARIABLE,
    WORKER_HANDLE_VARIABLE,
    cleanupServerDataRoots,
    findSequentialSpecs,
    getDefaultWorkers,
    getProjects,
    getRequestHeaders,
    getServerCommand,
    getServerConfig,
    getServerCount,
    getServerUrl,
    getWorkerAccountHandle,
    getWorkerStorageStatePath,
    isAccountIsolationEnabled,
    isFirstRunOver,
    removeStorageDirectories,
    waitUntilFirstRunIsOver,
} from './e2e-servers.js';

const SERVERS = [
    { url: 'http://127.0.0.1:5001', port: 5001, dataRoot: '/tmp/sillybunny-test-data-a' },
    { url: 'http://127.0.0.1:5002', port: 5002, dataRoot: '/tmp/sillybunny-test-data-b' },
    { url: 'http://127.0.0.1:5003', port: 5003, dataRoot: '/tmp/sillybunny-test-data-c' },
];

describe('e2e servers', () => {
    test('defaults to one managed server when no base URL is set, and honours explicit overrides', () => {
        expect(getServerCount({})).toBe(DEFAULT_SERVER_COUNT);
        expect(getServerCount({ SILLYBUNNY_TEST_SERVERS: '' })).toBe(DEFAULT_SERVER_COUNT);
        expect(getServerCount({ SILLYBUNNY_TEST_SERVERS: '0' })).toBe(0);
        expect(getServerCount({ SILLYBUNNY_TEST_SERVERS: '8' })).toBe(8);
        expect(getServerCount({ SILLYBUNNY_TEST_SERVERS: '8', SILLYBUNNY_TEST_BASE_URL: 'http://127.0.0.1:4444' })).toBe(0);
        expect(getServerCount({ SILLYBUNNY_TEST_SERVERS: '8', ST_BASE_URL: 'http://127.0.0.1:4444' })).toBe(0);
        expect(getServerCount({ SILLYBUNNY_TEST_SERVERS: '8', PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:4444' })).toBe(0);
        expect(getServerCount({ SILLYBUNNY_TEST_BASE_URL: 'http://127.0.0.1:4444' })).toBe(0);
    });

    test.each(['-1', '1.5', 'eight', '1e1', '0x8', ' 3 ', '08', '00'])('refuses %p servers', value => {
        expect(() => getServerCount({ SILLYBUNNY_TEST_SERVERS: value })).toThrow('SILLYBUNNY_TEST_SERVERS');
    });

    test('enables per-worker account isolation by default on managed servers and allows opting out', () => {
        expect(isAccountIsolationEnabled({}, true)).toBe(true);
        expect(isAccountIsolationEnabled({ [ACCOUNT_ISOLATION_VARIABLE]: '' }, true)).toBe(true);
        expect(isAccountIsolationEnabled({ [ACCOUNT_ISOLATION_VARIABLE]: '1' }, true)).toBe(true);
        expect(isAccountIsolationEnabled({ [ACCOUNT_ISOLATION_VARIABLE]: '0' }, true)).toBe(false);
        expect(isAccountIsolationEnabled({}, false)).toBe(false);
        expect(isAccountIsolationEnabled({ [ACCOUNT_ISOLATION_VARIABLE]: '1' }, false)).toBe(false);
        expect(() => isAccountIsolationEnabled({ [ACCOUNT_ISOLATION_VARIABLE]: 'yes' }, true)).toThrow(ACCOUNT_ISOLATION_VARIABLE);
    });

    test('assigns deterministic account handles and storage-state paths inside the scratch data root', () => {
        expect(getWorkerAccountHandle(0)).toBe('worker-0');
        expect(getWorkerAccountHandle(3)).toBe('worker-3');
        expect(getWorkerStorageStatePath(SERVERS[0], 2, { isolateAccounts: true })).toBe(
            path.join(SERVERS[0].dataRoot, STORAGE_DIRECTORY, 'worker-2.json'),
        );
        expect(getWorkerStorageStatePath(SERVERS[0], 2, { isolateAccounts: false })).toBe(
            path.join(SERVERS[0].dataRoot, STORAGE_DIRECTORY, `${DEFAULT_USER_HANDLE}.json`),
        );
    });

    test.each([
        [0, 128, 16],
        [0, 16, 8],
        [0, 1, 1],
        [1, 128, 16],
        [2, 128, 16],
        [8, 128, 64],
        [8, 16, 8],
    ])('with %p servers and %p CPUs, uses %p workers', (servers, cpus, workers) => {
        expect(getDefaultWorkers(servers, cpus)).toBe(workers);
    });

    test('gives each parallel index a server, and the same one to a replacement worker', () => {
        expect([0, 1, 2, 3, 4, 5, 6].map(index => getServerUrl(SERVERS, index))).toEqual([
            SERVERS[0].url, SERVERS[1].url, SERVERS[2].url,
            SERVERS[0].url, SERVERS[1].url, SERVERS[2].url,
            SERVERS[0].url,
        ]);
    });

    test('asks for uncompressed responses only from the servers that the config starts, unless told otherwise', () => {
        const identity = { 'Accept-Encoding': 'identity' };
        expect(getRequestHeaders({}, true)).toEqual(identity);
        expect(getRequestHeaders({}, false)).toEqual({});
        expect(getRequestHeaders({ SILLYBUNNY_TEST_COMPRESSION: '1' }, true)).toEqual({});
        expect(getRequestHeaders({ SILLYBUNNY_TEST_COMPRESSION: '0' }, false)).toEqual(identity);
    });

    test('starts a server with Bun, or with Node.js when asked, without a shell', () => {
        const server = { port: 5001, dataRoot: '/tmp/sillybunny test $data' };
        const args = [
            'server.js', '--browserLaunchEnabled=false', '--port', '5001', '--dataRoot', '/tmp/sillybunny test $data',
            '--configPath', path.join('/tmp/sillybunny test $data', 'config.yaml'),
        ];
        expect(getServerCommand({}, server)).toEqual({ command: 'bun', args });
        expect(getServerCommand({ SILLYBUNNY_TEST_SERVER_RUNTIME: 'node' }, server)).toEqual({ command: process.execPath, args: ['--no-warnings', ...args] });
        expect(() => getServerCommand({ SILLYBUNNY_TEST_SERVER_RUNTIME: 'deno' }, server)).toThrow('SILLYBUNNY_TEST_SERVER_RUNTIME');
    });

    test('refuses an unknown runtime or account isolation value before it starts any server', async () => {
        await expect(getServerConfig({ SILLYBUNNY_TEST_SERVERS: '2', SILLYBUNNY_TEST_SERVER_RUNTIME: 'deno' })).rejects.toThrow('SILLYBUNNY_TEST_SERVER_RUNTIME');
        await expect(getServerConfig({ [ACCOUNT_ISOLATION_VARIABLE]: 'nope' })).rejects.toThrow(ACCOUNT_ISOLATION_VARIABLE);
    });

    test('starts a managed server on a free port with accounts enabled when no env vars are set', async () => {
        const env = {};
        let servers = [];
        try {
            const config = await getServerConfig(env);
            servers = JSON.parse(env[SERVER_LIST_VARIABLE] ?? '[]');

            expect(servers).toHaveLength(1);
            expect(servers[0].port).not.toBe(4444);
            expect(fs.readFileSync(path.join(servers[0].dataRoot, 'config.yaml'), 'utf8')).toContain('enableUserAccounts: true');
            expect(config.config.webServer.command).toContain('e2e-servers-launch.js');
            expect(config.config.globalSetup).toContain('e2e-servers-prime.js');
            expect(config.config.globalTeardown).toContain('e2e-servers-teardown.js');
            expect(Object.hasOwn(config.use, 'baseURL')).toBe(true);
            expect(config.use.baseURL).toBeUndefined();
            expect(Object.hasOwn(config.use, 'storageState')).toBe(true);
            expect(config.use.storageState).toBeUndefined();
        } finally {
            cleanupServerDataRoots(servers);
        }
    });

    test('does not pre-enable user accounts in scratch config when account isolation is opted out', async () => {
        const env = { [ACCOUNT_ISOLATION_VARIABLE]: '0' };
        let servers = [];
        try {
            await getServerConfig(env);
            servers = JSON.parse(env[SERVER_LIST_VARIABLE] ?? '[]');

            expect(servers).toHaveLength(1);
            expect(fs.existsSync(path.join(servers[0].dataRoot, 'config.yaml'))).toBe(false);
        } finally {
            cleanupServerDataRoots(servers);
        }
    });

    test('leaves the base URL alone and starts nothing for one server that runs already', async () => {
        for (const env of [
            { SILLYBUNNY_TEST_SERVERS: '8', SILLYBUNNY_TEST_BASE_URL: 'http://127.0.0.1:4444' },
            { SILLYBUNNY_TEST_SERVERS: '0' },
        ]) {
            const config = await getServerConfig(env);

            expect(config.config).toEqual({});
            expect(config.use).toEqual({});
            expect(config.workers).toBe(getDefaultWorkers(0, os.cpus().length));
            expect(env[SERVER_LIST_VARIABLE]).toBeUndefined();
        }
    });

    test('routes a worker to its server and isolated account storage state', async () => {
        const env = { [SERVER_LIST_VARIABLE]: JSON.stringify(SERVERS), TEST_PARALLEL_INDEX: '4' };
        const config = await getServerConfig(env);
        const expectedState = getWorkerStorageStatePath(SERVERS[1], 4, { isolateAccounts: true });

        expect(config.use.baseURL).toBe(SERVERS[1].url);
        expect(config.use.storageState).toBe(expectedState);
        expect(config.use.extraHTTPHeaders).toEqual({ 'Accept-Encoding': 'identity' });
        expect(env.SILLYBUNNY_TEST_BASE_URL).toBe(SERVERS[1].url);
        expect(env[STORAGE_STATE_VARIABLE]).toBe(expectedState);
        expect(env[WORKER_HANDLE_VARIABLE]).toBe('worker-4');
        expect(config.config.webServer.command).toContain('e2e-servers-launch.js');
        expect(config.config.webServer.wait.stdout.test(READY_MESSAGE)).toBe(true);
        expect(config.config.globalTeardown).toContain('e2e-servers-teardown.js');
    });

    test('uses the shared default-user storage state when a worker opts out of account isolation', async () => {
        const env = {
            [SERVER_LIST_VARIABLE]: JSON.stringify(SERVERS),
            [ACCOUNT_ISOLATION_VARIABLE]: '0',
            TEST_PARALLEL_INDEX: '2',
        };
        const config = await getServerConfig(env);
        const expectedState = getWorkerStorageStatePath(SERVERS[2], 2, { isolateAccounts: false });

        expect(config.use.storageState).toBe(expectedState);
        expect(env[STORAGE_STATE_VARIABLE]).toBe(expectedState);
        expect(env[WORKER_HANDLE_VARIABLE]).toBeUndefined();
    });

    test('finds the spec files that run tests one after another', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-sequential-specs-'));
        try {
            const files = {
                'serial.e2e.js': 'test.describe.configure({ mode: \'serial\' });',
                'default.e2e.js': 'test.describe.configure({ retries: 1, mode: "default" });',
                'old-serial.e2e.js': 'test.describe.serial(\'a\', () => {});',
                'parallel.e2e.js': 'test.describe.configure({ mode: \'parallel\' });',
                'plain.e2e.js': 'test(\'a\', () => {});',
                'nested/serial.e2e.js': 'test.describe.configure({ mode: \'serial\' });',
                'audit/serial.e2e.js': 'test.describe.configure({ mode: \'serial\' });',
                'foundation/serial.e2e.js': 'test.describe.configure({ mode: \'serial\' });',
                'serial.test.js': 'test.describe.configure({ mode: \'serial\' });',
                'node_modules/dependency/serial.e2e.js': 'test.describe.configure({ mode: \'serial\' });',
                'test-results/copy/serial.e2e.js': 'test.describe.configure({ mode: \'serial\' });',
                'playwright-report/serial.e2e.js': 'test.describe.configure({ mode: \'serial\' });',
                '.cache/serial.e2e.js': 'test.describe.configure({ mode: \'serial\' });',
            };
            for (const [file, text] of Object.entries(files)) {
                fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
                fs.writeFileSync(path.join(directory, file), text);
            }

            expect(findSequentialSpecs(directory)).toEqual(['default.e2e.js', 'nested/serial.e2e.js', 'old-serial.e2e.js', 'serial.e2e.js']);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('puts the sequential spec files in a project that is dispatched first', () => {
        expect(getProjects([])).toBeUndefined();

        const [sequential, parallel] = getProjects(['nanogpt-controls.e2e.js', 'frontend/chain.e2e.js']);
        const matches = file => sequential.testMatch.test(file);
        expect(matches('/repo/tests/nanogpt-controls.e2e.js')).toBe(true);
        expect(matches('/repo/tests/frontend/chain.e2e.js')).toBe(true);
        expect(matches('C:\\repo\\tests\\frontend\\chain.e2e.js')).toBe(true);
        expect(matches('/repo/tests/not-nanogpt-controls.e2e.js')).toBe(false);
        expect(matches('/repo/tests/nanogpt-controlsXe2e.js')).toBe(false);
        expect(parallel.testIgnore[0]).toBe(sequential.testMatch);
        // A project's testIgnore replaces the config's, so both keep the folders the suite does not run.
        for (const project of [sequential, parallel]) {
            expect(project.testIgnore).toEqual(expect.arrayContaining(['**/foundation/**', '**/audit/**']));
        }
    });

    test('gives a worker the sequential spec files that the main process found, without a search of its own', async () => {
        const env = {
            [SERVER_LIST_VARIABLE]: JSON.stringify(SERVERS),
            [SEQUENTIAL_SPECS_VARIABLE]: JSON.stringify(['only-this.e2e.js']),
            TEST_PARALLEL_INDEX: '0',
        };
        const [sequential] = (await getServerConfig(env)).config.projects;

        expect(sequential.testMatch.test('/repo/tests/only-this.e2e.js')).toBe(true);
        expect(sequential.testMatch.test('/repo/tests/nanogpt-controls.e2e.js')).toBe(false);
    });

    test('gives the main process no base URL, so a worker without its own config import fails loudly', async () => {
        const config = await getServerConfig({ [SERVER_LIST_VARIABLE]: JSON.stringify(SERVERS) });

        expect(Object.hasOwn(config.use, 'baseURL')).toBe(true);
        expect(config.use.baseURL).toBeUndefined();
        expect(config.workers).toBe(getDefaultWorkers(SERVERS.length, os.cpus().length));
    });

    test('starts the servers in a main process that inherits an empty parallel index', async () => {
        const env = { SILLYBUNNY_TEST_SERVERS: '1', TEST_PARALLEL_INDEX: '' };
        let servers = [];
        try {
            const config = await getServerConfig(env);
            servers = JSON.parse(env[SERVER_LIST_VARIABLE] ?? '[]');

            expect(servers).toHaveLength(1);
            expect(config.config.webServer.command).toContain('e2e-servers-launch.js');
            expect(Object.hasOwn(config.use, 'baseURL')).toBe(true);
            expect(config.use.baseURL).toBeUndefined();
            expect(env.SILLYBUNNY_TEST_BASE_URL).toBeUndefined();
        } finally {
            cleanupServerDataRoots(servers);
        }
    });

    test('cleans up storage-state directories and scratch data roots', () => {
        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-cleanup-'));
        const storageDir = path.join(dataRoot, STORAGE_DIRECTORY);
        fs.mkdirSync(storageDir, { recursive: true });
        fs.writeFileSync(path.join(storageDir, 'worker-0.json'), '{"cookies":[],"origins":[]}');
        fs.writeFileSync(path.join(dataRoot, 'config.yaml'), 'enableUserAccounts: true\n');

        removeStorageDirectories([{ dataRoot }]);
        expect(fs.existsSync(storageDir)).toBe(false);
        expect(fs.existsSync(path.join(dataRoot, 'config.yaml'))).toBe(true);

        cleanupServerDataRoots([{ dataRoot }]);
        expect(fs.existsSync(dataRoot)).toBe(false);
        expect(() => cleanupServerDataRoots([{ dataRoot }])).not.toThrow();
    });

    test('default, WebKit and Firefox Playwright configs retain traces on failure and inherit managed servers', async () => {
        const { default: baseConfig } = await import('./playwright.config.js');
        const { default: webkitConfig } = await import('./playwright.webkit.config.js');
        const { default: firefoxConfig } = await import('./playwright.firefox.config.js');

        for (const config of [baseConfig, webkitConfig, firefoxConfig]) {
            expect(config.use.trace).toBe('retain-on-failure');
            expect(config.use.video).toBe('only-on-failure');
            expect(config.use.screenshot).toBe('only-on-failure');
            expect(config.webServer.command).toContain('e2e-servers-launch.js');
            expect(config.globalSetup).toContain('e2e-servers-prime.js');
            expect(config.globalTeardown).toContain('e2e-servers-teardown.js');
        }
    });

    describe('first run of a server', () => {
        let dataRoot;
        let settingsFile;

        beforeEach(() => {
            dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-first-run-'));
            settingsFile = path.join(dataRoot, 'default-user', 'settings.json');
        });

        afterEach(() => {
            fs.rmSync(dataRoot, { recursive: true, force: true });
        });

        const store = (text, handle = 'default-user') => {
            const target = path.join(dataRoot, handle, 'settings.json');
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, text);
        };

        test('is over only when stored settings end firstRun and Welcome Show at Startup', () => {
            expect(isFirstRunOver(dataRoot)).toBe(false);

            store('{ "firstRun": fal');
            expect(isFirstRunOver(dataRoot)).toBe(false);

            store(JSON.stringify({ firstRun: true }));
            expect(isFirstRunOver(dataRoot)).toBe(false);

            store(JSON.stringify({ firstRun: false, accountStorage: { WelcomePage_ShowAtStartup: 'true' } }));
            expect(isFirstRunOver(dataRoot)).toBe(false);

            store(JSON.stringify({ firstRun: false }));
            expect(isFirstRunOver(dataRoot)).toBe(true);

            store(JSON.stringify({ firstRun: false, accountStorage: { WelcomePage_ShowAtStartup: 'false' } }), 'worker-1');
            expect(isFirstRunOver(dataRoot, 'worker-1')).toBe(true);
            expect(isFirstRunOver(dataRoot, 'worker-2')).toBe(false);
        });

        test('is awaited until the server has stored its end', async () => {
            store(JSON.stringify({ firstRun: true }));
            let over = false;
            const wait = waitUntilFirstRunIsOver(dataRoot, { timeoutMs: 10_000, intervalMs: 5 }).then(() => {
                over = true;
            });

            await new Promise(resolve => setTimeout(resolve, 50));
            expect(over).toBe(false);

            store(JSON.stringify({ firstRun: false, accountStorage: { WelcomePage_ShowAtStartup: 'false' } }));
            await wait;
            expect(over).toBe(true);
        });

        test('fails the wait with the data root when its end is not stored in time', async () => {
            store(JSON.stringify({ firstRun: true }));

            await expect(waitUntilFirstRunIsOver(dataRoot, { timeoutMs: 30, intervalMs: 5 })).rejects.toThrow(settingsFile);
        });
    });
});
