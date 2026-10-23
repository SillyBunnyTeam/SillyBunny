import { randomInt } from 'node:crypto';

/** Fixture ports are random free ports in this range. */
export const PORT_MIN = 20000;
export const PORT_MAX = 60999;

/**
 * Highest port the emulator may see. The app picks its own server port in 49152-65535 on the device
 * (android/.../server/PortPolicy.kt RANGE), so `adb reverse` device ports stay below that range.
 */
export const DEVICE_PORT_MAX = 49151;

/** The operator's live SillyBunny server; fixtures never bind, probe or forward it. */
export const RESERVED_PORTS = Object.freeze([4444]);

const RETRY_CODES = new Set(['EADDRINUSE', 'EACCES']);

/**
 * Checks that a port is one fixtures may bind.
 * @param {number} port Port number.
 * @param {object} [options] Options.
 * @param {number} [options.max] Highest allowed port (default {@link PORT_MAX}).
 * @returns {boolean} True when the port is inside the fixture range and not reserved.
 */
export function isFixturePort(port, { max = PORT_MAX } = {}) {
    return Number.isInteger(port) && port >= PORT_MIN && port <= Math.min(max, PORT_MAX) && !RESERVED_PORTS.includes(port);
}

/**
 * Listens once and settles on the first `listening` or `error` event.
 * @param {import('node:net').Server} server Server.
 * @param {string} host Host.
 * @param {number} port Port.
 * @returns {Promise<void>}
 */
function listenOnce(server, host, port) {
    return new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host, port, exclusive: true });
    });
}

/**
 * Binds a server to a random free fixture port, or to an explicit one inside the range.
 * @param {import('node:net').Server} server Server that is not listening yet.
 * @param {object} [options] Options.
 * @param {string} [options.host] Host (default loopback).
 * @param {number} [options.port] Explicit port inside the fixture range.
 * @param {number} [options.maxPort] Highest port to draw from (default {@link PORT_MAX}).
 * @param {number} [options.attempts] Random attempts before giving up.
 * @returns {Promise<number>} Bound port.
 */
export async function listenOnFixturePort(server, { host = '127.0.0.1', port, maxPort = PORT_MAX, attempts = 64 } = {}) {
    if (!Number.isInteger(maxPort) || maxPort < PORT_MIN || maxPort > PORT_MAX) {
        throw new Error(`maxPort ${maxPort} is outside ${PORT_MIN}-${PORT_MAX}.`);
    }
    if (port !== undefined) {
        if (!isFixturePort(port, { max: maxPort })) {
            throw new Error(`Port ${port} is outside ${PORT_MIN}-${maxPort} or reserved.`);
        }
        await listenOnce(server, host, port);
        return port;
    }

    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        const candidate = randomInt(PORT_MIN, maxPort + 1);
        if (!isFixturePort(candidate, { max: maxPort })) {
            continue;
        }
        try {
            await listenOnce(server, host, candidate);
            return candidate;
        } catch (error) {
            if (!RETRY_CODES.has(error?.code)) {
                throw error;
            }
            lastError = error;
        }
    }
    throw new Error(`No free fixture port after ${attempts} attempts: ${lastError?.message ?? 'unknown'}`);
}

/**
 * Closes an HTTP server and every open connection.
 * @param {import('node:http').Server} server Server.
 * @returns {Promise<void>}
 */
export function closeHttpServer(server) {
    return new Promise((resolve) => {
        if (!server.listening) {
            resolve();
            return;
        }
        server.close(() => resolve());
        server.closeAllConnections();
    });
}

/**
 * Parses a request target. Node's HTTP parser accepts targets that WHATWG URL rejects, such as `//[`,
 * `http://%zz/` or `//:99999/`; the fixture servers answer those with 400 instead of throwing.
 * @param {import('node:http').IncomingMessage} request Request.
 * @returns {URL|null} Parsed target, or null when URL rejects it.
 */
export function parseRequestTarget(request) {
    try {
        return new URL(request.url ?? '/', 'http://fixture.invalid');
    } catch {
        return null;
    }
}

/**
 * Wraps an async request handler so that a failure ends only its own request: a 500, or a reset when
 * the response has already started. Unhandled, the rejection would stop the process and with it every
 * fixture service the launcher runs.
 * @param {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>} handler Handler.
 * @param {(entry: object) => void} [record] Request log; receives one entry with the error message.
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void} Request listener.
 */
export function guardRequestHandler(handler, record) {
    return (request, response) => {
        handler(request, response).catch((error) => {
            const status = response.headersSent ? response.statusCode : 500;
            try {
                if (!response.headersSent) {
                    const text = 'TODO(copy)\n';
                    response.writeHead(500, {
                        'Content-Type': 'text/plain; charset=utf-8',
                        'Content-Length': Buffer.byteLength(text),
                        'Cache-Control': 'no-store',
                        'Connection': 'close',
                    });
                    response.end(text);
                } else {
                    response.destroy();
                }
            } catch {
                response.destroy();
            }
            try {
                record?.({
                    time: new Date().toISOString(),
                    method: request.method,
                    path: String(request.url ?? ''),
                    status,
                    error: String(error?.message ?? error),
                });
            } catch {
                // A log that cannot be written must not stop the process either.
            }
        });
    };
}
