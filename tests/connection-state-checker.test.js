import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { Response } from 'node-fetch';

const mockReadFile = jest.fn();
const mockExecFile = jest.fn();
const mockPlatform = jest.fn();

jest.unstable_mockModule('node:fs', () => ({
    default: {
        promises: {
            readFile: mockReadFile,
        },
    },
}));

jest.unstable_mockModule('node:child_process', () => ({
    execFile: mockExecFile,
}));

jest.unstable_mockModule('node:os', () => ({
    default: {
        platform: mockPlatform,
    },
}));

const connectionStateChecker = await import('../src/connection-state-checker.js');
const { forwardFetchResponse } = await import('../src/util.js');

const {
    isSocketConnected,
    isSocketAddressConnected,
    pollSocketConnection,
    testExports,
} = connectionStateChecker;

function createSocket(overrides = {}) {
    return {
        destroyed: false,
        localAddress: '127.0.0.1',
        localPort: 8080,
        remoteAddress: '127.0.0.2',
        remotePort: 5555,
        ...overrides,
    };
}

function createMockResponse() {
    const response = new PassThrough();
    response.statusCode = 200;
    response.statusMessage = '';
    response.socket = {};

    return response;
}

function createLinuxTcpTable(state = '01') {
    return [
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
        `   0: 0100007F:1F90 0200007F:15B3 ${state} 00000000:00000000 00:00000000 00000000   100        0 0`,
    ].join('\n');
}

function createEmptyLinuxTable() {
    return '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
}

beforeEach(() => {
    mockReadFile.mockReset();
    mockExecFile.mockReset();
    mockPlatform.mockReset();
    testExports.clearConnectionTableCache();
});

afterEach(() => {
    jest.restoreAllMocks();
    testExports.clearConnectionTableCache();
});

describe('connection-state-checker parsers', () => {
    test('parses Linux tcp tables and keeps only established connections', () => {
        const table = testExports.parseLinuxTcpTable(createLinuxTcpTable());

        expect(table).toEqual(new Set(['127.0.0.1:8080>127.0.0.2:5555']));
        expect(testExports.parseLinuxTcpTable(createLinuxTcpTable('08'))).toEqual(new Set());
    });

    test('parses netstat output with bracketed IPv6 endpoints', () => {
        const table = testExports.parseNetstatOutput([
            '  tcp6       0      0  [::1]:8080    [::ffff:127.0.0.2]:5555    ESTABLISHED',
            '  TCP    127.0.0.1:9000    127.0.0.3:4444    TIME_WAIT    1234',
        ].join('\n'));

        expect(table).toEqual(new Set(['::1:8080>127.0.0.2:5555']));
    });

    test('marks netstat output with localized TCP states as unavailable', () => {
        const table = testExports.parseNetstatOutput(
            '  TCP    127.0.0.1:8080    127.0.0.2:5555    HERGESTELLT    1234\n',
        );

        expect(table).toBeNull();
    });
});

describe('isSocketConnected', () => {
    test('uses Linux proc tables to detect an active socket', async () => {
        mockPlatform.mockReturnValue('linux');
        mockReadFile.mockImplementation(async file => file === '/proc/net/tcp'
            ? createLinuxTcpTable()
            : createEmptyLinuxTable());

        await expect(isSocketConnected(createSocket())).resolves.toBe(true);
        expect(mockReadFile).toHaveBeenCalledWith('/proc/net/tcp', 'utf8');
        expect(mockReadFile).toHaveBeenCalledWith('/proc/net/tcp6', 'utf8');
    });

    test('returns false when the Linux proc table no longer contains the socket', async () => {
        mockPlatform.mockReturnValue('linux');
        mockReadFile.mockImplementation(async file => file === '/proc/net/tcp'
            ? createLinuxTcpTable('08')
            : createEmptyLinuxTable());

        await expect(isSocketConnected(createSocket())).resolves.toBe(false);
    });

    test('uses netstat on Windows', async () => {
        mockPlatform.mockReturnValue('win32');
        mockExecFile.mockImplementation((command, args, options, callback) => {
            callback(null, '  TCP    127.0.0.1:8080    127.0.0.2:5555    ESTABLISHED    1234\n', '');
        });

        await expect(isSocketConnected(createSocket())).resolves.toBe(true);
        expect(mockExecFile).toHaveBeenCalledWith('netstat', ['-ano', '-p', 'TCP'], expect.objectContaining({ timeout: 1000 }), expect.any(Function));
    });

    test('falls back to connected when Windows localizes netstat states', async () => {
        mockPlatform.mockReturnValue('win32');
        mockExecFile.mockImplementation((command, args, options, callback) => {
            callback(null, '  TCP    127.0.0.1:8080    127.0.0.2:5555    HERGESTELLT    1234\n', '');
        });

        await expect(isSocketConnected(createSocket())).resolves.toBe(true);
    });

    test('falls back to connected on unsupported platforms', async () => {
        mockPlatform.mockReturnValue('sunos');

        await expect(isSocketConnected(createSocket())).resolves.toBe(true);
        expect(mockReadFile).not.toHaveBeenCalled();
        expect(mockExecFile).not.toHaveBeenCalled();
    });
});

describe('isSocketAddressConnected', () => {
    test('reports connected when the captured 4-tuple is still in the OS table', async () => {
        mockPlatform.mockReturnValue('linux');
        mockReadFile.mockImplementation(async file => file === '/proc/net/tcp'
            ? createLinuxTcpTable()
            : createEmptyLinuxTable());

        const address = testExports.getSocketAddress(createSocket());
        await expect(isSocketAddressConnected(address)).resolves.toBe(true);
    });

    test('reports disconnected when the captured 4-tuple is gone from the OS table', async () => {
        mockPlatform.mockReturnValue('linux');
        mockReadFile.mockImplementation(async file => file === '/proc/net/tcp'
            ? createLinuxTcpTable('08')
            : createEmptyLinuxTable());

        const address = testExports.getSocketAddress(createSocket());
        await expect(isSocketAddressConnected(address)).resolves.toBe(false);
    });

    test('detects disconnect even after live socket address fields are cleared (Bun regression)', async () => {
        mockPlatform.mockReturnValue('linux');
        mockReadFile.mockImplementation(async file => file === '/proc/net/tcp'
            ? createLinuxTcpTable('08')
            : createEmptyLinuxTable());

        // Simulate the post-disconnect state under Bun: the OS table no longer
        // has the connection, and the live socket address fields were cleared
        // mid-request. isSocketConnected (live read) would fail-open here, but
        // isSocketAddressConnected with a pre-captured snapshot still detects it.
        const address = testExports.getSocketAddress(createSocket());
        const clearedSocket = createSocket({ localAddress: undefined, localPort: undefined, remoteAddress: undefined, remotePort: undefined });

        await expect(isSocketConnected(clearedSocket)).resolves.toBe(true);
        await expect(isSocketAddressConnected(address)).resolves.toBe(false);
    });
});

describe('pollSocketConnection', () => {
    test('detects a disconnected socket and runs the callback once', async () => {
        mockPlatform.mockReturnValue('linux');
        mockReadFile.mockImplementation(async file => file === '/proc/net/tcp'
            ? createLinuxTcpTable('08')
            : createEmptyLinuxTable());
        const disconnectHandler = jest.fn();
        const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
        const stopPolling = pollSocketConnection(createSocket(), 50, disconnectHandler);

        await new Promise(resolve => setImmediate(resolve));

        expect(disconnectHandler).toHaveBeenCalledTimes(1);
        expect(infoSpy).toHaveBeenCalledWith('Detected disconnected client socket during streaming request');

        stopPolling();
    });

    test('detects disconnect after the live socket address is cleared mid-poll (Bun regression)', async () => {
        // Reproduces the abort-propagation gap: under Bun the live socket address
        // fields (localAddress/localPort/remoteAddress/remotePort) can be cleared
        // mid-request, and the browser-disconnect events are missed. The poller
        // previously re-read those live fields every tick, so once they were gone
        // getSocketAddress() returned null and isSocketConnected() failed open
        // forever, so the upstream abort never fired. With an address snapshot
        // captured on the first readable tick, the poller still detects the
        // disconnect.
        mockPlatform.mockReturnValue('linux');
        let tableState = '01';
        mockReadFile.mockImplementation(async file => file === '/proc/net/tcp'
            ? createLinuxTcpTable(tableState)
            : createEmptyLinuxTable());

        const socket = createSocket();
        const disconnectHandler = jest.fn();
        jest.spyOn(console, 'info').mockImplementation(() => undefined);
        jest.spyOn(console, 'debug').mockImplementation(() => undefined);

        const stopPolling = pollSocketConnection(socket, 50, disconnectHandler);

        // First tick: address is readable and the connection is established.
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(disconnectHandler).not.toHaveBeenCalled();

        // Client disconnects: OS table drops the entry, and Bun clears the live
        // socket address fields mid-request.
        tableState = '08';
        socket.localAddress = undefined;
        socket.localPort = undefined;
        socket.remoteAddress = undefined;
        socket.remotePort = undefined;

        await new Promise(resolve => setTimeout(resolve, 160));

        expect(disconnectHandler).toHaveBeenCalledTimes(1);

        stopPolling();
    });
});

describe('forwardFetchResponse disconnect polling', () => {
    test('stops upstream streaming when the socket disappears', async () => {
        mockPlatform.mockReturnValue('linux');
        mockReadFile.mockImplementation(async file => file === '/proc/net/tcp'
            ? createLinuxTcpTable('08')
            : createEmptyLinuxTable());

        const upstreamBody = new PassThrough();
        const destroySpy = jest.spyOn(upstreamBody, 'destroy');
        const response = createMockResponse();
        const disconnectHandler = jest.fn();
        const finished = once(response, 'finish');

        await forwardFetchResponse(new Response(upstreamBody), response, { socket: createSocket() }, disconnectHandler);

        await finished;

        expect(disconnectHandler).toHaveBeenCalledTimes(1);
        expect(destroySpy).toHaveBeenCalled();
        expect(response.writableEnded).toBe(true);
    });
});
