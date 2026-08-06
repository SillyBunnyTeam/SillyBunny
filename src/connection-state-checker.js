import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const TCP_ESTABLISHED = '01';
const CONNECTION_TABLE_CACHE_MS = 50;
const DEFAULT_POLL_INTERVAL_MS = 150;
const NETSTAT_TIMEOUT_MS = 1000;
const NETSTAT_ESTABLISHED_STATE = 'ESTABLISHED';
const NETSTAT_TCP_STATES = new Set([
    'CLOSED',
    'CLOSE_WAIT',
    'CLOSING',
    'DELETE_TCB',
    'ESTABLISHED',
    'FIN_WAIT_1',
    'FIN_WAIT_2',
    'LAST_ACK',
    'LISTEN',
    'LISTENING',
    'SYN_RECEIVED',
    'SYN_RECV',
    'SYN_RCVD',
    'SYN_SENT',
    'TIME_WAIT',
]);

/**
 * @typedef {object} SocketAddress
 * @property {string} localAddress Local socket address
 * @property {number} localPort Local socket port
 * @property {string} remoteAddress Remote socket address
 * @property {number} remotePort Remote socket port
 */

/** @type {{ platform: string, expiresAt: number, promise: Promise<Set<string> | null> } | null} */
let connectionTableCache = null;

function normalizeAddress(address) {
    if (!address) {
        return '';
    }

    let normalized = String(address).trim().toLowerCase();

    if (normalized.startsWith('::ffff:')) {
        normalized = normalized.slice(7);
    }

    if (normalized === 'localhost') {
        return '127.0.0.1';
    }

    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
        return '::1';
    }

    return normalized;
}

function connectionKey(localAddress, localPort, remoteAddress, remotePort) {
    return `${normalizeAddress(localAddress)}:${Number(localPort)}>${normalizeAddress(remoteAddress)}:${Number(remotePort)}`;
}

function reverseConnectionKey(localAddress, localPort, remoteAddress, remotePort) {
    return connectionKey(remoteAddress, remotePort, localAddress, localPort);
}

function expandIpv6Address(address) {
    if (!address.includes('::')) {
        return address.split(':').map(part => part.padStart(4, '0')).join(':');
    }

    const [left, right = ''] = address.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missingParts = Math.max(0, 8 - leftParts.length - rightParts.length);
    const parts = [...leftParts, ...Array(missingParts).fill('0'), ...rightParts];

    return parts.map(part => part.padStart(4, '0')).join(':');
}

function collapseIpv6Address(address) {
    const parts = expandIpv6Address(address).split(':').map(part => part.replace(/^0+/, '') || '0');
    let bestStart = -1;
    let bestLength = 0;
    let currentStart = -1;
    let currentLength = 0;

    for (let i = 0; i <= parts.length; i++) {
        if (parts[i] === '0') {
            if (currentStart === -1) currentStart = i;
            currentLength++;
        } else {
            if (currentLength > bestLength) {
                bestStart = currentStart;
                bestLength = currentLength;
            }
            currentStart = -1;
            currentLength = 0;
        }
    }

    if (bestLength < 2) {
        return parts.join(':');
    }

    const before = parts.slice(0, bestStart).join(':');
    const after = parts.slice(bestStart + bestLength).join(':');

    if (!before && !after) return '::';
    if (!before) return `::${after}`;
    if (!after) return `${before}::`;
    return `${before}::${after}`;
}

function parseLinuxIpv4Address(hexAddress) {
    const bytes = hexAddress.match(/.{2}/g);
    if (!bytes || bytes.length !== 4) {
        return '';
    }

    return bytes.reverse().map(byte => Number.parseInt(byte, 16)).join('.');
}

function parseLinuxIpv6Address(hexAddress) {
    const groups = hexAddress.match(/.{8}/g);
    if (!groups || groups.length !== 4) {
        return '';
    }

    const normalized = groups
        .map(group => group.match(/.{2}/g)?.reverse().join('') ?? '')
        .join('')
        .match(/.{4}/g)
        ?.join(':');

    if (!normalized) {
        return '';
    }

    if (normalized.startsWith('0000:0000:0000:0000:0000:ffff:')) {
        const ipv4Hex = normalized.split(':').slice(-2).join('');
        const bytes = ipv4Hex.match(/.{2}/g);
        if (bytes?.length === 4) {
            return bytes.map(byte => Number.parseInt(byte, 16)).join('.');
        }
    }

    return collapseIpv6Address(normalized);
}

function parseLinuxEndpoint(endpoint, isIpv6) {
    const [addressHex, portHex] = endpoint.split(':');
    const address = isIpv6 ? parseLinuxIpv6Address(addressHex) : parseLinuxIpv4Address(addressHex);
    const port = Number.parseInt(portHex, 16);

    return { address, port };
}

function parseLinuxTcpTable(text, isIpv6 = false) {
    const connections = new Set();
    const lines = String(text || '').trim().split('\n').slice(1);

    for (const line of lines) {
        const fields = line.trim().split(/\s+/);
        const localEndpoint = fields[1];
        const remoteEndpoint = fields[2];
        const state = fields[3];

        if (!localEndpoint || !remoteEndpoint || state !== TCP_ESTABLISHED) {
            continue;
        }

        const local = parseLinuxEndpoint(localEndpoint, isIpv6);
        const remote = parseLinuxEndpoint(remoteEndpoint, isIpv6);

        if (!local.address || !remote.address || !local.port || !remote.port) {
            continue;
        }

        connections.add(connectionKey(local.address, local.port, remote.address, remote.port));
    }

    return connections;
}

function parseNetstatEndpoint(endpoint) {
    const bracketMatch = String(endpoint || '').match(/^\[(.+)\]:(\d+)$/);
    if (bracketMatch) {
        return { address: bracketMatch[1], port: Number(bracketMatch[2]) };
    }

    const endpointMatch = String(endpoint || '').match(/^(.+)[:.](\d+)$/);
    if (!endpointMatch) {
        return null;
    }

    return { address: endpointMatch[1], port: Number(endpointMatch[2]) };
}

function parseNetstatOutput(text) {
    const connections = new Set();

    for (const line of String(text || '').split('\n')) {
        const fields = line.trim().split(/\s+/);
        const tcpIndex = fields.findIndex(field => /^tcp/i.test(field));

        if (tcpIndex < 0) {
            continue;
        }

        const hasQueueColumns = /^\d+$/.test(fields[tcpIndex + 1]) && /^\d+$/.test(fields[tcpIndex + 2]);
        const endpointOffset = hasQueueColumns ? 3 : 1;
        const localEndpoint = fields[tcpIndex + endpointOffset];
        const remoteEndpoint = fields[tcpIndex + endpointOffset + 1];
        const state = fields[tcpIndex + endpointOffset + 2];

        if (!localEndpoint || !remoteEndpoint) {
            continue;
        }

        const local = parseNetstatEndpoint(localEndpoint);
        const remote = parseNetstatEndpoint(remoteEndpoint);

        if (!local || !remote || !local.port || !remote.port) {
            continue;
        }

        const normalizedState = String(state || '').toUpperCase();
        if (!NETSTAT_TCP_STATES.has(normalizedState)) {
            // Windows localizes TCP states. An unrecognized state makes the
            // table unsafe for disconnect detection, so callers fail open.
            return null;
        }

        if (normalizedState !== NETSTAT_ESTABLISHED_STATE) {
            continue;
        }

        connections.add(connectionKey(local.address, local.port, remote.address, remote.port));
    }

    return connections;
}

async function getLinuxConnections() {
    const connections = new Set();

    for (const [file, isIpv6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]]) {
        try {
            const text = await fs.promises.readFile(file, 'utf8');
            for (const key of parseLinuxTcpTable(text, isIpv6)) {
                connections.add(key);
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    return connections;
}

async function getNetstatConnections(platform) {
    const args = platform === 'win32' ? ['-ano', '-p', 'TCP'] : ['-an', '-p', 'tcp'];
    const result = await execFileAsync('netstat', args, { timeout: NETSTAT_TIMEOUT_MS });
    const stdout = typeof result === 'string' ? result : result?.stdout;

    return parseNetstatOutput(stdout);
}

async function getConnectionTable(platform = os.platform()) {
    switch (platform) {
        case 'linux':
            return getLinuxConnections();
        case 'darwin':
        case 'win32':
            return getNetstatConnections(platform);
        default:
            return null;
    }
}

function getSocketAddress(socket) {
    if (!socket?.localAddress || !socket?.localPort || !socket?.remoteAddress || !socket?.remotePort) {
        return null;
    }

    return {
        localAddress: socket.localAddress,
        localPort: Number(socket.localPort),
        remoteAddress: socket.remoteAddress,
        remotePort: Number(socket.remotePort),
    };
}

async function getCachedConnectionTable(platform = os.platform()) {
    const now = Date.now();

    if (connectionTableCache && connectionTableCache.platform === platform && connectionTableCache.expiresAt > now) {
        return connectionTableCache.promise;
    }

    const promise = getConnectionTable(platform);
    connectionTableCache = {
        platform,
        expiresAt: now + CONNECTION_TABLE_CACHE_MS,
        promise,
    };

    try {
        return await promise;
    } catch (error) {
        if (connectionTableCache?.promise === promise) {
            connectionTableCache = null;
        }
        throw error;
    }
}

/**
 * Checks the OS connection table for the given socket.
 * Falls back to connected when the platform check is unavailable.
 * @param {import('node:net').Socket} socket Socket to check
 * @returns {Promise<boolean>} True if the socket appears connected or cannot be checked
 */
export async function isSocketConnected(socket) {
    if (!socket || socket.destroyed) {
        return false;
    }

    const address = getSocketAddress(socket);
    if (!address) {
        return true;
    }

    return isSocketAddressConnected(address);
}

/**
 * Checks the OS connection table for a captured socket address 4-tuple.
 * Used by the streaming disconnect poller to avoid re-reading the live socket
 * fields, which runtimes like Bun may clear mid-request (leaving the poller
 * unable to detect a client disconnect). Returns true (assume alive) only when
 * the address or platform connection table is unavailable, matching the prior
 * fail-open behaviour.
 * @param {SocketAddress} address Captured local/remote address and ports.
 * @returns {Promise<boolean>} True if the connection is still in the OS table.
 */
export async function isSocketAddressConnected(address) {
    if (!address?.localAddress || !address?.localPort || !address?.remoteAddress || !address?.remotePort) {
        return true;
    }

    let table;
    try {
        table = await getCachedConnectionTable();
    } catch (error) {
        console.debug('Unable to read client socket connection table:', error?.message ?? error);
        return true;
    }

    if (!table) {
        return true;
    }

    const key = connectionKey(address.localAddress, address.localPort, address.remoteAddress, address.remotePort);
    const reverseKey = reverseConnectionKey(address.localAddress, address.localPort, address.remoteAddress, address.remotePort);

    return table.has(key) || table.has(reverseKey);
}

/**
 * Polls an HTTP request socket and runs a callback once an OS-level disconnect is detected.
 * @param {import('node:net').Socket} socket Socket to poll
 * @param {number} intervalMs Polling interval in milliseconds
 * @param {() => void} onDisconnect Disconnect callback
 * @returns {() => void} Stops polling
 */
export function pollSocketConnection(socket, intervalMs = DEFAULT_POLL_INTERVAL_MS, onDisconnect = () => undefined) {
    if (!socket || typeof onDisconnect !== 'function') {
        return () => undefined;
    }

    let stopped = false;
    let checking = false;
    const interval = Math.max(50, Number(intervalMs) || DEFAULT_POLL_INTERVAL_MS);

    // Snapshot the socket's 4-tuple address once obtained, then check the OS
    // connection table against the snapshot. The live socket fields (used by
    // getSocketAddress) can be cleared mid-request under some runtimes (notably
    // Bun), which previously caused the poller to read null forever and report
    // the connection as alive even after the client disconnected. We lazily
    // retry capturing the address until we have it, then reuse the snapshot.
    let addressSnapshot = null;

    async function checkConnection() {
        if (stopped || checking) {
            return;
        }

        checking = true;
        try {
            if (socket.destroyed) {
                if (!stopped) {
                    stopped = true;
                    clearInterval(timer);
                    console.info('Detected destroyed client socket during streaming request');
                    onDisconnect();
                }
                return;
            }

            if (!addressSnapshot) {
                addressSnapshot = getSocketAddress(socket);
                if (!addressSnapshot) {
                    // Live address fields not available yet this tick; retry next interval.
                    return;
                }
            }

            const connected = await isSocketAddressConnected(addressSnapshot);
            if (!connected && !stopped) {
                stopped = true;
                clearInterval(timer);
                console.info('Detected disconnected client socket during streaming request');
                onDisconnect();
            }
        } catch (error) {
            console.debug('Unable to poll client socket connection state:', error?.message ?? error);
        } finally {
            checking = false;
        }
    }

    const timer = setInterval(checkConnection, interval);
    timer.unref?.();
    void checkConnection();

    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

export const testExports = {
    clearConnectionTableCache: () => {
        connectionTableCache = null;
    },
    connectionKey,
    collapseIpv6Address,
    getSocketAddress,
    isSocketAddressConnected,
    normalizeAddress,
    parseLinuxTcpTable,
    parseNetstatOutput,
};
