import { EventEmitter } from 'node:events';
import http from 'node:http';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';


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


describe('port conflict diagnostics', () => {
    const servers = new Set();

    async function serve(handler, host = '127.0.0.1') {
        const server = http.createServer(handler);
        servers.add(server);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen({ port: 0, host, ipv6Only: true }, resolve);
        });
        return server.address().port;
    }

    function commandOutputs(outputs) {
        return async (command, args) => outputs[`${command} ${args.join(' ')}`] ?? outputs[command] ?? '';
    }

    afterEach(async () => {
        for (const server of servers) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        servers.clear();
        jest.restoreAllMocks();
    });

    test.each([
        ['SillyTavern:1.13.4:Cohee#1207', 'SillyTavern'],
        ['SillyBunny:1.7.1:fork', 'Another SillyBunny Instance'],
    ])('identifies the version agent %s', async (agent, type) => {
        const { probeHttpHolder } = await loadListenModule();
        const port = await serve((req, res) => res.end(JSON.stringify({ agent, gitBranch: 'SillyTavern-sync' })));
        expect(await probeHttpHolder(port, 4)).toMatchObject({ type });
    });

    test('does not identify an application from incidental JSON text or an error response', async () => {
        const { probeHttpHolder } = await loadListenModule();
        const port = await serve((req, res) => res.end(JSON.stringify({ message: 'SillyBunny' })));
        expect(await probeHttpHolder(port, 4)).toBeNull();
        const denied = await serve((req, res) => {
            res.statusCode = 403;
            res.end(JSON.stringify({ agent: 'SillyTavern:1.13.4:Cohee#1207' }));
        });
        expect(await probeHttpHolder(denied, 4)).toBeNull();
    });

    test('limits the total probe duration even while a response keeps streaming', async () => {
        const { probeHttpHolder } = await loadListenModule();
        const port = await serve((req, res) => {
            res.write('{');
            const timer = setInterval(() => res.write(' '), 25);
            res.once('close', () => clearInterval(timer));
        });
        let deadline;
        try {
            const result = await Promise.race([
                probeHttpHolder(port, 4),
                new Promise(resolve => { deadline = setTimeout(() => resolve('hung'), 1800); }),
            ]);
            expect(result).toBeNull();
        } finally {
            clearTimeout(deadline);
        }
    });

    test('abandons truncated and oversized responses', async () => {
        const { probeHttpHolder } = await loadListenModule();
        const truncated = await serve((req, res) => {
            res.writeHead(200, { 'Content-Length': '200' });
            res.write('{');
            setImmediate(() => res.destroy());
        });
        const oversized = await serve((req, res) => res.end(JSON.stringify({ agent: 'SillyBunny:1.7.1:fork', padding: 'x'.repeat(100_000) })));
        let deadline;
        try {
            const result = await Promise.race([
                Promise.all([probeHttpHolder(truncated, 4), probeHttpHolder(oversized, 4)]),
                new Promise(resolve => { deadline = setTimeout(() => resolve('hung'), 1800); }),
            ]);
            expect(result).toEqual([null, null]);
        } finally {
            clearTimeout(deadline);
        }
    });

    test('diagnoses IPv6 without probing an unrelated IPv4 holder and retains process details', async () => {
        const { diagnosePortConflict } = await loadListenModule();
        const port = await serve((req, res) => res.end(JSON.stringify({ agent: 'SillyBunny:1.7.1:fork' })), '::1');
        const runCommand = commandOutputs({
            netstat: `TCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING 111\nTCP [::1]:${port} [::]:0 LISTENING 222`,
            powershell: JSON.stringify({ Name: 'node.exe', ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: '"C:\\Program Files\\nodejs\\node.exe" server.js' }),
            tasklist: '"node.exe","222","Console","1","120,000 K"',
        });
        const result = await diagnosePortConflict(port, `::1:${port}`, { platform: 'win32', runCommand });
        expect(result).toMatchObject({ holderType: 'Another SillyBunny Instance', pid: 222, processName: 'node.exe' });
        expect(result.commandLine).toContain('Program Files');
    });

    test('probes the configured IPv4 interface instead of always using loopback .1', async () => {
        const { diagnosePortConflict } = await loadListenModule();
        const port = await serve((req, res) => res.end(JSON.stringify({ agent: 'SillyTavern:1.13.4:Cohee#1207' })), '127.0.0.2');
        const result = await diagnosePortConflict(port, `127.0.0.2:${port}`, { platform: 'linux', runCommand: async () => '' });
        expect(result.holderType).toBe('SillyTavern');
    });

    test('uses Windows script paths without disclosing arguments in the banner', async () => {
        const { diagnosePortConflict, formatPortConflictBanner } = await loadListenModule();
        const port = await serve((req, res) => { res.statusCode = 401; res.end(); });
        const runCommand = commandOutputs({
            netstat: `TCP 127.0.0.2:${port} 0.0.0.0:0 LISTENING 111\nTCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING 222`,
            powershell: JSON.stringify({ Name: 'node.exe', ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "D:\\Apps\\SillyTavern\\server.js" --keyPassphrase private-fixture-value --token another-fixture-value' }),
        });
        const result = await diagnosePortConflict(port, `127.0.0.1:${port}`, { platform: 'win32', runCommand });
        expect(result).toMatchObject({ holderType: 'SillyTavern', processName: 'node.exe', pid: 222 });
        const banner = formatPortConflictBanner(result);
        expect(banner).not.toContain('private-fixture-value');
        expect(banner).not.toContain('another-fixture-value');
        expect(banner).toContain('C:\\Program Files\\nodejs\\node.exe');
    });

    test('falls back to lsof when ss cannot name the listener and ignores client connections', async () => {
        const { diagnosePortConflict } = await loadListenModule();
        const port = await serve((req, res) => { res.statusCode = 401; res.end(); });
        const runCommand = commandOutputs({
            ss: `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:*`,
            lsof: `p111\ncclient\nn127.0.0.1:51000->127.0.0.1:${port}\np222\ncnode\nn127.0.0.1:${port}`,
            cat: '/usr/bin/node\0/opt/SillyBunny/server.js\0',
        });
        const result = await diagnosePortConflict(port, `127.0.0.1:${port}`, { platform: 'linux', runCommand });
        expect(result).toMatchObject({ holderType: 'Another SillyBunny Instance', processName: 'node', pid: 222 });
        expect(result.commandLine).toBe('/usr/bin/node');
    });

    test('uses ps when procfs is unavailable without splitting a spaced executable path', async () => {
        const { diagnosePortConflict } = await loadListenModule();
        const port = await serve((req, res) => res.end('{}'));
        const runCommand = commandOutputs({
            lsof: `p222\ncnode\nn127.0.0.1:${port}`,
            'ps -p 222 -o comm=': '/Applications/Node Runtime/node\n',
            'ps -p 222 -o args=': '/Applications/Node Runtime/node server.js\n',
        });
        expect(await diagnosePortConflict(port, `127.0.0.1:${port}`, { platform: 'darwin', runCommand }))
            .toMatchObject({ processName: 'node', pid: 222, holderType: 'Generic Application (node)' });
    });

    test('selects a listening ss socket rather than an established connection', async () => {
        const { diagnosePortConflict } = await loadListenModule();
        const port = await serve((req, res) => res.end('{}'));
        const runCommand = commandOutputs({
            ss: `ESTAB 0 0 127.0.0.1:${port} 127.0.0.1:51234 users:(("node",pid=111,fd=20))\nLISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* users:(("python3",pid=222,fd=21))`,
            cat: '/usr/bin/python3\0server.py\0',
        });
        expect(await diagnosePortConflict(port, `127.0.0.1:${port}`, { platform: 'linux', runCommand }))
            .toMatchObject({ pid: 222, processName: 'python3', holderType: 'Generic Application (python3)' });
    });

    test('a wildcard conflict probes the interface occupied by the identified holder', async () => {
        const { diagnosePortConflict } = await loadListenModule();
        const port = await serve((req, res) => res.end(JSON.stringify({ agent: 'SillyTavern:1.13.4:Cohee#1207' })), '127.0.0.2');
        const runCommand = commandOutputs({
            ss: `LISTEN 0 511 127.0.0.2:${port} 0.0.0.0:* users:(("node",pid=222,fd=20))`,
        });
        expect(await diagnosePortConflict(port, `0.0.0.0:${port}`, { platform: 'linux', runCommand }))
            .toMatchObject({ pid: 222, holderType: 'SillyTavern' });
    });

    test.each([4445, 65535])('suggests a different valid port for conflict on %i', async (port) => {
        const { formatPortConflictBanner } = await loadListenModule();
        const banner = formatPortConflictBanner({ port, listenAddress: `127.0.0.1:${port}`, holderType: 'Unknown Process', processName: 'unknown', pid: null, commandLine: '' });
        const ports = [...banner.matchAll(/port: (\d+)/g)].map(match => Number(match[1]));
        expect(ports[0]).toBe(port);
        expect(ports[1]).not.toBe(port);
        expect(ports[1]).toBeGreaterThan(0);
        expect(ports[1]).toBeLessThanOrEqual(65535);
        expect(banner).not.toContain('???');
    });

    test('does not allow process details to inject terminal controls or extra lines', async () => {
        const { formatPortConflictBanner } = await loadListenModule();
        const banner = formatPortConflictBanner({ port: 4444, listenAddress: '127.0.0.1:4444', holderType: 'Generic Application (node)', processName: '\x1b[2Jnode\r\nforged', pid: 222, commandLine: '/tmp/\x00node' });
        expect(banner).not.toMatch(/[\x00\x1b\r]/);
        expect(banner).not.toContain('\nforged');
    });
});
