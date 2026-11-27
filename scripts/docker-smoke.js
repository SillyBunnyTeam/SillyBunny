#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

export const DEFAULT_CONTAINER_PORT = 4444;
export const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
export const DEFAULT_STABILIZE_MS = 3_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export const EXIT = Object.freeze({
    ok: 0,
    failed: 1,
    usage: 2,
});

const SAFE_COMMAND_NAME = /^[a-zA-Z0-9._-]+$/;

/**
 * Runtime commands that must exist on PATH inside the SillyBunny Docker image.
 * Keep apkPackage aligned with Dockerfile so unit tests detect drift.
 */
export const REQUIRED_IMAGE_COMMANDS = Object.freeze([
    // Runs init, server.js, healthcheck.js, and dependency installs.
    Object.freeze({ command: 'bun', source: 'base-image' }),
    // Runs package.json init, npm, and Quick Image Gen sync transforms.
    Object.freeze({ command: 'node', source: 'apk', apkPackage: 'nodejs' }),
    // Runs npm ci for server plugin updates and fallback installs.
    Object.freeze({ command: 'npm', source: 'apk', apkPackage: 'npm' }),
    // Manages extension, plugin, and server repository operations.
    Object.freeze({ command: 'git', source: 'apk', apkPackage: 'git' }),
    // Supports Git LFS extension and plugin repositories.
    Object.freeze({ command: 'git-lfs', source: 'apk', apkPackage: 'git-lfs' }),
    // Acts as PID 1 in the image entrypoint to forward signals and reap zombies.
    Object.freeze({ command: 'tini', source: 'apk', apkPackage: 'tini' }),
    // Drops privileges to the bun user in PUID/PGID mode.
    Object.freeze({ command: 'su-exec', source: 'apk', apkPackage: 'su-exec' }),
    // Updates the bun user UID and GID in PUID/PGID mode.
    Object.freeze({ command: 'usermod', source: 'apk', apkPackage: 'shadow' }),
    // Updates the bun group GID in PUID/PGID mode.
    Object.freeze({ command: 'groupmod', source: 'apk', apkPackage: 'shadow' }),
    // Interprets docker-entrypoint.sh and package scripts.
    Object.freeze({ command: 'sh', source: 'base-image' }),
]);

/**
 * Log patterns that signal a broken startup, missing binary, permission error, or crash.
 * Avoid broad words such as "not found" or "Failed" alone because normal startup logs
 * "Resource not found, copying from defaults: config.yaml" and DNS warnings for
 * host.docker.internal on Linux runners.
 */
export const FATAL_LOG_PATTERNS = Object.freeze([
    Object.freeze({ reason: 'uncaught exception', pattern: /\bUncaught exception\b/i }),
    Object.freeze({ reason: 'unhandled rejection', pattern: /\b(?:Unhandled rejection|UnhandledPromiseRejection)\b/i }),
    Object.freeze({
        reason: 'runtime or module error',
        pattern: /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|ERR_MODULE_NOT_FOUND|ERR_INVALID_ARG_TYPE)\b/,
    }),
    Object.freeze({ reason: 'missing module or package', pattern: /\b(?:Cannot find (?:module|package)|ResolveMessage:\s*Cannot find)\b/i }),
    Object.freeze({ reason: 'critical startup error', pattern: /\bA critical error has occurred while starting the server\b/i }),
    Object.freeze({ reason: 'fatal initialization error', pattern: /\bFATAL:/ }),
    Object.freeze({ reason: 'supervisor crash', pattern: /\[SillyBunny\]\s*(?:Server crashed|Supervisor failed to launch the server)\b/i }),
    Object.freeze({ reason: 'deferred startup failure', pattern: /\bDeferred startup maintenance failed\b/i }),
    Object.freeze({ reason: 'native runtime crash', pattern: /\b(?:Segmentation fault|SIGSEGV|SIGABRT|Bun has crashed)\b|\bpanic\(/i }),
    Object.freeze({ reason: 'missing command in shell', pattern: /\bcommand not found\b|:\s*not found\s*$/i }),
    Object.freeze({ reason: 'missing binary or file (ENOENT)', pattern: /\bENOENT\b/ }),
    Object.freeze({ reason: 'permission or read-only error', pattern: /\b(?:EACCES|EPERM|EROFS)\b|\b(?:Permission denied|Read-only file system)\b/i }),
    Object.freeze({ reason: 'entrypoint filesystem warning', pattern: /\bWarning:\s*(?:Could not create|Failed to update permissions)\b/i }),
    Object.freeze({ reason: 'listen address error', pattern: /\b(?:EADDRINUSE|EADDRNOTAVAIL)\b/ }),
]);

/**
 * Prints CLI usage instructions.
 */
export function printHelp() {
    console.log(`Usage: node scripts/docker-smoke.js <image> [options]

Verifies that a built SillyBunny Docker image contains every required runtime
command, starts cleanly in a fresh container, answers HTTP readiness probes
(GET / and GET /csrf-token), stays running after startup, and prints no fatal
errors in its logs.

Options:
  --timeout-ms <ms>        Startup readiness timeout in ms (default: ${DEFAULT_STARTUP_TIMEOUT_MS}).
  --stabilize-ms <ms>      Wait after readiness before final checks (default: ${DEFAULT_STABILIZE_MS}).
  --poll-interval-ms <ms>  Delay between readiness polls in ms (default: ${DEFAULT_POLL_INTERVAL_MS}).
  --container-port <port>  Port exposed inside the container (default: ${DEFAULT_CONTAINER_PORT}).
  -h, --help               Show this help.

Exit codes:
  ${EXIT.ok}  All smoke checks passed.
  ${EXIT.failed}  Smoke check failed.
  ${EXIT.usage}  Invalid command-line arguments.`);
}

function parsePositiveInt(flag, rawValue, { allowZero = false } = {}) {
    if (rawValue === undefined || rawValue === '' || !/^\d+$/.test(rawValue)) {
        throw new Error(`${flag} requires an integer value; received "${rawValue ?? ''}".`);
    }
    const parsed = Number.parseInt(rawValue, 10);
    const minimum = allowZero ? 0 : 1;
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        throw new Error(`${flag} must be at least ${minimum}; received "${rawValue}".`);
    }
    return parsed;
}

/**
 * Parses CLI arguments for the Docker smoke runner.
 * @param {string[]} argv Arguments after the script path.
 * @returns {{
 *   help: boolean,
 *   image: string | null,
 *   startupTimeoutMs: number,
 *   stabilizeMs: number,
 *   pollIntervalMs: number,
 *   containerPort: number,
 * }}
 */
export function parseCliArgs(argv) {
    const parsed = {
        help: false,
        image: null,
        startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
        stabilizeMs: DEFAULT_STABILIZE_MS,
        pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
        containerPort: DEFAULT_CONTAINER_PORT,
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '-h' || arg === '--help') {
            parsed.help = true;
            return parsed;
        }
        if (arg === '--timeout-ms') {
            parsed.startupTimeoutMs = parsePositiveInt(arg, argv[++index]);
            continue;
        }
        if (arg === '--stabilize-ms') {
            parsed.stabilizeMs = parsePositiveInt(arg, argv[++index], { allowZero: true });
            continue;
        }
        if (arg === '--poll-interval-ms') {
            parsed.pollIntervalMs = parsePositiveInt(arg, argv[++index]);
            continue;
        }
        if (arg === '--container-port') {
            const port = parsePositiveInt(arg, argv[++index]);
            if (port > 65535) {
                throw new Error(`--container-port must be between 1 and 65535; received "${port}".`);
            }
            parsed.containerPort = port;
            continue;
        }
        if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        }
        if (parsed.image !== null) {
            throw new Error(`Unexpected extra positional argument: ${arg}`);
        }
        parsed.image = arg;
    }

    if (!parsed.image) {
        throw new Error('Missing required <image> argument.');
    }

    return parsed;
}

/**
 * Removes ANSI escape sequences from a log string.
 * @param {string} text Raw text.
 * @returns {string} Plain text.
 */
export function stripAnsi(text) {
    return stripVTControlCharacters(String(text ?? ''));
}

/**
 * Scans container logs for lines that match known fatal error patterns.
 * @param {string} logs Combined stdout and stderr logs.
 * @returns {{ lineNumber: number, line: string, reason: string }[]}
 */
export function findFatalLogLines(logs) {
    const matches = [];
    const lines = String(logs ?? '').split(/\r?\n/);

    for (let index = 0; index < lines.length; index++) {
        const cleanLine = stripAnsi(lines[index]).trim();
        if (!cleanLine) {
            continue;
        }

        for (const rule of FATAL_LOG_PATTERNS) {
            if (rule.pattern.test(cleanLine)) {
                matches.push({
                    lineNumber: index + 1,
                    line: cleanLine,
                    reason: rule.reason,
                });
                break;
            }
        }
    }

    return matches;
}

/**
 * Builds a POSIX sh script that verifies every required command exists on PATH.
 * @param {readonly { command: string }[]} [commands]
 * @returns {string}
 */
export function buildCommandCheckScript(commands = REQUIRED_IMAGE_COMMANDS) {
    const names = commands.map(entry => entry.command);
    for (const name of names) {
        if (!SAFE_COMMAND_NAME.test(name)) {
            throw new Error(`Invalid command name in inventory: "${name}"`);
        }
    }

    return [
        'missing=""',
        `for cmd in ${names.join(' ')}; do`,
        '    if ! command -v "$cmd" >/dev/null 2>&1; then',
        '        printf \'MISSING:%s\\n\' "$cmd"',
        '        missing="$missing $cmd"',
        '    fi',
        'done',
        'if [ -n "$missing" ]; then',
        '    exit 1',
        'fi',
    ].join('\n');
}

/**
 * Extracts alpine apk package names installed by RUN apk add instructions.
 * @param {string} dockerfileContent Raw Dockerfile text.
 * @returns {Set<string>}
 */
export function parseDockerfileApkPackages(dockerfileContent) {
    const packages = new Set();
    // Collapse Dockerfile line continuations before scanning shell statements.
    const joined = String(dockerfileContent ?? '').replace(/\\\r?\n/g, ' ');

    for (const rawLine of joined.split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!/^RUN\s+/i.test(trimmed)) {
            continue;
        }

        const commandLine = trimmed.replace(/^RUN\s+/i, '');
        const segments = commandLine.split(/&&|\|\||;/);
        for (const segment of segments) {
            const match = /\bapk\s+add\b(.*)$/.exec(segment);
            if (!match) {
                continue;
            }
            const tokens = match[1].trim().split(/\s+/).filter(Boolean);
            for (let index = 0; index < tokens.length; index++) {
                const token = tokens[index];
                if (token === '--virtual' || token === '-t') {
                    // Skip the virtual group name that follows -t / --virtual.
                    index++;
                    continue;
                }
                if (token.startsWith('-')) {
                    continue;
                }
                const packageName = token.replace(/[=<>~].*$/, '');
                if (packageName) {
                    packages.add(packageName);
                }
            }
        }
    }

    return packages;
}

/**
 * Lists required apk-installed commands whose package is absent from Dockerfile.
 * @param {string} dockerfileContent Raw Dockerfile text.
 * @param {readonly { command: string, source: string, apkPackage?: string }[]} [commands]
 * @returns {{ command: string, apkPackage: string }[]}
 */
export function findMissingDockerfilePackages(dockerfileContent, commands = REQUIRED_IMAGE_COMMANDS) {
    const installedPackages = parseDockerfileApkPackages(dockerfileContent);
    const missing = [];

    for (const entry of commands) {
        if (entry.source === 'apk' && entry.apkPackage && !installedPackages.has(entry.apkPackage)) {
            missing.push({ command: entry.command, apkPackage: entry.apkPackage });
        }
    }

    return missing;
}

/**
 * Runs the Docker CLI without a shell and returns structured output.
 * @param {string[]} args Docker CLI arguments.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string, error: Error | null }>}
 */
export function defaultRunDocker(args, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        execFile('docker', args, {
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            if (error && error.code === 'ENOENT') {
                reject(new Error('Docker CLI ("docker") was not found on PATH.'));
                return;
            }

            if (!error) {
                resolve({ status: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: null });
                return;
            }

            const status = typeof error.code === 'number' ? error.code : 1;
            resolve({
                status,
                stdout: String(stdout ?? ''),
                stderr: String(stderr ?? ''),
                error,
            });
        });
    });
}

/**
 * Allocates an ephemeral free TCP port on the loopback interface.
 * @param {string} [host]
 * @returns {Promise<number>}
 */
export function findFreePort(host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, host, () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : null;
            server.close((closeError) => {
                if (closeError) {
                    reject(closeError);
                    return;
                }
                if (!port) {
                    reject(new Error('Could not allocate an ephemeral loopback port.'));
                    return;
                }
                resolve(port);
            });
        });
    });
}

/**
 * Verifies every command in the inventory resolves via `command -v` inside the image.
 * @param {string} image Docker image reference.
 * @param {{
 *   commands?: readonly { command: string }[],
 *   runDocker?: typeof defaultRunDocker,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {Promise<{ ok: true, checked: string[] }>}
 */
export async function checkRequiredCommands(image, {
    commands = REQUIRED_IMAGE_COMMANDS,
    runDocker = defaultRunDocker,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
} = {}) {
    const script = buildCommandCheckScript(commands);
    const result = await runDocker(
        ['run', '--rm', '--entrypoint', 'sh', image, '-c', script],
        { timeoutMs },
    );

    const missing = [...result.stdout.matchAll(/^MISSING:(.+)$/gm)].map(match => match[1].trim());
    if (result.status !== 0 || missing.length > 0) {
        if (missing.length > 0) {
            throw new Error(`Required commands missing from image "${image}": ${missing.join(', ')}.`);
        }
        const detail = (result.stderr || result.stdout || result.error?.message || 'unknown error').trim();
        throw new Error(`Command inventory check failed for image "${image}" (exit ${result.status}): ${detail}`);
    }

    return { ok: true, checked: commands.map(entry => entry.command) };
}

function parseInspectState(stdout) {
    const [running, status, exitCode, oomKilled, restartCount] = String(stdout ?? '').trim().split('|');
    return {
        running: running === 'true',
        status: status || 'unknown',
        exitCode: Number.parseInt(exitCode || '0', 10),
        oomKilled: oomKilled === 'true',
        restartCount: Number.parseInt(restartCount || '0', 10),
    };
}

async function fetchWithTimeout(fetchFn, url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
        return await fetchFn(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function probeServerReady(baseUrl, { fetchFn, requestTimeoutMs }) {
    const indexResponse = await fetchWithTimeout(fetchFn, `${baseUrl}/`, requestTimeoutMs);
    const indexStatus = indexResponse.status;
    await indexResponse.text?.().catch(() => '');
    if (indexStatus !== 200) {
        return { ready: false, detail: `GET / returned HTTP ${indexStatus}` };
    }

    return await probeCsrfEndpoint(baseUrl, { fetchFn, requestTimeoutMs });
}

async function probeCsrfEndpoint(baseUrl, { fetchFn, requestTimeoutMs }) {
    const csrfResponse = await fetchWithTimeout(fetchFn, `${baseUrl}/csrf-token`, requestTimeoutMs);
    const csrfStatus = csrfResponse.status;
    const rawBody = await csrfResponse.text?.().catch(() => '');
    if (csrfStatus !== 200) {
        return { ready: false, detail: `GET /csrf-token returned HTTP ${csrfStatus}` };
    }

    let payload;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return { ready: false, detail: 'GET /csrf-token did not return valid JSON' };
    }

    if (typeof payload?.token !== 'string' || payload.token.length === 0) {
        return { ready: false, detail: 'GET /csrf-token returned an empty token' };
    }

    return { ready: true, detail: 'GET / and GET /csrf-token returned HTTP 200' };
}

async function readContainerLogs(runDocker, containerName) {
    try {
        const result = await runDocker(['logs', containerName], { timeoutMs: 15_000 });
        return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    } catch {
        return '';
    }
}

function formatLogsAppendix(logs) {
    return logs ? `\n--- Container logs ---\n${logs}` : '\n--- Container logs ---\n(no log output captured)';
}

function defaultSleep(ms) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

/**
 * Runs the full Docker image smoke check: required commands, container boot,
 * HTTP readiness, stabilization liveness check, fatal log scan, and cleanup.
 * @param {string} image Docker image tag or ID to verify.
 * @param {object} [options]
 * @param {readonly { command: string }[]} [options.commands]
 * @param {number} [options.containerPort]
 * @param {number} [options.startupTimeoutMs]
 * @param {number} [options.stabilizeMs]
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.requestTimeoutMs]
 * @param {string} [options.containerName]
 * @param {typeof defaultRunDocker} [options.runDocker]
 * @param {typeof fetch} [options.fetchFn]
 * @param {typeof findFreePort} [options.allocatePort]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{
 *   image: string,
 *   containerName: string,
 *   hostPort: number,
 *   checkedCommands: string[],
 *   logs: string,
 * }>}
 */
export async function runDockerSmoke(image, {
    commands = REQUIRED_IMAGE_COMMANDS,
    containerPort = DEFAULT_CONTAINER_PORT,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    stabilizeMs = DEFAULT_STABILIZE_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    containerName = `sillybunny-smoke-${randomBytes(6).toString('hex')}`,
    runDocker = defaultRunDocker,
    fetchFn = globalThis.fetch,
    allocatePort = findFreePort,
    sleep = defaultSleep,
    now = () => Date.now(),
    log = console.log,
} = {}) {
    if (!image || typeof image !== 'string') {
        throw new Error('A Docker image reference is required.');
    }

    log(`[docker-smoke] Checking ${commands.length} required commands in ${image}...`);
    const { checked: checkedCommands } = await checkRequiredCommands(image, { commands, runDocker });
    log(`[docker-smoke] All required commands present: ${checkedCommands.join(', ')}`);

    const hostPort = await allocatePort('127.0.0.1');
    const baseUrl = `http://127.0.0.1:${hostPort}`;
    let containerAttempted = false;

    try {
        log(`[docker-smoke] Starting ${image} as ${containerName} on 127.0.0.1:${hostPort}->${containerPort}...`);
        containerAttempted = true;
        const startResult = await runDocker([
            'run',
            '-d',
            '--name', containerName,
            '-p', `127.0.0.1:${hostPort}:${containerPort}`,
            image,
        ]);

        if (startResult.status !== 0) {
            const logs = await readContainerLogs(runDocker, containerName);
            const detail = (startResult.stderr || startResult.stdout || startResult.error?.message || 'unknown error').trim();
            throw new Error(`Failed to start container for "${image}" (exit ${startResult.status}): ${detail}${formatLogsAppendix(logs)}`);
        }

        const deadline = now() + startupTimeoutMs;
        let ready = false;
        let lastProbeDetail = 'no probe completed';

        while (true) {
            const inspectResult = await runDocker([
                'inspect',
                '--format',
                '{{.State.Running}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.RestartCount}}',
                containerName,
            ]);

            if (inspectResult.status !== 0) {
                const detail = (inspectResult.stderr || inspectResult.stdout || 'inspect failed').trim();
                throw new Error(`Failed to inspect container "${containerName}": ${detail}`);
            }

            const state = parseInspectState(inspectResult.stdout);
            if (!state.running) {
                const logs = await readContainerLogs(runDocker, containerName);
                throw new Error(
                    `Container "${containerName}" exited before becoming ready `
                    + `(status: ${state.status}, exitCode: ${state.exitCode}, oomKilled: ${state.oomKilled}).`
                    + formatLogsAppendix(logs),
                );
            }

            try {
                const probe = await probeServerReady(baseUrl, { fetchFn, requestTimeoutMs });
                if (probe.ready) {
                    ready = true;
                    break;
                }
                lastProbeDetail = probe.detail;
            } catch (error) {
                lastProbeDetail = error instanceof Error ? error.message : String(error);
            }

            if (now() >= deadline) {
                break;
            }

            await sleep(pollIntervalMs);
        }

        if (!ready) {
            const logs = await readContainerLogs(runDocker, containerName);
            throw new Error(
                `Container "${containerName}" did not become ready at ${baseUrl} within ${startupTimeoutMs} ms `
                + `(last probe: ${lastProbeDetail}).`
                + formatLogsAppendix(logs),
            );
        }

        log(`[docker-smoke] Server answered at ${baseUrl}; waiting ${stabilizeMs} ms to confirm stability...`);
        if (stabilizeMs > 0) {
            await sleep(stabilizeMs);
        }

        const postInspect = await runDocker([
            'inspect',
            '--format',
            '{{.State.Running}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.RestartCount}}',
            containerName,
        ]);

        if (postInspect.status !== 0) {
            const detail = (postInspect.stderr || postInspect.stdout || 'inspect failed').trim();
            throw new Error(`Failed to inspect container "${containerName}" after stabilization: ${detail}`);
        }

        const postState = parseInspectState(postInspect.stdout);
        if (!postState.running || postState.restartCount > 0) {
            const logs = await readContainerLogs(runDocker, containerName);
            throw new Error(
                `Container "${containerName}" was not stable after startup `
                + `(running: ${postState.running}, status: ${postState.status}, `
                + `exitCode: ${postState.exitCode}, restartCount: ${postState.restartCount}).`
                + formatLogsAppendix(logs),
            );
        }

        try {
            const stabilityProbe = await probeCsrfEndpoint(baseUrl, { fetchFn, requestTimeoutMs });
            if (!stabilityProbe.ready) {
                const logs = await readContainerLogs(runDocker, containerName);
                throw new Error(
                    `Server failed post-stabilization check (${stabilityProbe.detail}).`
                    + formatLogsAppendix(logs),
                );
            }
        } catch (error) {
            if (error instanceof Error && error.message.includes('--- Container logs ---')) {
                throw error;
            }
            const logs = await readContainerLogs(runDocker, containerName);
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Server failed post-stabilization check (${detail}).${formatLogsAppendix(logs)}`);
        }

        const logs = await readContainerLogs(runDocker, containerName);
        const fatalLines = findFatalLogLines(logs);
        if (fatalLines.length > 0) {
            const summary = fatalLines
                .map(item => `  L${item.lineNumber} [${item.reason}]: ${item.line}`)
                .join('\n');
            throw new Error(
                `Found ${fatalLines.length} fatal error line(s) in container logs:\n${summary}`
                + formatLogsAppendix(logs),
            );
        }

        log(`[docker-smoke] Passed for ${image}.`);
        return {
            image,
            containerName,
            hostPort,
            checkedCommands,
            logs,
        };
    } finally {
        if (containerAttempted) {
            try {
                await runDocker(['rm', '-f', containerName], { timeoutMs: 15_000 });
            } catch {
                // Ignore cleanup failure so the primary smoke result is preserved.
            }
        }
    }
}

async function main(argv) {
    let options;
    try {
        options = parseCliArgs(argv);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        console.error('Run with --help for usage.');
        process.exitCode = EXIT.usage;
        return;
    }

    if (options.help) {
        printHelp();
        process.exitCode = EXIT.ok;
        return;
    }

    try {
        await runDockerSmoke(options.image, {
            containerPort: options.containerPort,
            startupTimeoutMs: options.startupTimeoutMs,
            stabilizeMs: options.stabilizeMs,
            pollIntervalMs: options.pollIntervalMs,
        });
        process.exitCode = EXIT.ok;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT.failed;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await main(process.argv.slice(2));
}
