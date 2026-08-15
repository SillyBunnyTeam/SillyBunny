import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const SERVER_MAIN_SOURCE = new URL('../src/server-main.js', import.meta.url);
const SERVER_STARTUP_SOURCE = new URL('../src/server-startup.js', import.meta.url);

class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.destroyed = false;
        this.destroy = jest.fn(() => {
            this.destroyed = true;
        });
    }
}

class FakeServer extends EventEmitter {
    /**
     * @param {object} [options] Fake behavior
     * @param {boolean} [options.autoClose] Whether close() invokes its callback
     * @param {boolean} [options.withCloseAllConnections] Whether the runtime exposes closeAllConnections
     */
    constructor({ autoClose = true, withCloseAllConnections = true } = {}) {
        super();
        this.closeCallbacks = [];
        this.close = jest.fn((callback) => {
            this.closeCallbacks.push(callback);
            if (autoClose && typeof callback === 'function') {
                callback();
            }
            return this;
        });

        if (withCloseAllConnections) {
            this.closeAllConnections = jest.fn();
        }
    }
}

function addressInUseError() {
    const error = new Error('listen EADDRINUSE: address already in use 127.0.0.1:4444');
    error.code = 'EADDRINUSE';
    return error;
}

async function loadListenModule() {
    jest.resetModules();
    return import('../src/server-listen.js');
}

describe('listen port release', () => {
    afterEach(() => {
        jest.resetModules();
    });

    test('destroys tracked connections so a streaming request cannot hold the port', async () => {
        const { closeListeningServers, trackListeningServer } = await loadListenModule();
        const server = new FakeServer();
        const socket = new FakeSocket();

        trackListeningServer(server);
        server.emit('connection', socket);

        await closeListeningServers();

        expect(server.close).toHaveBeenCalledTimes(1);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
        expect(socket.destroy).toHaveBeenCalledTimes(1);
    });

    test('destroys tracked connections when the runtime lacks closeAllConnections', async () => {
        const { closeListeningServers, trackListeningServer } = await loadListenModule();
        const server = new FakeServer({ withCloseAllConnections: false });
        const socket = new FakeSocket();

        trackListeningServer(server);
        server.emit('connection', socket);

        await closeListeningServers();

        expect(server.closeAllConnections).toBeUndefined();
        expect(socket.destroy).toHaveBeenCalledTimes(1);
    });

    test('forgets sockets that closed on their own and servers that already closed', async () => {
        const { closeListeningServers, trackListeningServer } = await loadListenModule();
        const closedServer = new FakeServer();
        const openServer = new FakeServer();
        const closedSocket = new FakeSocket();

        trackListeningServer(closedServer);
        trackListeningServer(openServer);
        openServer.emit('connection', closedSocket);
        closedSocket.emit('close');
        closedServer.emit('close');

        await closeListeningServers();

        expect(closedServer.close).not.toHaveBeenCalled();
        expect(openServer.close).toHaveBeenCalledTimes(1);
        expect(closedSocket.destroy).not.toHaveBeenCalled();
    });

    test('resolves on timeout when a server never reports closed', async () => {
        const { closeListeningServers, trackListeningServer } = await loadListenModule();
        const server = new FakeServer({ autoClose: false });

        trackListeningServer(server);

        await expect(closeListeningServers({ timeoutMs: 10 })).resolves.toBeUndefined();
        expect(server.close).toHaveBeenCalledTimes(1);
    });

    test('is a no-op when nothing is listening', async () => {
        const { closeListeningServers } = await loadListenModule();

        await expect(closeListeningServers()).resolves.toBeUndefined();
    });
});

describe('listen retry on an occupied port', () => {
    let retryOnAddressInUse;
    let isAddressInUseError;

    beforeEach(async () => {
        ({ isAddressInUseError, retryOnAddressInUse } = await loadListenModule());
    });

    test('recognizes only EADDRINUSE errors', () => {
        expect(isAddressInUseError(addressInUseError())).toBe(true);
        expect(isAddressInUseError(Object.assign(new Error('nope'), { code: 'EACCES' }))).toBe(false);
        expect(isAddressInUseError(new Error('nope'))).toBe(false);
        expect(isAddressInUseError(null)).toBe(false);
        expect(isAddressInUseError('EADDRINUSE')).toBe(false);
    });

    test('retries until the port is released', async () => {
        const attemptFn = jest.fn()
            .mockRejectedValueOnce(addressInUseError())
            .mockRejectedValueOnce(addressInUseError())
            .mockResolvedValueOnce('listening');
        const onRetry = jest.fn();

        await expect(retryOnAddressInUse(attemptFn, { delayMs: 0, onRetry })).resolves.toBe('listening');

        expect(attemptFn).toHaveBeenCalledTimes(3);
        expect(onRetry).toHaveBeenCalledTimes(2);
        expect(onRetry).toHaveBeenNthCalledWith(1, 1, 40);
    });

    test('gives up after the attempt cap and rethrows the original error', async () => {
        const error = addressInUseError();
        const attemptFn = jest.fn().mockRejectedValue(error);

        await expect(retryOnAddressInUse(attemptFn, { attempts: 3, delayMs: 0 })).rejects.toBe(error);

        expect(attemptFn).toHaveBeenCalledTimes(3);
    });

    test('does not retry other startup failures', async () => {
        const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        const attemptFn = jest.fn().mockRejectedValue(error);
        const onRetry = jest.fn();

        await expect(retryOnAddressInUse(attemptFn, { delayMs: 0, onRetry })).rejects.toBe(error);

        expect(attemptFn).toHaveBeenCalledTimes(1);
        expect(onRetry).not.toHaveBeenCalled();
    });

    test('defaults to a bounded window of about a minute', async () => {
        const { LISTEN_RETRY_ATTEMPTS, LISTEN_RETRY_DELAY_MS } = await loadListenModule();

        expect(LISTEN_RETRY_ATTEMPTS).toBe(40);
        expect(LISTEN_RETRY_DELAY_MS).toBe(1500);
        // Long enough to outlast an update straggler holding an inherited
        // socket handle, short enough that a genuine conflict still surfaces.
        const windowMs = (LISTEN_RETRY_ATTEMPTS - 1) * LISTEN_RETRY_DELAY_MS;
        expect(windowMs).toBeGreaterThanOrEqual(45_000);
        expect(windowMs).toBeLessThanOrEqual(120_000);
    });
});

describe('port holder diagnostics', () => {
    const NETSTAT_OUTPUT = [
        'Active Connections',
        '',
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    127.0.0.1:4444         0.0.0.0:0              LISTENING       4321',
        '  TCP    127.0.0.1:4444         127.0.0.1:52001        TIME_WAIT       0',
        '  TCP    127.0.0.1:44440       0.0.0.0:0              LISTENING       9999',
        '  TCP    [::1]:4444             [::]:0                 LISTENING       4321',
        '  UDP    0.0.0.0:5353           *:*                                    777',
    ].join('\r\n');

    test('parses only the TCP rows of the requested port', async () => {
        const { parseNetstatPortRows } = await loadListenModule();

        const rows = parseNetstatPortRows(NETSTAT_OUTPUT, 4444);

        expect(rows).toEqual([
            { local: '127.0.0.1:4444', state: 'LISTENING', pid: 4321 },
            { local: '127.0.0.1:4444', state: 'TIME_WAIT', pid: 0 },
            { local: '[::1]:4444', state: 'LISTENING', pid: 4321 },
        ]);
    });

    test('reads a process name from tasklist CSV output and misses cleanly', async () => {
        const { parseTasklistProcessName } = await loadListenModule();

        expect(parseTasklistProcessName('"bun.exe","4321","Console","1","120,000 K"', 4321)).toBe('bun.exe');
        expect(parseTasklistProcessName('INFO: No tasks are running which match the specified criteria.', 4321)).toBeNull();
        expect(parseTasklistProcessName('', 4321)).toBeNull();
    });

    test('names a live Windows holder and flags a dead one as an inherited handle', async () => {
        const { describePortHolders, BUN_SOCKET_INHERIT_ISSUE_URL } = await loadListenModule();
        const liveRunner = jest.fn(async (command) => command === 'netstat'
            ? '  TCP    127.0.0.1:4444    0.0.0.0:0    LISTENING    4321'
            : '"bun.exe","4321","Console","1","120,000 K"');
        const deadRunner = jest.fn(async (command) => command === 'netstat'
            ? '  TCP    127.0.0.1:4444    0.0.0.0:0    LISTENING    4321'
            : 'INFO: No tasks are running which match the specified criteria.');

        const liveLines = await describePortHolders(4444, { runCommand: liveRunner, platform: 'win32' });
        expect(liveLines).toEqual(['Port 4444 is held open by "bun.exe" (PID 4321).']);

        const deadLines = await describePortHolders(4444, { runCommand: deadRunner, platform: 'win32' });
        expect(deadLines).toHaveLength(1);
        expect(deadLines[0]).toContain('no longer running');
        expect(deadLines[0]).toContain(BUN_SOCKET_INHERIT_ISSUE_URL);
    });

    test('relays raw socket tool output on POSIX and stays quiet when tools fail', async () => {
        const { describePortHolders } = await loadListenModule();
        const ssRunner = jest.fn(async (command) => command === 'ss'
            ? 'LISTEN 0 511 127.0.0.1:4444 0.0.0.0:* users:(("node",pid=4321,fd=20))\n'
            : '');
        const failingRunner = jest.fn(async () => '');

        const lines = await describePortHolders(4444, { runCommand: ssRunner, platform: 'linux' });
        expect(lines).toEqual(['Port 4444: LISTEN 0 511 127.0.0.1:4444 0.0.0.0:* users:(("node",pid=4321,fd=20))']);

        await expect(describePortHolders(4444, { runCommand: failingRunner, platform: 'linux' })).resolves.toEqual([]);
    });
});

describe('server wiring', () => {
    test('shutdown releases the listen ports before tearing down state', () => {
        const source = readFileSync(SERVER_MAIN_SOURCE, 'utf8');

        expect(source).toContain('import { closeListeningServers } from \'./server-listen.js\';');
        expect(source).toContain('await closeListeningServers();');
        // The ports must be released before the slower teardown work runs.
        expect(source.indexOf('await closeListeningServers();')).toBeLessThan(source.indexOf('await statsOnExit();'));
        expect(source).toContain('if (process.connected === false)');
        expect(source).toContain('await exitAfterSupervisorDisconnect();');
        expect(source).toContain('process.on(\'message\', (message) =>');
        expect(source).toContain('process.on(\'disconnect\', exitAfterSupervisorDisconnect);');
        expect(source).toContain('process.on(\'SIGHUP\', () => exitProcess(0));');
        expect(source).toContain('process.on(\'SIGBREAK\', () => exitProcess(0));');
    });

    test('startup tracks its listeners and retries an occupied port', () => {
        const source = readFileSync(SERVER_STARTUP_SOURCE, 'utf8');

        expect(source).toContain('trackListeningServer(server);');
        expect(source).toContain('retryOnAddressInUse(() => createFunc(url, ipVersion)');
        expect(source).not.toContain('await createFunc(this.cliArgs.getIPv6ListenUrl(), 6);');
        expect(source).not.toContain('await createFunc(this.cliArgs.getIPv4ListenUrl(), 4);');
        expect(source).toContain('await Promise.all([startIPv6, startIPv4]);');
    });
});
