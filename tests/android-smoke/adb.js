/**
 * A small adb client for the Android smoke, plus the parsers for what the device prints. The parsers are
 * pure and covered by Jest; the client only spawns `adb -s <serial> ...` with deadlines and abort signals.
 * Port rules (plan §7.1, P6.1): fixtures reach the guest through `adb reverse`, the host reaches the app's
 * server and the WebView through `adb forward`, and port 4444 is never forwarded or reversed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { RESERVED_PORTS } from './ports.js';

/** am instrument status codes (`InstrumentationResultPrinter`). */
const TEST_STATUS = Object.freeze({ 1: 'started', 0: 'passed', '-1': 'error', '-2': 'failed', '-3': 'ignored', '-4': 'assumption-failure' });

/**
 * Quotes one argument for the device's `sh` (adb joins `shell` arguments with spaces).
 * @param {string|number} value Argument.
 * @returns {string} Quoted argument.
 */
export function shellQuote(value) {
    const text = String(value);
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) {
        return text;
    }
    return `'${text.replace(/'/g, '\'\\\'\'')}'`;
}

/**
 * Joins arguments into one device command line.
 * @param {Array<string|number>} args Arguments.
 * @returns {string} Command line.
 */
export function shellCommand(args) {
    return args.map(shellQuote).join(' ');
}

/**
 * Base64 for the device's `base64 -d`, in the 76-column lines `base64` itself writes. The input is encoded
 * in one piece, because toybox's decoder stops at the first `=`.
 * @param {Buffer|string} contents Bytes (a string is UTF-8).
 * @returns {string} Encoded text, ending with a newline.
 */
export function base64Lines(contents) {
    const text = Buffer.from(contents).toString('base64');
    const lines = [];
    for (let start = 0; start < text.length; start += 76) {
        lines.push(text.slice(start, start + 76));
    }
    return `${lines.join('\n')}\n`;
}

/**
 * First pid that `pidof` printed.
 * @param {string} text Output.
 * @returns {number|null} Pid.
 */
export function parsePidof(text) {
    const match = /^\s*(\d+)/.exec(String(text));
    return match ? Number(match[1]) : null;
}

/**
 * The port `adb forward tcp:0 ...` allocated, or the explicit one it echoed.
 * @param {string} text Output.
 * @returns {number|null} Port.
 */
export function parseForwardPort(text) {
    const match = /^\s*(\d+)\s*$/m.exec(String(text));
    return match ? Number(match[1]) : null;
}

/**
 * Reads the smoke hook's reply: `content call` prints `Result: Bundle[{json=<JSON>}]`.
 * @param {string} text Output.
 * @returns {object|null} Decoded JSON, or null when the output carries none.
 */
export function parseHookResult(text) {
    const match = /Result: Bundle\[\{json=([\s\S]*)\}\]\s*$/.exec(String(text).trim());
    if (!match) {
        return null;
    }
    try {
        return JSON.parse(match[1]);
    } catch {
        return null;
    }
}

/**
 * Parses `am instrument -r` output.
 * @param {string} text Raw output.
 * @returns {{tests: Array<{className: string, test: string, status: string, stack?: string}>, code: number|null,
 *     shortMsg: string|null, failedToStart: string|null, crashed: boolean, ok: boolean}} Result.
 */
export function parseInstrumentation(text) {
    const tests = [];
    let status = {};
    const result = {};
    let current = null;
    let code = null;
    let failedToStart = null;
    for (const line of String(text).replace(/\r/g, '').split('\n')) {
        let match;
        if ((match = /^INSTRUMENTATION_STATUS: ([^=]+)=(.*)$/.exec(line))) {
            current = { target: status, key: match[1] };
            status[match[1]] = match[2];
        } else if ((match = /^INSTRUMENTATION_STATUS_CODE: (-?\d+)$/.exec(line))) {
            const name = TEST_STATUS[match[1]] ?? `code-${match[1]}`;
            if (name !== 'started' && status.test !== undefined) {
                const entry = { className: status.class ?? '', test: status.test, status: name };
                if (status.stack) {
                    entry.stack = status.stack.trim();
                }
                tests.push(entry);
            }
            status = {};
            current = null;
        } else if ((match = /^INSTRUMENTATION_RESULT: ([^=]+)=(.*)$/.exec(line))) {
            current = { target: result, key: match[1] };
            result[match[1]] = match[2];
        } else if ((match = /^INSTRUMENTATION_CODE: (-?\d+)$/.exec(line))) {
            code = Number(match[1]);
            current = null;
        } else if ((match = /^INSTRUMENTATION_FAILED: (.*)$/.exec(line))) {
            failedToStart = match[1];
            current = null;
        } else if (current) {
            current.target[current.key] += `\n${line}`;
        }
    }
    const shortMsg = result.shortMsg?.trim() ?? null;
    const crashed = /process crashed/i.test(shortMsg ?? '') || /process crashed/i.test(result.longMsg ?? '');
    const ok = code === -1 && !crashed && failedToStart === null && tests.length > 0 && tests.every(test => test.status === 'passed');
    return { tests, code, shortMsg, failedToStart, crashed, ok };
}

/**
 * DNS servers of the networks `dumpsys connectivity` lists (`DnsAddresses: [ /10.0.2.3,/fec0::3 ]`).
 * @param {string} text Output.
 * @returns {string[]} Unique addresses.
 */
export function parseDnsAddresses(text) {
    const found = new Set();
    for (const match of String(text).matchAll(/DnsAddresses: \[([^\]]*)\]/g)) {
        for (const item of match[1].split(',')) {
            const address = item.trim().replace(/^\//, '');
            if (address) {
                found.add(address);
            }
        }
    }
    return [...found];
}

/**
 * The address `ping` resolved a name to, from its first line (`PING host (1.2.3.4) 56(84) bytes ...`).
 * ICMP itself may be blocked on the runner; only the name resolution matters here.
 * @param {string} text Output.
 * @returns {string|null} Address.
 */
export function parsePingResolution(text) {
    const match = /^PING \S+ \(([0-9a-fA-F:.]+)\)/m.exec(String(text));
    return match ? match[1] : null;
}

/**
 * `emulator -accel-check`: usable only with exit code 0 and an "is installed and usable" line.
 * @param {string} text Output.
 * @param {number|null} code Exit code.
 * @returns {boolean} Usable.
 */
export function accelUsable(text, code) {
    return code === 0 && /is installed and usable/i.test(String(text));
}

/**
 * `emulator -version`: `Android emulator version 37.2.12.0 (build_id 16428233) (CL:N/A)`.
 * @param {string} text Output.
 * @returns {{version: string|null, buildId: string|null}} Version.
 */
export function parseEmulatorVersion(text) {
    const version = /emulator version (\d+(?:\.\d+)+)/i.exec(String(text));
    const build = /build_id (\d+)/i.exec(String(text));
    return { version: version ? version[1] : null, buildId: build ? build[1] : null };
}

/**
 * The emulator's version from its launcher. Plain `-version` runs the windowed Linux QEMU, which needs
 * `libpulse.so.0` and `libxkbfile.so.1`; without them it exits 127 and prints no version. `-no-window` selects the
 * headless QEMU, the one the smoke's emulator runs.
 * @param {string} emulator The `emulator` launcher.
 * @param {typeof runCommand} [run] Runs the command.
 * @returns {Promise<{version: string|null, buildId: string|null}>} Version.
 */
export async function readEmulatorVersion(emulator, run = runCommand) {
    const result = await run(emulator, ['-no-window', '-version'], { timeoutMs: 60_000 });
    return parseEmulatorVersion(`${result.stdout}\n${result.stderr}`);
}

/**
 * `key=value` lines (AVD `.ini` files, `source.properties`).
 * @param {string} text Contents.
 * @returns {Record<string, string>} Values.
 */
export function parseIni(text) {
    const values = {};
    for (const line of String(text).replace(/\r/g, '').split('\n')) {
        const match = /^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
        if (match) {
            values[match[1]] = match[2];
        }
    }
    return values;
}

/**
 * The focused window's title from `dumpsys window`: `mCurrentFocus=Window{5346ae5 u0 <title>}`.
 * @param {string} text Output.
 * @returns {string|null} Title, or null when no window has the focus.
 */
export function parseFocusedWindow(text) {
    const match = /mCurrentFocus=Window\{\S+ u\d+ ([^}\r\n]+)\}/.exec(String(text));
    return match ? match[1] : null;
}

/**
 * Whether a window title is the system's "isn't responding" or "has stopped" dialog, which the system titles
 * `Application Not Responding: <process>` and `Application Error: <process>`.
 * @param {string|null} title Window title.
 * @returns {boolean} True for an error dialog.
 */
export function isErrorDialogWindow(title) {
    return /^Application (Not Responding|Error): /.test(String(title ?? ''));
}

/**
 * versionCode and versionName from `dumpsys package <pkg>`.
 * @param {string} text Output.
 * @returns {{versionCode: number|null, versionName: string|null}} Version.
 */
export function parsePackageVersion(text) {
    const code = /versionCode=(\d+)/.exec(String(text));
    const name = /versionName=(\S+)/.exec(String(text));
    return { versionCode: code ? Number(code[1]) : null, versionName: name ? name[1] : null };
}

/**
 * Whether `dumpsys notification` shows notification `id` of `pkg` on `channel` as posted. Posted notifications
 * are the `NotificationRecord(0x<hash>: pkg=<pkg> user=<user> id=<id> ...: Notification(channel=<channel> ...`
 * lines of the notification list, which ends before the `mArchive=` line. After that line come the archive,
 * whose `StatusBarNotification(pkg=...` lines keep cancelled notifications (installing an update cancels all of
 * the package's notifications), and the enqueued list, whose records are not posted yet.
 * @param {string} text Output.
 * @param {{pkg: string, id: number, channel: string}} notification Package, notification id and channel id.
 * @returns {boolean} Whether it is posted.
 */
export function notificationPosted(text, { pkg, id, channel }) {
    const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const record = new RegExp(`^ *NotificationRecord\\(0x[0-9a-f]+: pkg=${escape(pkg)} user=\\S+ id=${id} .*: Notification\\(channel=${escape(channel)} `, 'm');
    return record.test(String(text).split(/^ {2}mArchive=/m)[0]);
}

/**
 * The WebView provider in use, from `dumpsys webviewupdate`:
 * `Current WebView package (name, version): (com.android.webview, 74.0.3729.185)`.
 * @param {string} text Output.
 * @returns {{package: string, version: string, major: number|null}|null} Provider, or null when the dump names none.
 */
export function parseWebViewPackage(text) {
    const match = /Current WebView package \(name, version\): \(([^,\s]+), ([^)\s]+)\)/.exec(String(text));
    if (!match) {
        return null;
    }
    const major = /^(\d+)\./.exec(match[2]);
    return { package: match[1], version: match[2], major: major ? Number(major[1]) : null };
}

/**
 * Processes from `ps -A -o PID,PPID,USER,NAME,ARGS` (toybox).
 * @param {string} text Output.
 * @returns {Array<{pid: number, ppid: number, user: string, name: string, args: string}>} Processes.
 */
export function parseProcesses(text) {
    const processes = [];
    for (const line of String(text).replace(/\r/g, '').split('\n').slice(1)) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
        if (match) {
            processes.push({ pid: Number(match[1]), ppid: Number(match[2]), user: match[3], name: match[4], args: match[5] });
        }
    }
    return processes;
}

/**
 * Crashes in the crash log buffer (`logcat -b crash -v threadtime`): the native crash dumps that debuggerd writes as
 * `DEBUG` lines from `*** *** ***` on, and the uncaught Java exceptions (`AndroidRuntime: FATAL EXCEPTION`). Each
 * crash gets a one-line `summary`.
 * @param {string} text Output.
 * @returns {Array<{kind: 'native'|'java', time: string, pid: number|null, thread: string|null, process: string|null,
 *     signal: string|null, message: string|null, summary: string}>} Crashes, oldest first.
 */
export function parseCrashLog(text) {
    const crashes = [];
    let current = null;
    let exceptionNext = false;
    for (const line of String(text).replace(/\r/g, '').split('\n')) {
        const entry = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+\d+\s+\d+\s+[VDIWEF]\s+(\S+?)\s*: ?(.*)$/.exec(line);
        if (!entry) {
            continue;
        }
        const [, time, tag, message] = entry;
        if (tag === 'DEBUG') {
            if (message.startsWith('*** *** ***')) {
                current = { kind: 'native', time, pid: null, thread: null, process: null, signal: null, message: null };
                crashes.push(current);
            } else if (current?.kind === 'native') {
                // API 37 adds the parent pid: `pid: 10407, ppid: 444, tid: 10407, name: ...`.
                const header = /^pid: (\d+), (?:ppid: \d+, )?tid: \d+, name: (.*?)\s+>>> (.*) <<<$/.exec(message);
                const signal = /^signal \d+ \((\w+)\)/.exec(message);
                // An abort message can go on over several lines; the first one says what failed.
                const abort = /^Abort message: '(.*?)'?$/.exec(message);
                if (header) {
                    Object.assign(current, { pid: Number(header[1]), thread: header[2], process: header[3] });
                } else if (signal && current.signal === null) {
                    current.signal = signal[1];
                } else if (abort && current.message === null) {
                    current.message = abort[1];
                }
            }
        } else if (tag === 'AndroidRuntime') {
            const fatal = /^FATAL EXCEPTION: (.*)$/.exec(message);
            const process = /^Process: (.*), PID: (\d+)$/.exec(message);
            if (fatal) {
                current = { kind: 'java', time, pid: null, thread: fatal[1], process: null, signal: null, message: null };
                crashes.push(current);
                exceptionNext = false;
            } else if (current?.kind === 'java' && process) {
                Object.assign(current, { process: process[1], pid: Number(process[2]) });
                exceptionNext = true;
            } else if (current?.kind === 'java' && exceptionNext && message.trim() !== '') {
                current.message = message.trim();
                exceptionNext = false;
            }
        }
    }
    return crashes.map(crash => ({ ...crash, summary: crashSummary(crash) }));
}

function crashSummary(crash) {
    const program = String(crash.process ?? '').split(' ')[0];
    const name = program.includes('/') ? program.slice(program.lastIndexOf('/') + 1) : program || 'an unknown process';
    const what = crash.signal ?? (crash.kind === 'java' ? 'an uncaught exception' : 'a native crash');
    const thread = crash.thread ? ` in ${crash.thread}` : '';
    const message = crash.message ? `: ${crash.message.slice(0, 240)}` : '';
    return `${what}${thread} of ${name} at ${crash.time}${message}`;
}

/**
 * Whether a crashed process is the app's: its own processes, and the programs it starts by a path in its install or
 * data directory. An abort or a segmentation fault of the app's Node leaves no entry: signal-exit listeners from the
 * server's dependencies take SIGABRT, and Node's WebAssembly trap handler takes SIGSEGV. Both end Node by the signal's
 * default action, which writes no crash dump.
 * @param {{process: string|null}} crash Crash from {@link parseCrashLog}.
 * @param {string} pkg Application id.
 * @returns {boolean} Whether it is.
 */
export function isAppCrash(crash, pkg) {
    const process = String(crash.process ?? '');
    return process === pkg || process.startsWith(`${pkg}:`) || process.includes(`/${pkg}-`) || process.includes(`/${pkg}/`);
}

function checkPortSpec(spec) {
    const match = /^tcp:(\d+)$/.exec(spec);
    if (match && RESERVED_PORTS.includes(Number(match[1]))) {
        throw new Error(`Refusing to map reserved port ${match[1]}.`);
    }
}

/**
 * Runs a command and collects its output.
 * @param {string} file Executable.
 * @param {string[]} args Arguments.
 * @param {object} [options] Options.
 * @param {number} [options.timeoutMs] Deadline (default 120 s).
 * @param {AbortSignal} [options.signal] Abort signal; aborting kills the process.
 * @param {Buffer|string} [options.input] Stdin contents; stdin is closed either way.
 * @param {boolean} [options.binary] Keep stdout as a Buffer.
 * @param {NodeJS.ProcessEnv} [options.env] Environment.
 * @returns {Promise<{code: number|null, stdout: string|Buffer, stderr: string, timedOut: boolean}>} Result.
 */
export function runCommand(file, args, { timeoutMs = 120_000, signal, input, binary = false, env } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new Error('aborted'));
            return;
        }
        const child = spawn(file, args, { windowsHide: true, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
        const stdout = [];
        const stderr = [];
        let timedOut = false;
        let settled = false;
        const stop = () => {
            try {
                child.kill('SIGKILL');
            } catch {
                // Already gone.
            }
        };
        const timer = setTimeout(() => {
            timedOut = true;
            stop();
        }, timeoutMs);
        const onAbort = () => stop();
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', chunk => stdout.push(chunk));
        child.stderr.on('data', chunk => stderr.push(chunk));
        child.stdin.on('error', () => {
            // The command may exit before reading its input; the exit code decides.
        });
        child.on('error', (error) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                reject(error);
            }
        });
        child.on('close', (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) {
                reject(signal.reason ?? new Error('aborted'));
                return;
            }
            const out = Buffer.concat(stdout);
            resolve({ code, stdout: binary ? out : out.toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut });
        });
        if (input !== undefined) {
            child.stdin.end(input);
        } else {
            child.stdin.end();
        }
    });
}

/** adb bound to one device serial. */
export class Adb {
    /**
     * @param {object} options Options.
     * @param {string} options.serial Device serial.
     * @param {string} [options.adb] adb executable.
     * @param {(line: string) => void} [options.log] Command log.
     */
    constructor({ serial, adb = 'adb', log = () => {} }) {
        if (!serial) {
            throw new Error('A device serial is required.');
        }
        this.serial = serial;
        this.file = adb;
        this.log = log;
        this.forwards = new Set();
        this.reverses = new Set();
    }

    /**
     * Runs `adb -s <serial> <args>`.
     * @param {string[]} args Arguments.
     * @param {object} [options] {@link runCommand} options plus `check` (throw on a non-zero exit, default true).
     * @returns {Promise<{code: number|null, stdout: string|Buffer, stderr: string, timedOut: boolean}>} Result.
     */
    async run(args, { check = true, ...options } = {}) {
        this.log(`adb ${args.join(' ')}`);
        const result = await runCommand(this.file, ['-s', this.serial, ...args], options);
        if (check && (result.code !== 0 || result.timedOut)) {
            const output = `${binaryText(result.stdout)}\n${result.stderr}`.trim().slice(-2000);
            throw new Error(`adb ${args.join(' ')} ${result.timedOut ? 'timed out' : `exited ${result.code}`}: ${output}`);
        }
        return result;
    }

    /**
     * Runs one device command line (arguments are quoted for the device shell).
     * @param {Array<string|number>} args Command and arguments.
     * @param {object} [options] {@link Adb#run} options.
     * @returns {Promise<{code: number|null, stdout: string|Buffer, stderr: string, timedOut: boolean}>} Result.
     */
    shell(args, options) {
        return this.run(['shell', shellCommand(args)], options);
    }

    /** Device shell output, trimmed. */
    async shellText(args, options) {
        return String((await this.shell(args, options)).stdout).trim();
    }

    async getprop(name, options) {
        return this.shellText(['getprop', name], options);
    }

    async sdkLevel() {
        return Number(await this.getprop('ro.build.version.sdk'));
    }

    async state() {
        const result = await this.run(['get-state'], { check: false, timeoutMs: 15_000 });
        return String(result.stdout).trim();
    }

    async pidof(pkg, options) {
        const result = await this.shell(['pidof', pkg], { check: false, ...options });
        return result.code === 0 ? parsePidof(result.stdout) : null;
    }

    async install(apk, { timeoutMs = 300_000, signal } = {}) {
        return this.run(['install', '-r', '-t', apk], { timeoutMs, signal });
    }

    async uninstall(pkg, { signal } = {}) {
        return this.run(['uninstall', pkg], { check: false, timeoutMs: 120_000, signal });
    }

    /**
     * Maps a device port to a host port (`adb reverse tcp:<device> tcp:<host>`).
     * @param {number} devicePort Port the app connects to on the guest's 127.0.0.1.
     * @param {number} hostPort Port of the fixture on the host's 127.0.0.1.
     */
    async reverse(devicePort, hostPort) {
        const device = `tcp:${devicePort}`;
        const host = `tcp:${hostPort}`;
        checkPortSpec(device);
        checkPortSpec(host);
        await this.run(['reverse', device, host], { timeoutMs: 30_000 });
        this.reverses.add(device);
    }

    async removeReverse(devicePort) {
        const device = `tcp:${devicePort}`;
        await this.run(['reverse', '--remove', device], { check: false, timeoutMs: 30_000 });
        this.reverses.delete(device);
    }

    /**
     * Maps a host port to a device socket (`adb forward tcp:<host> <device>`).
     * @param {number} hostPort Host port (a free fixture-range port).
     * @param {string} deviceSpec `tcp:<port>` or `localabstract:<name>`.
     * @returns {Promise<number>} Host port.
     */
    async forward(hostPort, deviceSpec) {
        const host = `tcp:${hostPort}`;
        checkPortSpec(host);
        checkPortSpec(deviceSpec);
        await this.run(['forward', host, deviceSpec], { timeoutMs: 30_000 });
        this.forwards.add(host);
        return hostPort;
    }

    async removeForward(hostPort) {
        const host = `tcp:${hostPort}`;
        await this.run(['forward', '--remove', host], { check: false, timeoutMs: 30_000 });
        this.forwards.delete(host);
    }

    /** Removes every forward and reverse rule this client created. */
    async removeAllRules() {
        for (const host of [...this.forwards]) {
            await this.run(['forward', '--remove', host], { check: false, timeoutMs: 30_000 });
            this.forwards.delete(host);
        }
        for (const device of [...this.reverses]) {
            await this.run(['reverse', '--remove', device], { check: false, timeoutMs: 30_000 });
            this.reverses.delete(device);
        }
    }

    /**
     * Runs a command as the (debuggable) app.
     * @param {string} pkg Package.
     * @param {Array<string|number>} args Command and arguments, run in the app's data directory.
     * @param {object} [options] {@link Adb#run} options.
     */
    runAs(pkg, args, options) {
        return this.shell(['run-as', pkg, ...args], options);
    }

    // App files cross as base64 through `adb shell`, which reports the device command's exit status. adb on
    // Windows reads `shell` stdin and writes `shell` stdout in text mode: CRLF becomes LF on the way in, a
    // Ctrl-Z byte ends the input, and LF becomes CRLF on the way out. `exec-in` and `exec-out` keep the
    // bytes but report no exit status, so a failed write would pass unseen.

    /** A file of the app's data directory, or null when it cannot be read. */
    async readAppFile(pkg, relative, options = {}) {
        const result = await this.runAs(pkg, ['base64', relative], { check: false, ...options });
        return result.code === 0 ? Buffer.from(String(result.stdout), 'base64') : null;
    }

    /** Writes a file of the app's data directory; fails when the device command fails. */
    async writeAppFile(pkg, relative, contents, options = {}) {
        await this.runAs(pkg, ['sh', '-c', `base64 -d > ${shellQuote(relative)}`], { input: base64Lines(contents), ...options });
    }

    /**
     * Unpacks a tar archive into a directory of the app's data directory; fails when the device command
     * fails. The archive goes through a file in the app's cache, because a pipe into tar would report only
     * tar's status. `-o` leaves the files to the app: without it, API 29's toybox tar tries to give them the
     * archive's owner, which the app user may not do, and exits 1.
     */
    async untarIntoApp(pkg, relativeDir, archive, options = {}) {
        const dir = shellQuote(relativeDir);
        const upload = 'cache/smoke-upload.tar';
        const script = `mkdir -p cache ${dir} && base64 -d > ${upload} && tar -x -o -f ${upload} -C ${dir}; status=$?; rm -f ${upload}; exit $status`;
        await this.runAs(pkg, ['sh', '-c', script], { input: base64Lines(archive), timeoutMs: 300_000, ...options });
    }

    /** A tar archive of a folder of the app's data directory, or null when tar fails. */
    async readAppArchive(pkg, relative, options = {}) {
        const archive = 'cache/smoke-archive.tar';
        const script = `mkdir -p cache && tar -cf ${archive} ${shellQuote(relative)} && base64 ${archive}; status=$?; rm -f ${archive}; exit $status`;
        const result = await this.runAs(pkg, ['sh', '-c', script], { check: false, ...options });
        return result.code === 0 ? Buffer.from(String(result.stdout), 'base64') : null;
    }

    /**
     * Calls the debug build's smoke hook (`android/app/src/debug/.../SmokeHookProvider.kt`).
     * @param {string} pkg Application id.
     * @param {string} method `state`, `handoff` or `kill`.
     * @param {object} [options] {@link Adb#run} options, and `arg`, the method's argument (`kill`: a pid).
     * @returns {Promise<object>} Decoded reply.
     */
    async hook(pkg, method, { arg, ...options } = {}) {
        const command = ['content', 'call', '--uri', `content://${pkg}.smoke`, '--method', method];
        if (arg !== undefined) {
            command.push('--arg', String(arg));
        }
        const result = await this.shell(command, options);
        const reply = parseHookResult(result.stdout);
        if (!reply) {
            throw new Error(`The smoke hook gave no reply to ${method}: ${String(result.stdout).trim().slice(0, 300)}`);
        }
        return reply;
    }

    /**
     * Runs one smoke instrumentation test method.
     * @param {object} options Options.
     * @param {string} options.testPackage Test package.
     * @param {string} options.testClass Fully qualified class.
     * @param {string} options.method Method.
     * @param {Record<string, string|number|boolean>} [options.args] `-e` arguments.
     * @param {boolean} [options.noRestart] Pass `--no-restart` (keep the app process alive).
     * @param {number} [options.timeoutMs] Deadline.
     * @param {AbortSignal} [options.signal] Abort signal.
     * @returns {Promise<ReturnType<typeof parseInstrumentation> & {raw: string}>} Result.
     */
    async instrument({ testPackage, testClass, method, args = {}, noRestart = false, timeoutMs = 600_000, signal }) {
        const command = ['am', 'instrument', '-w', '-r'];
        if (noRestart) {
            command.push('--no-restart');
        }
        command.push('-e', 'class', `${testClass}#${method}`);
        for (const [key, value] of Object.entries(args)) {
            command.push('-e', key, String(value));
        }
        command.push(`${testPackage}/androidx.test.runner.AndroidJUnitRunner`);
        const result = await this.shell(command, { check: false, timeoutMs, signal });
        return { ...parseInstrumentation(result.stdout), raw: String(result.stdout) };
    }

    /** Whether this device's `am instrument` knows `--no-restart`. */
    async supportsNoRestart() {
        const result = await this.shell(['am', 'help'], { check: false, timeoutMs: 30_000 });
        return /--no-restart/.test(`${result.stdout}\n${result.stderr}`);
    }

    /** The crash log buffer, for {@link parseCrashLog}. */
    async crashLog(options = {}) {
        const result = await this.run(['logcat', '-d', '-b', 'crash', '-v', 'threadtime'], { timeoutMs: 60_000, ...options });
        return binaryText(result.stdout);
    }

    /** Saves `logcat -d` (all main buffers) to a file. */
    async saveLogcat(file) {
        const result = await this.run(['logcat', '-d', '-b', 'main,system,crash', '-v', 'threadtime'], { check: false, binary: true, timeoutMs: 60_000 });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, result.stdout);
    }

    /** Saves a screenshot. */
    async saveScreenshot(file) {
        const result = await this.run(['exec-out', 'screencap', '-p'], { check: false, binary: true, timeoutMs: 60_000 });
        if (result.code === 0 && result.stdout.length > 0) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, result.stdout);
        }
    }

    /** Saves the current window hierarchy (`uiautomator dump`). */
    async saveWindowDump(file) {
        const result = await this.run(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { check: false, timeoutMs: 60_000 });
        const xml = String(result.stdout).replace(/UI hierchary dumped to: \/dev\/tty\s*$/, '').trim();
        if (xml.startsWith('<?xml')) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `${xml}\n`);
        }
    }
}

function binaryText(value) {
    return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
}
