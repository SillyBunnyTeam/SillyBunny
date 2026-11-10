import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    READY_MESSAGE,
    SEQUENTIAL_SPECS_VARIABLE,
    SERVER_LIST_VARIABLE,
    findSequentialSpecs,
    getDefaultWorkers,
    getProjects,
    getServerCommand,
    getServerConfig,
    getServerCount,
    getServerUrl,
} from './e2e-servers.js';

const SERVERS = [
    { url: 'http://127.0.0.1:5001', port: 5001, dataRoot: '/tmp/sillybunny-test-data-a' },
    { url: 'http://127.0.0.1:5002', port: 5002, dataRoot: '/tmp/sillybunny-test-data-b' },
    { url: 'http://127.0.0.1:5003', port: 5003, dataRoot: '/tmp/sillybunny-test-data-c' },
];

describe('e2e servers', () => {
    test('starts servers only when asked and when no base URL is set', () => {
        expect(getServerCount({})).toBe(0);
        expect(getServerCount({ SILLYBUNNY_TEST_SERVERS: '' })).toBe(0);
        expect(getServerCount({ SILLYBUNNY_TEST_SERVERS: '8' })).toBe(8);
        expect(getServerCount({ SILLYBUNNY_TEST_SERVERS: '8', SILLYBUNNY_TEST_BASE_URL: 'http://127.0.0.1:4444' })).toBe(0);
        expect(getServerCount({ SILLYBUNNY_TEST_SERVERS: '8', ST_BASE_URL: 'http://127.0.0.1:4444' })).toBe(0);
        expect(getServerCount({ SILLYBUNNY_TEST_SERVERS: '8', PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:4444' })).toBe(0);
    });

    test.each(['0', '-1', '1.5', 'eight', '1e1', '0x8', ' 3 ', '08'])('refuses %p servers', value => {
        expect(() => getServerCount({ SILLYBUNNY_TEST_SERVERS: value })).toThrow('SILLYBUNNY_TEST_SERVERS');
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

    test('starts a server with Bun, or with Node.js when asked, without a shell', () => {
        const server = { port: 5001, dataRoot: '/tmp/sillybunny test $data' };
        const args = ['server.js', '--browserLaunchEnabled=false', '--port', '5001', '--dataRoot', '/tmp/sillybunny test $data'];
        expect(getServerCommand({}, server)).toEqual({ command: 'bun', args });
        expect(getServerCommand({ SILLYBUNNY_TEST_SERVER_RUNTIME: 'node' }, server)).toEqual({ command: process.execPath, args: ['--no-warnings', ...args] });
        expect(() => getServerCommand({ SILLYBUNNY_TEST_SERVER_RUNTIME: 'deno' }, server)).toThrow('SILLYBUNNY_TEST_SERVER_RUNTIME');
    });

    test('refuses an unknown runtime before it starts any server', async () => {
        await expect(getServerConfig({ SILLYBUNNY_TEST_SERVERS: '2', SILLYBUNNY_TEST_SERVER_RUNTIME: 'deno' })).rejects.toThrow('SILLYBUNNY_TEST_SERVER_RUNTIME');
    });

    test('leaves the base URL alone and starts nothing for one server that runs already', async () => {
        const env = { SILLYBUNNY_TEST_SERVERS: '8', SILLYBUNNY_TEST_BASE_URL: 'http://127.0.0.1:4444' };
        const config = await getServerConfig(env);

        expect(config.config).toEqual({});
        expect(config.use).toEqual({});
        expect(config.workers).toBe(getDefaultWorkers(0, os.cpus().length));
        expect(env[SERVER_LIST_VARIABLE]).toBeUndefined();
    });

    test('routes a worker to its server and sets the base URL for helpers that read it on load', async () => {
        const env = { [SERVER_LIST_VARIABLE]: JSON.stringify(SERVERS), TEST_PARALLEL_INDEX: '4' };
        const config = await getServerConfig(env);

        expect(config.use.baseURL).toBe(SERVERS[1].url);
        expect(env.SILLYBUNNY_TEST_BASE_URL).toBe(SERVERS[1].url);
        expect(config.config.webServer.command).toContain('e2e-servers-launch.js');
        expect(config.config.webServer.wait.stdout.test(READY_MESSAGE)).toBe(true);
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
        expect(parallel.testIgnore).toBe(sequential.testMatch);
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
});
