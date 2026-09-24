import { execFile } from 'node:child_process';
import http from 'node:http';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

// A relaunched server races the previous process for the listen port: the old
// socket can still be encumbered for a moment after that process is gone,
// especially on Windows where libuv binds with SO_EXCLUSIVEADDRUSE. Worse,
// released Bun versions create inheritable socket handles on Windows
// (oven-sh/bun#36936), so a process spawned during an update can keep the port
// bound until it exits. Retrying for about a minute outlasts the typical
// straggler instead of permanently breaking the restart after five seconds.
export const LISTEN_RETRY_ATTEMPTS = 40;
export const LISTEN_RETRY_DELAY_MS = 1500;
export const LISTEN_CLOSE_TIMEOUT_MS = 2000;
export const PORT_HOLDER_LOOKUP_TIMEOUT_MS = 3000;
export const BUN_SOCKET_INHERIT_ISSUE_URL = 'https://github.com/oven-sh/bun/issues/36936';

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

/**
 * Runs a diagnostic command, resolving with its stdout or an empty string on
 * any failure. Never rejects and never outlives its timeout.
 * @param {string} command The executable to run
 * @param {string[]} args Arguments for the executable
 * @returns {Promise<string>} Captured stdout, or '' when unavailable
 */
function runDiagnosticCommand(command, args) {
    return new Promise((resolve) => {
        try {
            execFile(command, args, { timeout: PORT_HOLDER_LOOKUP_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
                resolve(!error || stdout ? String(stdout ?? '') : '');
            });
        } catch {
            resolve('');
        }
    });
}

/**
 * Performs a lightweight HTTP probe to the running process's /version endpoint.
 * @param {number} port The port to probe
 * @param {number} ipVersion The IP version used
 * @returns {Promise<{type: string, pid: number, name: string, command: string}|null>}
 */
export async function probeHttpHolder(port, ipVersion) {
    const protocol = ipVersion === 6 ? 'http://[::1]' : 'http://127.0.0.1';
    const url = `${protocol}:${port}/version`;

    try {
        const response = await new Promise((resolve, reject) => {
            const req = http.get(url, { timeout: 1000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });

        if (response.statusCode !== 200) {
            return null;
        }

        try {
            const json = JSON.parse(response.body);
            const text = JSON.stringify(json);
            if (text.includes('SillyTavern')) {
                return { type: 'SillyTavern', pid: 0, name: 'SillyTavern', command: '' };
            }
            if (text.includes('SillyBunny')) {
                return { type: 'Another SillyBunny Instance', pid: 0, name: 'SillyBunny', command: '' };
            }
        } catch {
            // Not JSON or parse failed; fall through to OS probe
        }
    } catch {
        // Probe failed; fall through to OS probe
    }
    return null;
}

/**
 * Resolves the command-line details for a given PID on POSIX systems.
 * @param {number} pid The process ID
 * @returns {Promise<{name: string, command: string}>}
 */
async function resolvePosixCommandLine(pid) {
    try {
        const cmdline = await runDiagnosticCommand('cat', [`/proc/${pid}/cmdline`]);
        if (cmdline) {
            const parts = cmdline.replace(/\0/g, ' ').trim().split(/\s+/);
            const name = parts[0] ? parts[0].split('/').pop() : 'unknown';
            return { name, command: cmdline.trim() };
        }
    } catch {
        // Fall through
    }

    try {
        const psOutput = await runDiagnosticCommand('ps', ['-p', String(pid), '-o', 'comm=,args=']);
        if (psOutput) {
            const lines = psOutput.trim().split('\n');
            const firstLine = lines[0]?.trim() || '';
            const name = firstLine.split(/\s+/)[0] || 'unknown';
            return { name, command: psOutput.trim() };
        }
    } catch {
        // Fall through
    }

    return { name: 'unknown', command: '' };
}

/**
 * Resolves the command-line details for a given PID on Windows.
 * @param {number} pid The process ID
 * @returns {Promise<{name: string, command: string}>}
 */
async function resolveWindowsCommandLine(pid) {
    const commandLine = await runDiagnosticCommand('powershell', ['-NoProfile', `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty CommandLine`]);

    if (commandLine && commandLine.trim()) {
        const parts = commandLine.trim().split(/\s+/);
        const name = parts[0] ? parts[0].split(/[\\/]/).pop() : 'unknown';
        return { name, command: commandLine.trim() };
    }

    const tasklistOutput = await runDiagnosticCommand('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const name = parseTasklistProcessName(tasklistOutput, pid) || 'unknown';
    return { name, command: '' };
}

/**
 * Builds a structured diagnostic object for a port conflict.
 * @param {number} port The port in conflict
 * @param {string} listenAddress The listen address (e.g. 127.0.0.1:4444)
 * @returns {Promise<object>} Diagnostic result
 */
export async function diagnosePortConflict(port, listenAddress) {
    const diagnosis = {
        port,
        listenAddress,
        holderType: 'Unknown Process',
        processName: 'unknown',
        pid: null,
        commandLine: '',
    };

    // Phase 1: HTTP probe to /version
    const httpProbe = await probeHttpHolder(port, 4);
    if (httpProbe && httpProbe.type !== 'Another SillyBunny Instance' && httpProbe.type !== 'SillyTavern') {
        diagnosis.holderType = httpProbe.type;
        diagnosis.processName = httpProbe.name;
        diagnosis.commandLine = httpProbe.command;
        return diagnosis;
    }

    if (httpProbe) {
        diagnosis.holderType = httpProbe.type;
        diagnosis.processName = httpProbe.name;
        return diagnosis;
    }

    // Phase 2: OS-level process inspection
    if (process.platform === 'win32') {
        const rows = parseNetstatPortRows(await runDiagnosticCommand('netstat', ['-ano']), port);
        const listeningRow = rows.find(r => r.state.toUpperCase() === 'LISTENING');
        if (listeningRow && Number.isFinite(listeningRow.pid) && listeningRow.pid > 0) {
            diagnosis.pid = listeningRow.pid;
            const cmdInfo = await resolveWindowsCommandLine(listeningRow.pid);
            diagnosis.processName = cmdInfo.name;
            diagnosis.commandLine = cmdInfo.command;

            if (cmdInfo.name.toLowerCase().includes('sillytavern')) {
                diagnosis.holderType = 'SillyTavern';
            } else if (cmdInfo.name.toLowerCase().includes('sillybunny') || cmdInfo.name.toLowerCase().includes('bun') || cmdInfo.name.toLowerCase().includes('node')) {
                const lowerName = cmdInfo.name.toLowerCase();
                if (lowerName.includes('sillybunny')) {
                    diagnosis.holderType = 'Another SillyBunny Instance';
                } else {
                    diagnosis.holderType = `Generic Application (${cmdInfo.name})`;
                }
            } else {
                diagnosis.holderType = `Generic Application (${cmdInfo.name})`;
            }
        }
    } else {
        const ss = await runDiagnosticCommand('ss', ['-tnap', `sport = :${port}`]);
        const ssRows = ss.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('State '));
        if (ssRows.length > 0) {
            const match = ssRows[0]?.match(/pid=(\d+)/);
            if (match) {
                diagnosis.pid = Number(match[1]);
                const cmdInfo = await resolvePosixCommandLine(diagnosis.pid);
                diagnosis.processName = cmdInfo.name;
                diagnosis.commandLine = cmdInfo.command;

                const lowerName = cmdInfo.name.toLowerCase();
                if (lowerName.includes('sillytavern')) {
                    diagnosis.holderType = 'SillyTavern';
                } else if (lowerName.includes('sillybunny')) {
                    diagnosis.holderType = 'Another SillyBunny Instance';
                } else {
                    diagnosis.holderType = `Generic Application (${cmdInfo.name})`;
                }
            }
        } else {
            const lsof = await runDiagnosticCommand('lsof', ['-nP', `-iTCP:${port}`]);
            const lsofLines = lsof.split('\n').filter(Boolean);
            if (lsofLines.length > 1) {
                const match = lsofLines[1]?.match(/(\d+)\s/);
                if (match) {
                    diagnosis.pid = Number(match[1]);
                    const cmdInfo = await resolvePosixCommandLine(diagnosis.pid);
                    diagnosis.processName = cmdInfo.name;
                    diagnosis.commandLine = cmdInfo.command;

                    const lowerName = cmdInfo.name.toLowerCase();
                    if (lowerName.includes('sillytavern')) {
                        diagnosis.holderType = 'SillyTavern';
                    } else if (lowerName.includes('sillybunny')) {
                        diagnosis.holderType = 'Another SillyBunny Instance';
                    } else {
                        diagnosis.holderType = `Generic Application (${cmdInfo.name})`;
                    }
                }
            }
        }
    }

    return diagnosis;
}

/**
 * Formats a structured diagnosis into a dual-tier console banner.
 * @param {object} diagnosis The result from diagnosePortConflict
 * @returns {string} The formatted banner
 */
export function formatPortConflictBanner(diagnosis) {
    const { port, listenAddress, holderType, processName, pid, commandLine } = diagnosis;
    const separator = '='.repeat(70);
    const pidStr = pid ? `PID ${pid}` : '???';

    const lines = [
        separator,
        `[Startup Notice] Port ${port} is already in use!`,
        separator,
        '',
        'SillyBunny cannot start because another application is already using',
        `port ${port}.`,
        '',
        'If you are running SillyTavern and SillyBunny at the same time, they',
        'both use this port by default. They cannot share the same port number.',
        '',
        '--- Technical Details ---',
        `  Port:           ${port} (${listenAddress})`,
        `  Detected App:   ${holderType}`,
        `  Process:        ${processName}${pid ? ` (PID ${pid})` : ''}`,
        `  Path / Command: ${commandLine || ''}`,
        '',
        '--- How to Fix ---',
        '  1. To run both SillyTavern and SillyBunny at the same time:',
        '     Open SillyBunny\'s "config.yaml" and change "port: 4444" to "port: 4445".',
        '  2. If SillyTavern was left open accidentally:',
        `     Close the other terminal window or end ${pidStr} in Task Manager.`,
        separator,
    ];

    return lines.join('\n');
}

/**
 * Extracts the TCP rows of a `netstat -ano` dump that concern one local port.
 * @param {string} output Raw netstat output
 * @param {number} port The local port to filter on
 * @returns {{ local: string, state: string, pid: number }[]} Matching rows
 */
export function parseNetstatPortRows(output, port) {
    const suffix = `:${port}`;
    const rows = [];
    for (const line of String(output).split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        // TCP rows have 5 columns (proto, local, foreign, state, pid); UDP rows
        // have no state column and are irrelevant for a listen conflict.
        if (columns.length !== 5 || columns[0].toUpperCase() !== 'TCP' || !columns[1].endsWith(suffix)) {
            continue;
        }
        rows.push({ local: columns[1], state: columns[3], pid: Number(columns[4]) });
    }
    return rows;
}

/**
 * Finds a process name in `tasklist /FO CSV /NH` output.
 * @param {string} output Raw tasklist output
 * @param {number} pid The process id to look for
 * @returns {string|null} The image name, or null when the process is gone
 */
export function parseTasklistProcessName(output, pid) {
    for (const line of String(output).split(/\r?\n/)) {
        const match = line.match(/^"([^"]+)","(\d+)"/);
        if (match && Number(match[2]) === pid) {
            return match[1];
        }
    }
    return null;
}

/**
 * Builds human-readable lines describing what occupies a local TCP port.
 * Windows resolves owning processes and calls out the Bun handle-inheritance
 * bug when the "owner" is already dead; POSIX just relays ss/lsof output.
 * @param {number} port The port to inspect
 * @param {object} [options] Dependency injection for tests
 * @param {typeof runDiagnosticCommand} [options.runCommand] Command runner
 * @param {string} [options.platform] Platform override
 * @returns {Promise<string[]>} Diagnostic lines, empty when nothing was found
 */
export async function describePortHolders(port, { runCommand = runDiagnosticCommand, platform = process.platform } = {}) {
    if (platform === 'win32') {
        const rows = parseNetstatPortRows(await runCommand('netstat', ['-ano']), port);
        const lines = [];
        for (const row of rows) {
            if (row.state.toUpperCase() !== 'LISTENING' || !Number.isFinite(row.pid) || row.pid <= 0) {
                lines.push(`Port ${port}: ${row.local} is in state ${row.state} (PID ${row.pid}).`);
                continue;
            }
            const name = parseTasklistProcessName(await runCommand('tasklist', ['/FI', `PID eq ${row.pid}`, '/FO', 'CSV', '/NH']), row.pid);
            if (name) {
                lines.push(`Port ${port} is held open by "${name}" (PID ${row.pid}).`);
            } else {
                lines.push(`Port ${port} is attributed to PID ${row.pid}, which is no longer running: a process spawned by the previous server instance inherited its socket handle (known Bun-on-Windows bug, ${BUN_SOCKET_INHERIT_ISSUE_URL}). The port frees itself once that process exits.`);
            }
        }
        return lines;
    }

    const ss = await runCommand('ss', ['-tnap', `sport = :${port}`]);
    const ssRows = ss.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('State '));
    if (ssRows.length > 0) {
        return ssRows.map(row => `Port ${port}: ${row}`);
    }

    const lsof = await runCommand('lsof', ['-nP', `-iTCP:${port}`]);
    return lsof.split('\n').map(line => line.trim()).filter(Boolean).map(row => `Port ${port}: ${row}`);
}

/**
 * Logs who currently occupies a port, best-effort. Safe to fire and forget:
 * it never throws and stays silent when nothing conclusive is found.
 * @param {number} port The port to inspect
 * @returns {Promise<void>} Resolves once logging is done
 */
export async function reportPortHolders(port) {
    try {
        const lines = await describePortHolders(port);
        for (const line of lines) {
            console.warn(line);
        }
    } catch {
        // Diagnostics must never break startup.
    }
}
