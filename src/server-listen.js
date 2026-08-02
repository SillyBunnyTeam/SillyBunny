import { setTimeout as delay } from 'node:timers/promises';

// A relaunched server races the previous process for the listen port: the old
// socket can still be encumbered for a moment after that process is gone,
// especially on Windows where libuv binds with SO_EXCLUSIVEADDRUSE. Retrying
// for a few seconds turns a permanently broken restart into a short pause.
export const LISTEN_RETRY_ATTEMPTS = 10;
export const LISTEN_RETRY_DELAY_MS = 500;
export const LISTEN_CLOSE_TIMEOUT_MS = 2000;

/** @type {Set<{ server: import('node:net').Server, sockets: Set<import('node:net').Socket> }>} */
const trackedListeners = new Set();

/**
 * Checks if an error was caused by an occupied port.
 * @param {unknown} error The error to inspect
 * @returns {error is NodeJS.ErrnoException} True when the port is already in use
 */
export function isAddressInUseError(error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE';
}

/**
 * Tracks a listening server and its client sockets so shutdown can release the
 * port instead of leaving it to process teardown.
 * @param {import('node:net').Server} server A server that is already listening
 * @returns {void}
 */
export function trackListeningServer(server) {
    /** @type {Set<import('node:net').Socket>} */
    const sockets = new Set();
    const entry = { server, sockets };

    // tls.Server extends net.Server, so 'connection' covers the raw socket for
    // HTTPS too and destroying it tears down the TLS session with it.
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });

    server.once('close', () => trackedListeners.delete(entry));
    trackedListeners.add(entry);
}

/**
 * Stops every tracked listener and destroys its live connections.
 * Resolves once the servers report closed or the timeout elapses, so a stuck
 * connection can never outlive the graceful shutdown timer.
 * @param {object} [options] Shutdown options
 * @param {number} [options.timeoutMs] How long to wait for the servers to close
 * @returns {Promise<void>} A promise that resolves when the ports are released
 */
export async function closeListeningServers({ timeoutMs = LISTEN_CLOSE_TIMEOUT_MS } = {}) {
    const entries = [...trackedListeners];
    trackedListeners.clear();

    if (entries.length === 0) {
        return;
    }

    const closed = entries.map(({ server, sockets }) => new Promise((resolve) => {
        try {
            server.close(() => resolve());
        } catch {
            resolve();
            return;
        }

        // Long-lived streaming responses keep server.close() pending forever,
        // so drop the connections instead of waiting them out. Bun does not
        // implement closeAllConnections, hence the tracked-socket fallback.
        try {
            server.closeAllConnections?.();
        } catch {
            // Ignore: the tracked sockets are destroyed below regardless.
        }

        for (const socket of sockets) {
            socket.destroy();
        }
        sockets.clear();
    }));

    // Unref'd so a fast close does not keep the event loop alive for the rest
    // of the timeout; the pending server handles hold it open while it matters.
    const timeout = new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
    });

    await Promise.race([Promise.all(closed), timeout]);
}

/**
 * Runs an operation that binds a port, retrying while the port is still in use.
 * Any other failure rejects immediately.
 * @param {() => Promise<any>} attemptFn The bind operation to run
 * @param {object} [options] Retry options
 * @param {number} [options.attempts] Total number of attempts, including the first
 * @param {number} [options.delayMs] Delay between attempts
 * @param {(attempt: number, attempts: number) => void} [options.onRetry] Called before each retry
 * @returns {Promise<any>} The result of the successful attempt
 */
export async function retryOnAddressInUse(attemptFn, {
    attempts = LISTEN_RETRY_ATTEMPTS,
    delayMs = LISTEN_RETRY_DELAY_MS,
    onRetry,
} = {}) {
    const totalAttempts = Math.max(1, attempts);

    for (let attempt = 1; ; attempt++) {
        try {
            return await attemptFn();
        } catch (error) {
            if (attempt >= totalAttempts || !isAddressInUseError(error)) {
                throw error;
            }

            onRetry?.(attempt, totalAttempts);
            await delay(delayMs);
        }
    }
}
