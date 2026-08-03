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
        expect(onRetry).toHaveBeenNthCalledWith(1, 1, 10);
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

    test('defaults to a bounded multi-second window', async () => {
        const { LISTEN_RETRY_ATTEMPTS, LISTEN_RETRY_DELAY_MS } = await loadListenModule();

        expect(LISTEN_RETRY_ATTEMPTS).toBe(10);
        expect(LISTEN_RETRY_DELAY_MS).toBe(500);
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
