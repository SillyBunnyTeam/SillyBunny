import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, test } from '@jest/globals';

import {
    accelUsable,
    Adb,
    base64Lines,
    isAppCrash,
    isErrorDialogWindow,
    notificationPosted,
    parseCrashLog,
    parseDnsAddresses,
    parseEmulatorVersion,
    parseFocusedWindow,
    parseForwardPort,
    parseHookResult,
    parseIni,
    parseInstrumentation,
    parsePackageVersion,
    parsePidof,
    parsePingResolution,
    parseProcesses,
    parseWebViewPackage,
    shellCommand,
    shellQuote,
} from './android-smoke/adb.js';
import { appPageTarget, DevToolsPage, isAppPageUrl, redactLabel } from './android-smoke/cdp.js';
import { DEVICE_PORT_MAX, isFixturePort } from './android-smoke/ports.js';
import { DEFAULT_IDLE_WAIT_MINUTES, integerOption, parseRunOptions, redactHandoff, runSummary, UsageError } from './android-smoke/run-smoke.js';
import {
    bunEntries,
    DEFAULT_PACKAGE,
    DEFAULT_UI_TAGS,
    GUEST_PORTS,
    gradleProperties,
    guestUrls,
    readRepositoryFacts,
    REPO_ROOT,
    resolveHead,
    setConfigFlag,
    UPDATE_REPLACED_NOTIFICATION,
    WEB_VERSION_WARNING_TAG,
    WEBVIEW_MINIMUM_MAJOR,
    zipEntryNames,
} from './android-smoke/smoke-config.js';
import { appendOutputs, appendSummary, evaluateRuntimeLock, evaluateRuntimeLockFile, GUARD_CODES, guardReport } from './android-smoke/smoke-guard.js';
import {
    dataSafetyVerdict,
    parseStepSelection,
    runSteps,
    STATUS,
    StepError,
    STEPS,
    summarize,
    summaryTable,
    withDeadline,
} from './android-smoke/smoke-runner.js';
import {
    appPathExists,
    browserPage,
    CookieJar,
    createContext,
    newAppCrashes,
    remoteBranchEntry,
    settleFrontend,
    smokeSteps,
    webViewInfo,
} from './android-smoke/smoke-steps.js';

const RUN_SMOKE = fileURLToPath(new URL('android-smoke/run-smoke.js', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'android-smoke-runner-'));
const ALL_STEPS = STEPS.map(step => step.id);
const DIGEST = `sha256:${'a'.repeat(64)}`;
const describePosix = process.platform === 'win32' ? describe.skip : describe;
// Every byte value, plus the ones adb on Windows rewrites in `shell` stdin and stdout: CRLF, a lone CR,
// LF and Ctrl-Z.
const BINARY = Buffer.concat([Buffer.from('a\r\nb\rc\n\x1a d\x00\xff', 'latin1'), Buffer.from([...Array(256).keys()])]);

afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
});

/** The server's bash as the app starts it: by its path in the install directory (LaunchSpec.kt). */
const BASH_PATH = `/data/app/~~Eu3D3ATm1tYOtt6HPk1aYw==/${DEFAULT_PACKAGE}-nrQ2AivKJXY2kwtuHFPZ5g==/lib/x86_64/libbash.so`;
/**
 * `logcat -b crash -v threadtime` as the three images write it: a WebView abort of the app (API 36), an uncaught
 * exception, another app's crash, a WebView renderer's crash and a SIGABRT of the app on API 37 (whose header adds
 * `ppid:`), the app's SIGABRT on API 29 (no Cmdline line), and a SIGABRT of the server's bash on API 37.
 */
const CRASH_LOG = [
    '--------- beginning of crash',
    '10-23 18:10:14.017  5668  5668 F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***',
    '10-23 18:10:14.017  5668  5668 F DEBUG   : Build fingerprint: \'Android/sdk_phone64_x86_64/emu64x:16/BE2A.250530.026.D1/13818094:userdebug/test-keys\'',
    `10-23 18:10:14.018  5668  5668 F DEBUG   : Cmdline: ${DEFAULT_PACKAGE}`,
    `10-23 18:10:14.018  5668  5668 F DEBUG   : pid: 5397, tid: 5603, name: Chrome_IOThread  >>> ${DEFAULT_PACKAGE} <<<`,
    '10-23 18:10:14.018  5668  5668 F DEBUG   : uid: 10150',
    '10-23 18:10:14.018  5668  5668 F DEBUG   : signal 5 (SIGTRAP), code 128 (SI_KERNEL), fault addr 0x0000000000000000',
    '10-23 18:10:14.018  5668  5668 F DEBUG   : Abort message: \'[FATAL:partition_alloc_support.cc(770)] Detected dangling raw_ptr in unretained with id=0x00003c6a00c026e0:',
    '10-23 18:10:14.018  5668  5668 F DEBUG   : ',
    '10-23 18:10:14.018  5668  5668 F DEBUG   : Please check for more information on:\'',
    '10-23 18:10:14.018  5668  5668 F DEBUG   :     rax 000072a502b20e38  rbx 000072a4f3dd92e0  rcx 0000000000000000  rdx 0000000000000002',
    '10-23 18:21:00.000  6100  6100 E AndroidRuntime: FATAL EXCEPTION: main',
    `10-23 18:21:00.000  6100  6100 E AndroidRuntime: Process: ${DEFAULT_PACKAGE}, PID: 6100`,
    '10-23 18:21:00.000  6100  6100 E AndroidRuntime: java.lang.IllegalStateException: no server',
    '10-23 18:21:00.001  6100  6100 E AndroidRuntime: \tat io.github.sillybunnyteam.sillybunny.MainActivity.onCreate(MainActivity.kt:1)',
    '10-23 18:22:00.000  6200  6200 F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***',
    '10-23 18:22:00.000  6200  6200 F DEBUG   : pid: 6190, tid: 6191, name: RenderThread  >>> com.android.systemui <<<',
    '10-23 18:22:00.000  6200  6200 F DEBUG   : signal 6 (SIGABRT), code -1 (SI_QUEUE), fault addr --------',
    '10-23 20:58:50.608 10668 10668 F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***',
    '10-23 20:58:50.608 10668 10668 F DEBUG   : Build fingerprint: \'google/sdk_gphone16k_x86_64/emu64xa16k:17/CE2A.260420.050/16231978:userdebug/dev-keys\'',
    '10-23 20:58:50.608 10668 10668 F DEBUG   : Cmdline: com.google.android.webview:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0',
    '10-23 20:58:50.608 10668 10668 F DEBUG   : pid: 10668, ppid: 1147, tid: 10668, name: ocessService0:0  >>> com.google.android.webview:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0 <<<',
    '10-23 20:58:50.608 10668 10668 F DEBUG   : uid: 99011',
    '10-23 20:58:50.608 10668 10668 F DEBUG   : signal 5 (SIGTRAP), code 128 (SI_KERNEL), fault addr --------',
    '10-23 20:58:50.608 10668 10668 F DEBUG   : Abort message: \'[FATAL:base/android/java_exception_reporter.cc:93] Uncaught exception\'',
    '10-23 21:01:59.315 10407 10407 F libc    : Fatal signal 6 (SIGABRT), code 0 (SI_USER from pid 11373, uid 10231) in tid 10407 (illybunny.debug), pid 10407 (illybunny.debug)',
    '10-23 21:02:00.180 11378 11378 F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***',
    `10-23 21:02:00.180 11378 11378 F DEBUG   : Cmdline: ${DEFAULT_PACKAGE}`,
    `10-23 21:02:00.180 11378 11378 F DEBUG   : pid: 10407, ppid: 444, tid: 10407, name: illybunny.debug  >>> ${DEFAULT_PACKAGE} <<<`,
    '10-23 21:02:00.180 11378 11378 F DEBUG   : uid: 10231',
    '10-23 21:02:00.180 11378 11378 F DEBUG   : signal 6 (SIGABRT), code 0 (SI_USER from pid 11373, uid 10231), fault addr --------',
    '10-23 21:22:03.575  9165  9165 F libc    : Fatal signal 6 (SIGABRT), code 0 (SI_USER from pid 10025, uid 10116) in tid 9165 (illybunny.debug), pid 9165 (illybunny.debug)',
    '10-23 21:22:03.729 10028 10028 F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***',
    '10-23 21:22:03.729 10028 10028 F DEBUG   : Build fingerprint: \'Android/sdk_phone_x86_64/generic_x86_64:10/QSR1.210820.001/7663313:userdebug/test-keys\'',
    `10-23 21:22:03.730 10028 10028 F DEBUG   : pid: 9165, tid: 9165, name: illybunny.debug  >>> ${DEFAULT_PACKAGE} <<<`,
    '10-23 21:22:03.730 10028 10028 F DEBUG   : uid: 10116',
    '10-23 21:22:03.730 10028 10028 F DEBUG   : signal 6 (SIGABRT), code 0 (SI_USER from pid 10025, uid 10116), fault addr --------',
    '10-23 22:08:29.471 11227 11227 F libc    : Fatal signal 6 (SIGABRT), code 0 (SI_USER from pid 11463, uid 10231) in tid 11227 (libbash.so), pid 11227 (libbash.so)',
    '10-23 22:08:29.592 11467 11467 F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***',
    `10-23 22:08:29.593 11467 11467 F DEBUG   : Cmdline: ${BASH_PATH} --noprofile --norc start.sh -- --port 63785`,
    `10-23 22:08:29.593 11467 11467 F DEBUG   : pid: 11227, ppid: 11223, tid: 11227, name: libbash.so  >>> ${BASH_PATH} <<<`,
    '10-23 22:08:29.593 11467 11467 F DEBUG   : uid: 10231',
    '10-23 22:08:29.593 11467 11467 F DEBUG   : signal 6 (SIGABRT), code 0 (SI_USER from pid 11463, uid 10231), fault addr --------',
    '',
].join('\r\n');

/** The error a call throws, or null. */
function thrown(work) {
    try {
        work();
    } catch (error) {
        return error;
    }
    return null;
}

function scratchFile(name, contents = '') {
    const file = path.join(scratch, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
}

/** A ZIP with only a central directory and its end record, which is all zipEntryNames reads. */
function zipWithNames(names, comment = '') {
    const entries = names.map((name) => {
        const header = Buffer.alloc(46);
        const bytes = Buffer.from(name, 'utf8');
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(bytes.length, 28);
        return Buffer.concat([header, bytes]);
    });
    const directory = Buffer.concat(entries);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(names.length, 8);
    end.writeUInt16LE(names.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(0, 16);
    end.writeUInt16LE(Buffer.byteLength(comment), 20);
    return Buffer.concat([directory, end, Buffer.from(comment)]);
}

/**
 * `dumpsys notification` cut down to the parts step 6 reads. Records and archive entries take the forms the
 * API 37 and API 29 emulators print; API 29 adds `appImportanceLocked=` after the key.
 * @param {object} [lists] `{pkg?, id, channel}` entries for `posted`, `archived` and `enqueued`, and the `api` level.
 * @returns {string} Dump.
 */
function notificationDump({ posted = [], archived = [], enqueued = [], api = 37 } = {}) {
    const key = (pkg, id) => `0|${pkg}|${id}|null|10232${api === 29 ? 'appImportanceLocked=false' : ''}`;
    const notification = channel => (api === 29
        ? `Notification(channel=${channel} pri=0 contentView=null vibrate=null sound=null defaults=0x0 flags=0x18 color=0x00000000 vis=PRIVATE)`
        : `Notification(channel=${channel} shortcut=null contentView=null vibrate=null sound=null defaults=0 flags=ONLY_ALERT_ONCE|AUTO_CANCEL color=0x00000000 vis=PRIVATE)`);
    const record = ({ pkg = DEFAULT_PACKAGE, id, channel }) => [
        `    NotificationRecord(0x09c2a8e1: pkg=${pkg} user=UserHandle{0} id=${id} tag=null importance=3 key=${key(pkg, id)}: ${notification(channel)})`,
        '      uid=10232 userId=0',
        `      icon=Icon(typ=RESOURCE pkg=${pkg} id=0x7f040008)`,
    ];
    const archive = ({ pkg = DEFAULT_PACKAGE, id, channel }) =>
        `    StatusBarNotification(pkg=${pkg} user=UserHandle{0} id=${id} tag=null key=0|${pkg}|${id}|null|10232: ${notification(channel)})`;
    return [
        'Current Notification Manager state:',
        '  Notification List:',
        ...posted.flatMap(record),
        '  ',
        '  mMaxPackageEnqueueRate=5.0',
        `  mArchive=Archive (${archived.length} notifications)`,
        ...archived.map(archive),
        ...(enqueued.length > 0 ? ['  Enqueued Notification List:', ...enqueued.flatMap(record), '  '] : []),
        '  Snoozed notifications:',
    ].join('\n');
}

function runCli(args, env = {}) {
    const result = spawnSync(process.execPath, [RUN_SMOKE, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Steps for runSteps: `outcome` per id is a value to return, an Error to throw or 'hang'. */
function fakeSteps(outcomes, { timeoutMinutes = 1 } = {}) {
    return STEPS.map(step => ({
        ...step,
        timeoutMinutes,
        run: async (context, signal) => {
            context.ran.push(step.id);
            const outcome = outcomes[step.id];
            if (outcome === 'hang') {
                return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
            }
            if (outcome instanceof Error) {
                throw outcome;
            }
            return outcome;
        },
    }));
}

function counter(step = 250) {
    let value = 0;
    return () => {
        value += step;
        return value;
    };
}

/** An Adb whose transport records each call and answers with the queued results (default: exit 0). */
class RecordingAdb extends Adb {
    constructor(results = []) {
        super({ serial: 'emulator-5628' });
        this.calls = [];
        this.results = results;
    }

    async run(args, options = {}) {
        this.calls.push({ args, options });
        return this.results.shift() ?? { code: 0, stdout: '', stderr: '', timedOut: false };
    }
}

/** A page target's DevTools socket: it records each message and answers with the queued replies, in order. */
class FakeDevToolsSocket extends EventTarget {
    constructor(replies = []) {
        super();
        this.replies = replies;
        this.sent = [];
    }

    send(data) {
        const message = JSON.parse(data);
        this.sent.push(message);
        if (this.replies.length) {
            const reply = { id: message.id, ...this.replies.shift() };
            setImmediate(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(reply) })));
        }
    }

    close() {
        this.dispatchEvent(new Event('close'));
    }
}

/**
 * A stand-in adb for `-s <serial> shell <command>`: like adbd, it runs the command with `sh -c`, and its
 * `run-as` runs the rest of its arguments in the app directory. Every command is logged.
 */
function fakeDevice() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-smoke-device-'));
    const app = path.join(root, 'app');
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'commands.log');
    fs.mkdirSync(app);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(root, 'adb'), [
        '#!/bin/sh',
        '[ "$1" = -s ] && [ "$3" = shell ] || exit 90',
        'shift 3',
        `printf '%s\\n' "$*" >> ${shellQuote(log)}`,
        `PATH=${shellQuote(bin)}:$PATH`,
        'export PATH',
        'exec sh -c "$*"',
        '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'run-as'), [
        '#!/bin/sh',
        `[ "$1" = ${shellQuote(DEFAULT_PACKAGE)} ] || { echo "run-as: unknown package $1" >&2; exit 1; }`,
        'shift',
        `cd ${shellQuote(app)} || exit 1`,
        'exec "$@"',
        '',
    ].join('\n'), { mode: 0o755 });
    return {
        root,
        app,
        adb: new Adb({ serial: 'emulator-5628', adb: path.join(root, 'adb') }),
        commands: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
        file: relative => fs.readFileSync(path.join(app, ...relative.split('/'))),
    };
}

describe('smoke-runner: steps and selection', () => {
    test('lists the fourteen plan §7.1 steps in order, each needing only earlier steps', () => {
        expect(STEPS.map(step => step.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
        expect(new Set(STEPS.map(step => step.key)).size).toBe(14);
        for (const step of STEPS) {
            expect([step.id, step.needs.every(need => need < step.id)]).toEqual([step.id, true]);
            expect(step.timeoutMinutes).toBeGreaterThan(0);
        }
        expect(Object.isFrozen(STEPS[0].needs)).toBe(true);
    });

    test('parses all, ids and ranges', () => {
        expect(parseStepSelection(undefined)).toEqual(ALL_STEPS);
        expect(parseStepSelection('')).toEqual(ALL_STEPS);
        expect(parseStepSelection(' all ')).toEqual(ALL_STEPS);
        expect(parseStepSelection('1-3,9,14')).toEqual([1, 2, 3, 9, 14]);
        expect(parseStepSelection(' 14 , 2-3, 3 ')).toEqual([2, 3, 14]);
    });

    test('refuses unreadable selections, descending ranges and unknown steps', () => {
        for (const text of ['x', '1-', '3-1', '0', '15', '1,,2', '-1']) {
            expect([text, thrown(() => parseStepSelection(text))]).toEqual([text, expect.objectContaining({ code: 'invalid-steps' })]);
        }
    });

    test('the step table gives step 11 its idle wait and every step an implementation', () => {
        const steps = smokeSteps({ idleWaitMinutes: 7 });
        expect(steps.map(step => step.id)).toEqual(ALL_STEPS);
        expect(steps.every(step => typeof step.run === 'function')).toBe(true);
        expect(steps.find(step => step.id === 11).timeoutMinutes).toBe(STEPS[10].timeoutMinutes + 7);
        expect(steps.filter(step => step.id !== 11).map(step => step.timeoutMinutes)).toEqual(STEPS.filter(step => step.id !== 11).map(step => step.timeoutMinutes));
    });
});

describe('smoke-runner: runSteps', () => {
    test('runs the selected steps in order with their own timing and details', async () => {
        const context = { ran: [] };
        const seen = [];
        const records = await runSteps({
            steps: [...fakeSteps({ 1: { versionCode: 1 }, 2: {} })].reverse(),
            selected: [1, 2],
            context,
            onRecord: record => seen.push(record.id),
            now: counter(),
        });
        expect(context.ran).toEqual([1, 2]);
        expect(seen).toEqual(ALL_STEPS);
        expect(records[0]).toEqual({ id: 1, key: 'first-run', startedAt: new Date(250).toISOString(), status: STATUS.passed, details: { versionCode: 1 }, durationMs: 250 });
        expect(records[1]).toMatchObject({ id: 2, status: STATUS.passed, durationMs: 250 });
        expect(records[1].details).toBeUndefined();
        expect(records.slice(2).map(record => [record.status, record.reason])).toEqual(STEPS.slice(2).map(() => [STATUS.notRun, 'not-selected']));
    });

    test('a failure fails only its own step; dependants are not run with the reason', async () => {
        const context = { ran: [] };
        const records = await runSteps({
            steps: fakeSteps({ 2: new StepError('server-not-running', 'the server did not reach Running'), 13: new Error('boom') }),
            selected: ALL_STEPS,
            context,
        });
        expect(records.map(record => record.status)).toEqual([
            STATUS.passed, STATUS.failed,
            ...Array(10).fill(STATUS.notRun),
            STATUS.failed, STATUS.passed,
        ]);
        expect(records[1]).toMatchObject({ code: 'server-not-running', error: 'the server did not reach Running' });
        expect(records.slice(2, 12).map(record => record.reason)).toEqual(Array(10).fill('needs-step-2'));
        expect(records[12]).toMatchObject({ code: 'failed', error: 'boom' });
        expect(context.ran).toEqual([1, 2, 13, 14]);
    });

    test('a step whose prerequisite was not selected says so', async () => {
        const records = await runSteps({ steps: fakeSteps({}), selected: [3, 13], context: { ran: [] } });
        expect(records[2]).toMatchObject({ status: STATUS.notRun, reason: 'needs-step-2-selected' });
        expect(records[12]).toMatchObject({ status: STATUS.notRun, reason: 'needs-step-1-selected' });
    });

    test('a step past its deadline fails with code timeout and its signal aborted', async () => {
        const records = await runSteps({ steps: fakeSteps({ 1: 'hang' }, { timeoutMinutes: 0.0005 }), selected: [1, 14], context: { ran: [] } });
        expect(records[0]).toMatchObject({ status: STATUS.failed, code: 'timeout' });
        expect(records[13]).toMatchObject({ status: STATUS.notRun, reason: 'needs-step-1' });
    });

    test('the data-safety check runs after every step that ran and fails a passing step on a change', async () => {
        const checked = [];
        const verdicts = { 1: null, 2: { ok: true, digest: 'd' }, 3: { ok: false, changed: ['default-user/secrets.json'] }, 4: { ok: false } };
        const records = await runSteps({
            steps: fakeSteps({ 4: new StepError('not-updated') }),
            selected: [1, 2, 3, 4],
            context: { ran: [] },
            afterStep: async (step) => {
                checked.push(step.id);
                return verdicts[step.id];
            },
        });
        expect(checked).toEqual([1, 2, 3, 4]);
        expect(records[0].checksum).toBeUndefined();
        expect(records[1]).toMatchObject({ status: STATUS.passed, checksum: { ok: true } });
        expect(records[2]).toMatchObject({ status: STATUS.failed, code: 'data-safety', checksum: { ok: false } });
        // A failed step keeps its own reason; the checksum result is still recorded.
        expect(records[3]).toMatchObject({ status: STATUS.failed, code: 'not-updated', checksum: { ok: false } });
    });

    test('a data-safety check that throws fails the step', async () => {
        const records = await runSteps({
            steps: fakeSteps({}),
            selected: [1],
            context: { ran: [] },
            afterStep: async () => {
                throw new StepError('adb', 'device offline');
            },
        });
        expect(records[0]).toMatchObject({ status: STATUS.failed, code: 'data-safety', checksum: { ok: false, code: 'adb', error: 'device offline' } });
    });

    test('an app crash fails the step it came in and is named in a failed step\'s error', async () => {
        const crash = { summary: 'SIGTRAP in Chrome_IOThread of the app' };
        const found = { 1: [], 2: [crash], 3: [crash, { summary: 'SIGABRT in illybunny.debug of the app' }] };
        const order = [];
        let calls = 0;
        const records = await runSteps({
            steps: fakeSteps({ 13: new StepError('bun-shipped', 'the APK ships bun') }),
            selected: [1, 2, 13],
            context: { ran: [] },
            newCrashes: async () => {
                calls += 1;
                order.push('crashes');
                return found[calls];
            },
            afterStep: async () => {
                order.push('checksum');
                return { ok: true };
            },
        });
        expect(order).toEqual(['crashes', 'checksum', 'crashes', 'checksum', 'crashes', 'checksum']);
        expect(records[0]).toMatchObject({ status: STATUS.passed });
        expect(records[0].crashes).toBeUndefined();
        expect(records[1]).toMatchObject({ status: STATUS.failed, code: 'app-crash', error: 'the app crashed: SIGTRAP in Chrome_IOThread of the app', crashes: [crash] });
        expect(records[12]).toMatchObject({
            status: STATUS.failed,
            code: 'bun-shipped',
            error: 'the APK ships bun (the app crashed: SIGTRAP in Chrome_IOThread of the app; SIGABRT in illybunny.debug of the app)',
        });
    });

    test('an unreadable crash log is noted, and the step\'s own checks decide', async () => {
        const records = await runSteps({
            steps: fakeSteps({}),
            selected: [1],
            context: { ran: [] },
            newCrashes: async () => {
                throw new StepError('adb', 'device offline');
            },
        });
        expect(records[0]).toMatchObject({ status: STATUS.passed, crashCheck: 'device offline' });
    });

    test('a failed fetch says why, from its cause (step 4)', async () => {
        const closed = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
        const records = await runSteps({
            steps: fakeSteps({ 4: new TypeError('fetch failed', { cause: closed }), 5: new Error('refused', { cause: new Error('connect ECONNREFUSED') }) }),
            selected: [1, 2, 4, 5],
            context: { ran: [] },
        });
        expect(records[3]).toMatchObject({ status: STATUS.failed, code: 'failed', error: 'fetch failed (UND_ERR_SOCKET: other side closed)' });
        expect(records[4]).toMatchObject({ status: STATUS.failed, code: 'failed', error: 'refused (connect ECONNREFUSED)' });
    });

    test('the records keep no per-install origin label in their errors', async () => {
        const url = 'http://sb-k3x9.localhost:50123/login?noauto=true';
        const redacted = 'http://<label>.localhost:50123/login?noauto=true';
        let crashChecks = 0;
        const records = await runSteps({
            steps: fakeSteps({ 2: new Error(`page.goto: Target page closed, navigating to "${url}"`) }),
            selected: [1, 2, 13],
            context: { ran: [] },
            newCrashes: async () => {
                crashChecks += 1;
                if (crashChecks === 1) {
                    throw new Error(`no crash log for ${url}`);
                }
                return [];
            },
            afterStep: async (step) => {
                if (step.id === 1) {
                    return { ok: true };
                }
                throw new Error(`checksum failed at ${url}`);
            },
            redact: redactLabel,
        });
        expect(records[0]).toMatchObject({ status: STATUS.passed, crashCheck: `no crash log for ${redacted}` });
        expect(records[1]).toMatchObject({
            status: STATUS.failed,
            code: 'failed',
            error: `page.goto: Target page closed, navigating to "${redacted}"`,
            checksum: { ok: false, error: `checksum failed at ${redacted}` },
        });
        expect(records[12]).toMatchObject({ status: STATUS.failed, code: 'data-safety', error: `the data-safety check failed: checksum failed at ${redacted}` });
        expect(JSON.stringify(records)).not.toContain('k3x9');
    });

    test('an unhandled rejection fails the step it came in and is named in a failed step\'s error', async () => {
        const url = 'http://sb-k3x9.localhost:50123/';
        const pending = [];
        const order = [];
        const records = await runSteps({
            steps: fakeSteps({ 2: { pushed: true }, 13: new StepError('bun-shipped', 'the APK ships bun') }).map(step => ({
                ...step,
                run: async (context, signal) => {
                    if (step.id === 2) {
                        pending.push(`page.evaluate: Target page closed at ${url}`);
                    }
                    if (step.id === 13) {
                        pending.push('dialog.dismiss: Target closed', 'second');
                    }
                    return step.run(context, signal);
                },
            })),
            selected: [1, 2, 13],
            context: { ran: [] },
            newRejections: () => {
                order.push('rejections');
                return pending.splice(0);
            },
            newCrashes: async () => {
                order.push('crashes');
                return [];
            },
            afterStep: async () => {
                order.push('checksum');
                return { ok: true };
            },
            redact: redactLabel,
        });
        expect(order).toEqual(Array(3).fill(['rejections', 'crashes', 'checksum']).flat());
        expect(records[0]).toMatchObject({ status: STATUS.passed });
        expect(records[0].rejections).toBeUndefined();
        expect(records[1]).toMatchObject({
            status: STATUS.failed,
            code: 'unhandled-rejection',
            error: 'unhandled rejection: page.evaluate: Target page closed at http://<label>.localhost:50123/',
            rejections: ['page.evaluate: Target page closed at http://<label>.localhost:50123/'],
            details: { pushed: true },
        });
        expect(records[12]).toMatchObject({
            status: STATUS.failed,
            code: 'bun-shipped',
            error: 'the APK ships bun (unhandled rejection: dialog.dismiss: Target closed; second)',
        });
        expect(JSON.stringify(records)).not.toContain('k3x9');
    });

    test('withDeadline resolves the work and aborts it at the deadline', async () => {
        await expect(withDeadline(async () => 5, 1_000)).resolves.toBe(5);
        let aborted = null;
        const hang = signal => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
                aborted = signal.reason;
                reject(signal.reason);
            });
        });
        await expect(withDeadline(hang, 20, 0.5)).rejects.toMatchObject({ code: 'timeout', message: 'the step did not finish within 0.5 min' });
        expect(aborted).toMatchObject({ code: 'timeout' });
    });
});

describe('smoke-runner: verdicts and summaries', () => {
    const records = [
        { id: 1, key: 'first-run', status: STATUS.passed, durationMs: 61_250, checksum: null },
        { id: 2, key: 'server-webview', status: STATUS.failed, code: 'unhealthy', error: 'health | answered\n500', durationMs: 900, checksum: { ok: true } },
        { id: 3, key: 'chat', status: STATUS.passed, durationMs: 10, checksum: { ok: false } },
        { id: 4, key: 'git-update', status: STATUS.notRun, reason: 'needs-step-2' },
        { id: 14, key: 'data-safety', status: STATUS.passed, durationMs: 5, checksum: { ok: true } },
    ];

    test('step 14 counts every check except its own', () => {
        expect(dataSafetyVerdict(records)).toEqual({ checked: [2, 3], failed: [3] });
    });

    test('a run passes only when every selected step passed', () => {
        expect(summarize(records, [1, 2, 3, 4, 14])).toEqual({ ok: false, passed: [1, 3, 14], failed: [2], notRun: [4] });
        expect(summarize(records, [1, 3, 14])).toEqual({ ok: true, passed: [1, 3, 14], failed: [], notRun: [] });
    });

    test('the Markdown table escapes cells and shows why a step failed or did not run', () => {
        expect(summaryTable(records)).toEqual([
            '| step | key | result | seconds | detail |',
            '| --- | --- | --- | --- | --- |',
            '| 1 | first-run | passed | 61.3 |  |',
            '| 2 | server-webview | failed | 0.9 | unhealthy: health \\| answered 500 |',
            '| 3 | chat | passed | 0.0 |  |',
            '| 4 | git-update | not-run |  | needs-step-2 |',
            '| 14 | data-safety | passed | 0.0 |  |',
        ]);
    });

    test('the run summary adds the run\'s own failure, which no step record holds, after the table', () => {
        expect(runSummary(records)).toEqual(summaryTable(records));
        expect(runSummary(records, 'unhandled rejections outside the steps: page.close: `closed`\nat\thttp://<label>.localhost:50123/')).toEqual([
            ...summaryTable(records),
            '',
            'TODO(copy): `unhandled rejections outside the steps: page.close: \'closed\' at http://<label>.localhost:50123/`',
        ]);
        expect(runSummary([], 'device emulator-5628 is offline')).toEqual([...summaryTable([]), '', 'TODO(copy): `device emulator-5628 is offline`']);
    });
});

describe('smoke-guard', () => {
    const lock = (entries, abis = Object.keys(entries)) => ({ abis, node: { binaries: entries } });
    const unpinned = { digest: null, sha256: null, size: null };
    const pinned = { digest: DIGEST, sha256: 'b'.repeat(64), size: 10 };

    test('skips while every Node digest is null and runs once all are pinned', () => {
        expect(evaluateRuntimeLock(lock({ x86_64: unpinned, 'arm64-v8a': unpinned }))).toEqual({
            ok: true, run: false, code: GUARD_CODES.unpinned, abis: { x86_64: null, 'arm64-v8a': null },
        });
        expect(evaluateRuntimeLock(lock({ x86_64: pinned }))).toEqual({ ok: true, run: true, code: GUARD_CODES.pinned, abis: { x86_64: DIGEST } });
    });

    test('fails a partly pinned lock and malformed pins', () => {
        expect(evaluateRuntimeLock(lock({ x86_64: pinned, 'arm64-v8a': unpinned }))).toMatchObject({
            ok: false, run: false, code: GUARD_CODES.partial, detail: 'unpinned: arm64-v8a',
        });
        const bad = [
            { ...unpinned, sha256: 'b'.repeat(64) },
            { ...pinned, digest: 'sha256:xyz' },
            { ...pinned, digest: 'a'.repeat(64) },
            { ...pinned, sha256: null },
            { ...pinned, size: 0 },
            { ...pinned, size: '10' },
        ];
        for (const entry of bad) {
            expect(evaluateRuntimeLock(lock({ x86_64: entry }))).toMatchObject({ ok: false, run: false, code: GUARD_CODES.invalidDigest });
        }
    });

    test('fails a lock that is not shaped like android/runtime.lock', () => {
        for (const value of [null, [], 'lock', { abis: [] }, { abis: ['x86_64'] }, { abis: ['x86_64'], node: { binaries: {} } }, { abis: [''], node: { binaries: {} } }]) {
            expect(evaluateRuntimeLock(value)).toMatchObject({ ok: false, run: false, code: GUARD_CODES.invalidLock });
        }
        expect(evaluateRuntimeLockFile(path.join(scratch, 'missing.lock'))).toMatchObject({ ok: false, code: GUARD_CODES.invalidLock });
    });

    test('the repository lock is either fully pinned or fully unpinned', () => {
        const decision = evaluateRuntimeLockFile(path.join(REPO_ROOT, 'android', 'runtime.lock'));
        expect(decision.ok).toBe(true);
        expect(Object.keys(decision.abis).sort()).toEqual(['arm64-v8a', 'armeabi-v7a', 'x86_64']);
    });

    test('a skip is a notice and a job-summary line; a failure is an error; a run is outputs only', () => {
        const skip = guardReport({ ok: true, run: false, code: GUARD_CODES.unpinned, abis: {} });
        expect(skip.outputs).toEqual({ run: 'false', reason: 'node-digests-unpinned' });
        expect(skip.commands).toEqual(['::notice title=TODO(copy)::TODO(copy)']);
        expect(skip.summary).toEqual(['TODO(copy)', '', '- outcome: `skipped`', '- reason: `node-digests-unpinned`', '']);
        expect(guardReport({ ok: true, run: true, code: GUARD_CODES.pinned, abis: {} })).toEqual({
            outputs: { run: 'true', reason: 'node-digests-pinned' }, commands: [], summary: [],
        });
        expect(guardReport({ ok: false, run: false, code: GUARD_CODES.partial, abis: {} })).toEqual({
            outputs: { run: 'false', reason: 'node-digests-partial' }, commands: ['::error title=TODO(copy)::TODO(copy)'], summary: [],
        });
    });

    test('appends single-line outputs and summary lines, refusing a newline', () => {
        const output = scratchFile('guard/output');
        appendOutputs(output, { run: 'true', reason: 'node-digests-pinned' });
        expect(fs.readFileSync(output, 'utf8')).toBe('run=true\nreason=node-digests-pinned\n');
        expect(thrown(() => appendOutputs(output, { run: 'true\nrun=false' }))).toBeInstanceOf(Error);
        expect(fs.readFileSync(output, 'utf8')).toBe('run=true\nreason=node-digests-pinned\n');

        const summary = scratchFile('guard/summary');
        appendSummary(summary, []);
        appendSummary(summary, ['a', 'b']);
        expect(fs.readFileSync(summary, 'utf8')).toBe('a\nb\n');
    });
});

describe('smoke-config', () => {
    test('the guest ports are fixture ports below the app server range, never 4444', () => {
        for (const port of Object.values(GUEST_PORTS)) {
            expect([port, isFixturePort(port, { max: DEVICE_PORT_MAX })]).toEqual([port, true]);
        }
        expect(new Set(Object.values(GUEST_PORTS)).size).toBe(3);
    });

    test('builds the guest URLs and the Gradle fixture overrides from the guest ports', () => {
        expect(guestUrls({ git: 30001, llm: 30002, update: 30003 })).toEqual({
            repo: 'http://127.0.0.1:30001/SillyBunny.git',
            extension: 'http://127.0.0.1:30001/sillybunny-smoke-extension.git',
            plugin: 'http://127.0.0.1:30001/sillybunny-smoke-plugin.git',
            llmBase: 'http://127.0.0.1:30002/v1',
            updateBase: 'http://127.0.0.1:30003',
            manifest: 'http://127.0.0.1:30003/android-update.json',
            releases: 'http://127.0.0.1:30003/releases.json',
        });
        expect(gradleProperties()).toEqual({
            debugRepoUrl: `http://127.0.0.1:${GUEST_PORTS.git}/SillyBunny.git`,
            debugUpdateManifestUrl: `http://127.0.0.1:${GUEST_PORTS.update}/android-update.json`,
            debugReleasesApiUrl: `http://127.0.0.1:${GUEST_PORTS.update}/releases.json`,
        });
    });

    test('reads the version and runtime facts of the checkout', () => {
        const facts = readRepositoryFacts(REPO_ROOT);
        const properties = fs.readFileSync(path.join(REPO_ROOT, 'android', 'app-version.properties'), 'utf8');
        const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'android', 'runtime.lock'), 'utf8'));
        expect(facts.versionCode).toBe(Number(/^versionCode=(\d+)/m.exec(properties)[1]));
        expect(facts.runtime.node).toBe(lock.node.version);
        expect(facts.runtime.npm).toBe(lock.npm.version);
        expect(facts.runtime.git).toMatch(/\S/);
        expect(facts.runtime.bash).toMatch(/\S/);

        const root = path.join(scratch, 'facts');
        scratchFile('facts/android/app-version.properties', 'versionCode=0\nversionName=1.0.0\n');
        scratchFile('facts/android/runtime.lock', '{}');
        expect(thrown(() => readRepositoryFacts(root))).toBeInstanceOf(Error);
    });

    test('sets one top-level config.yaml flag and keeps everything else byte for byte', () => {
        const text = 'listen: false\r\nenableUserAccounts: false # accounts\r\nenableUserAccountsX: false\r\nnested:\r\n  enableServerPlugins: false\r\n';
        expect(setConfigFlag(text, 'enableUserAccounts', true)).toBe(text.replace('enableUserAccounts: false # accounts', 'enableUserAccounts: true # accounts'));
        expect(setConfigFlag('a: true\nenableServerPlugins: true\n', 'enableServerPlugins', false)).toBe('a: true\nenableServerPlugins: false\n');
        expect(thrown(() => setConfigFlag(text, 'enableServerPlugins', true))).toMatchObject({ code: 'config-key-missing' });
        // The key is matched literally: an unescaped `.` would accept axb.
        expect(thrown(() => setConfigFlag('axb: true\n', 'a.b', true))).toMatchObject({ code: 'config-key-missing' });
    });

    test('resolves HEAD through a loose ref, packed-refs or a detached commit', () => {
        const commit = 'c'.repeat(40);
        const other = 'd'.repeat(40);
        const none = () => null;
        expect(resolveHead({ head: `${commit}\n`, looseRef: none, packedRefs: null })).toEqual({ branch: null, commit });
        expect(resolveHead({ head: 'ref: refs/heads/staging\n', looseRef: ref => (ref === 'refs/heads/staging' ? `${commit}\n` : null), packedRefs: null }))
            .toEqual({ branch: 'staging', commit });
        expect(resolveHead({ head: 'ref: refs/heads/release', looseRef: none, packedRefs: `# pack-refs with: peeled\n${other} refs/heads/staging\n${commit} refs/heads/release\n` }))
            .toEqual({ branch: 'release', commit });
        expect(resolveHead({ head: 'ref: refs/heads/release', looseRef: none, packedRefs: null })).toEqual({ branch: 'release', commit: null });
        expect(resolveHead({ head: 'not a ref\n', looseRef: none, packedRefs: null })).toEqual({ branch: null, commit: null });
        expect(resolveHead({ head: null, looseRef: none, packedRefs: null })).toEqual({ branch: null, commit: null });
    });

    test('lists ZIP entries from the central directory, also behind an archive comment', () => {
        const names = ['AndroidManifest.xml', 'lib/x86_64/libnode.so', 'assets/web/bundle.js'];
        expect(zipEntryNames(zipWithNames(names))).toEqual(names);
        expect(zipEntryNames(zipWithNames(names, 'comment'))).toEqual(names);
        expect(thrown(() => zipEntryNames(Buffer.from('not a zip')))).toBeInstanceOf(Error);
        const corrupt = zipWithNames(names);
        corrupt.writeUInt32LE(0, 0);
        expect(thrown(() => zipEntryNames(corrupt))).toBeInstanceOf(Error);
    });

    test('finds Bun binaries and links by path segment, not by substring', () => {
        expect(bunEntries([
            'lib/x86_64/libbun.so',
            'lib/arm64-v8a/libbunx.so',
            'assets/runtime/bin/bun',
            'assets/runtime/bin/bunx',
            'assets/runtime/bun-v1.3.14/bin/x',
            'assets/runtime/bin/bun.exe',
            'assets/web/bundle.js',
            'assets/sillybunny/index.js',
            'res/drawable/bunny.png',
            'lib/x86_64/libbundle.so',
            'assets/runtime/bin/node',
        ])).toEqual([
            'lib/x86_64/libbun.so',
            'lib/arm64-v8a/libbunx.so',
            'assets/runtime/bin/bun',
            'assets/runtime/bin/bunx',
            'assets/runtime/bun-v1.3.14/bin/x',
            'assets/runtime/bin/bun.exe',
        ]);
    });
});

describe('adb.js parsers', () => {
    test('quotes device shell arguments', () => {
        expect(shellQuote('files/SillyBunny/config.yaml')).toBe('files/SillyBunny/config.yaml');
        expect(shellQuote('a b')).toBe('\'a b\'');
        expect(shellQuote('it\'s')).toBe('\'it\'\\\'\'s\'');
        expect(shellQuote('')).toBe('\'\'');
        expect(shellCommand(['run-as', 'pkg', 'cat', 'a b', 5])).toBe('run-as pkg cat \'a b\' 5');
    });

    test('reads pidof, adb forward and the smoke hook reply', () => {
        expect(parsePidof('4321 99\n')).toBe(4321);
        expect(parsePidof('')).toBeNull();
        expect(parseForwardPort('45123\n')).toBe(45123);
        expect(parseForwardPort('error: cannot bind')).toBeNull();
        expect(parseHookResult('Result: Bundle[{json={"state":"Running","port":50123,"originChanged":false}}]\r\n'))
            .toEqual({ state: 'Running', port: 50123, originChanged: false });
        expect(parseHookResult('Result: Bundle[{json={"code":"x}]","path":"/__sillybunny/handoff"}}]')).toEqual({ code: 'x}]', path: '/__sillybunny/handoff' });
        expect(parseHookResult('Result: null')).toBeNull();
        expect(parseHookResult('Result: Bundle[{json={broken}]')).toBeNull();
    });

    test('reads am instrument results: pass, failure with stack, crash, assumption and a failed start', () => {
        const status = (test, code, extra = '') => [
            'INSTRUMENTATION_STATUS: class=io.github.sillybunnyteam.sillybunny.smoke.SmokeUiTest',
            'INSTRUMENTATION_STATUS: current=1',
            'INSTRUMENTATION_STATUS: id=AndroidJUnitRunner',
            'INSTRUMENTATION_STATUS: numtests=1',
            ...(extra ? [extra] : []),
            `INSTRUMENTATION_STATUS: test=${test}`,
            `INSTRUMENTATION_STATUS_CODE: ${code}`,
        ].join('\r\n');
        const passed = parseInstrumentation([status('firstRun', 1), status('firstRun', 0), 'INSTRUMENTATION_RESULT: stream=', '', 'OK (1 test)', 'INSTRUMENTATION_CODE: -1'].join('\r\n'));
        expect(passed).toEqual({
            tests: [{ className: 'io.github.sillybunnyteam.sillybunny.smoke.SmokeUiTest', test: 'firstRun', status: 'passed' }],
            code: -1, shortMsg: null, failedToStart: null, crashed: false, ok: true,
        });

        const stack = 'INSTRUMENTATION_STATUS: stack=java.lang.AssertionError: no first-run screen\n\tat org.junit.Assert.fail(Assert.java:89)';
        const failed = parseInstrumentation([status('firstRun', 1), status('firstRun', -2, stack), 'INSTRUMENTATION_CODE: -1'].join('\n'));
        expect(failed.ok).toBe(false);
        expect(failed.tests[0]).toMatchObject({ status: 'failed', stack: 'java.lang.AssertionError: no first-run screen\n\tat org.junit.Assert.fail(Assert.java:89)' });

        const crashed = parseInstrumentation([status('acceptAppUpdate', 1), 'INSTRUMENTATION_RESULT: shortMsg=Process crashed.', 'INSTRUMENTATION_CODE: 0'].join('\n'));
        expect(crashed).toMatchObject({ tests: [], code: 0, shortMsg: 'Process crashed.', crashed: true, ok: false });

        const skipped = parseInstrumentation([status('repair', 1), status('repair', -4), 'INSTRUMENTATION_CODE: -1'].join('\n'));
        expect(skipped.tests[0].status).toBe('assumption-failure');
        expect(skipped.ok).toBe(false);

        const notStarted = parseInstrumentation('INSTRUMENTATION_FAILED: io.github.sillybunnyteam.sillybunny.debug.test/androidx.test.runner.AndroidJUnitRunner\nINSTRUMENTATION_CODE: 1\n');
        expect(notStarted).toMatchObject({ failedToStart: 'io.github.sillybunnyteam.sillybunny.debug.test/androidx.test.runner.AndroidJUnitRunner', ok: false });
        expect(parseInstrumentation('INSTRUMENTATION_CODE: -1\n').ok).toBe(false);
    });

    test('reads DNS servers, name resolution, acceleration and the emulator build', () => {
        const connectivity = 'NetworkAgentInfo{... LinkProperties: {DnsAddresses: [ /10.0.2.3,/fec0::3 ] ...}\nDnsAddresses: [ /10.0.2.3 ]\nDnsAddresses: [ ]';
        expect(parseDnsAddresses(connectivity)).toEqual(['10.0.2.3', 'fec0::3']);
        expect(parseDnsAddresses('no networks')).toEqual([]);
        expect(parsePingResolution('PING registry.npmjs.org (104.16.1.34) 56(84) bytes of data.\n')).toBe('104.16.1.34');
        expect(parsePingResolution('ping: unknown host registry.npmjs.org')).toBeNull();
        expect(accelUsable('INFO    | KVM (version 12) is installed and usable.', 0)).toBe(true);
        expect(accelUsable('INFO    | KVM (version 12) is installed and usable.', 1)).toBe(false);
        expect(accelUsable('ERROR   | /dev/kvm is not found.', 0)).toBe(false);
        expect(parseEmulatorVersion('INFO | Android emulator version 37.2.12.0 (build_id 16428233) (CL:N/A)')).toEqual({ version: '37.2.12.0', buildId: '16428233' });
        expect(parseEmulatorVersion('garbage')).toEqual({ version: null, buildId: null });
    });

    test('reads AVD ini files, package versions and processes', () => {
        expect(parseIni('# AVD\r\ntarget=android-37.0\r\nimage.sysdir.1 = system-images/android-37.0/google_apis_ps16k/x86_64/\r\nempty=\r\n'))
            .toEqual({ target: 'android-37.0', 'image.sysdir.1': 'system-images/android-37.0/google_apis_ps16k/x86_64/', empty: '' });
        expect(parsePackageVersion('    versionCode=2 minSdk=29 targetSdk=37\n    versionName=1.0.0\n')).toEqual({ versionCode: 2, versionName: '1.0.0' });
        expect(parsePackageVersion('Unable to find package')).toEqual({ versionCode: null, versionName: null });
        expect(parseProcesses('  PID  PPID USER           NAME                        ARGS\n 4321   321 u0_a190        io.github.sillybunnyteam.sillybunny.debug io.github.sillybunnyteam.sillybunny.debug\n 4400  4321 u0_a190        libnode.so                  /data/app/lib/libnode.so server.js --port 50123\n'))
            .toEqual([
                { pid: 4321, ppid: 321, user: 'u0_a190', name: 'io.github.sillybunnyteam.sillybunny.debug', args: 'io.github.sillybunnyteam.sillybunny.debug' },
                { pid: 4400, ppid: 4321, user: 'u0_a190', name: 'libnode.so', args: '/data/app/lib/libnode.so server.js --port 50123' },
            ]);
    });

    test('reads the crash log: native dumps, as API 36, 37 and 29 write them, and uncaught exceptions', () => {
        const crashes = parseCrashLog(CRASH_LOG);
        const renderer = 'com.google.android.webview:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0';
        expect(crashes.map(({ summary, ...crash }) => crash)).toEqual([
            { kind: 'native', time: '10-23 18:10:14.017', pid: 5397, thread: 'Chrome_IOThread', process: DEFAULT_PACKAGE, signal: 'SIGTRAP',
                message: '[FATAL:partition_alloc_support.cc(770)] Detected dangling raw_ptr in unretained with id=0x00003c6a00c026e0:' },
            { kind: 'java', time: '10-23 18:21:00.000', pid: 6100, thread: 'main', process: DEFAULT_PACKAGE, signal: null,
                message: 'java.lang.IllegalStateException: no server' },
            { kind: 'native', time: '10-23 18:22:00.000', pid: 6190, thread: 'RenderThread', process: 'com.android.systemui', signal: 'SIGABRT', message: null },
            { kind: 'native', time: '10-23 20:58:50.608', pid: 10668, thread: 'ocessService0:0', process: renderer, signal: 'SIGTRAP',
                message: '[FATAL:base/android/java_exception_reporter.cc:93] Uncaught exception' },
            { kind: 'native', time: '10-23 21:02:00.180', pid: 10407, thread: 'illybunny.debug', process: DEFAULT_PACKAGE, signal: 'SIGABRT', message: null },
            { kind: 'native', time: '10-23 21:22:03.729', pid: 9165, thread: 'illybunny.debug', process: DEFAULT_PACKAGE, signal: 'SIGABRT', message: null },
            { kind: 'native', time: '10-23 22:08:29.592', pid: 11227, thread: 'libbash.so', process: BASH_PATH, signal: 'SIGABRT', message: null },
        ]);
        expect(crashes.map(crash => crash.summary)).toEqual([
            `SIGTRAP in Chrome_IOThread of ${DEFAULT_PACKAGE} at 10-23 18:10:14.017: [FATAL:partition_alloc_support.cc(770)] Detected dangling raw_ptr in unretained with id=0x00003c6a00c026e0:`,
            `an uncaught exception in main of ${DEFAULT_PACKAGE} at 10-23 18:21:00.000: java.lang.IllegalStateException: no server`,
            'SIGABRT in RenderThread of com.android.systemui at 10-23 18:22:00.000',
            `SIGTRAP in ocessService0:0 of ${renderer} at 10-23 20:58:50.608: [FATAL:base/android/java_exception_reporter.cc:93] Uncaught exception`,
            `SIGABRT in illybunny.debug of ${DEFAULT_PACKAGE} at 10-23 21:02:00.180`,
            `SIGABRT in illybunny.debug of ${DEFAULT_PACKAGE} at 10-23 21:22:03.729`,
            'SIGABRT in libbash.so of libbash.so at 10-23 22:08:29.592',
        ]);
        // The WebView renderer runs in its own isolated process, so its crash is not the app's.
        expect(crashes.map(crash => isAppCrash(crash, DEFAULT_PACKAGE))).toEqual([true, true, false, false, true, true, true]);
        expect(isAppCrash({ process: `${DEFAULT_PACKAGE}:remote` }, DEFAULT_PACKAGE)).toBe(true);
        expect(isAppCrash({ process: `${DEFAULT_PACKAGE}.test` }, DEFAULT_PACKAGE)).toBe(false);
        expect(isAppCrash({ process: `/data/app/${DEFAULT_PACKAGE}.test-a1b2/base.apk` }, DEFAULT_PACKAGE)).toBe(false);
        expect(isAppCrash({ process: null }, DEFAULT_PACKAGE)).toBe(false);
        expect(parseCrashLog('--------- beginning of crash\n')).toEqual([]);
    });

    test('reads the focused window and tells the system error dialogs apart (preflight)', () => {
        const anr = '  mCurrentFocus=Window{5346ae5 u0 Application Not Responding: com.android.systemui}\r\n  mFocusedApp=null\r\n';
        expect(parseFocusedWindow(anr)).toBe('Application Not Responding: com.android.systemui');
        expect(isErrorDialogWindow(parseFocusedWindow(anr))).toBe(true);
        expect(isErrorDialogWindow('Application Error: io.github.sillybunnyteam.sillybunny.debug')).toBe(true);
        const launcher = 'mCurrentFocus=Window{8fef26c u0 com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity}';
        expect(parseFocusedWindow(launcher)).toBe('com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity');
        expect(isErrorDialogWindow(parseFocusedWindow(launcher))).toBe(false);
        expect(isErrorDialogWindow('io.github.sillybunnyteam.sillybunny.debug/io.github.sillybunnyteam.sillybunny.MainActivity')).toBe(false);
        expect(parseFocusedWindow('  mCurrentFocus=null\n')).toBeNull();
        expect(isErrorDialogWindow(null)).toBe(false);
    });

    test('the adb client needs a serial and never maps port 4444', async () => {
        expect(thrown(() => new Adb({}))).toBeInstanceOf(Error);
        // A missing adb executable would fail differently: the port check comes before any process starts.
        const adb = new Adb({ serial: 'emulator-5628', adb: path.join(scratch, 'no-adb') });
        await expect(adb.reverse(4444, 30_000)).rejects.toThrow('Refusing to map reserved port 4444.');
        await expect(adb.reverse(38_411, 4444)).rejects.toThrow('Refusing to map reserved port 4444.');
        await expect(adb.forward(4444, 'localabstract:webview_devtools_remote_1')).rejects.toThrow('Refusing to map reserved port 4444.');
        await expect(adb.forward(30_000, 'tcp:4444')).rejects.toThrow('Refusing to map reserved port 4444.');
        expect([...adb.forwards, ...adb.reverses]).toEqual([]);
    });
});

describe('adb.js post-update notification (step 6)', () => {
    const { id, channel } = UPDATE_REPLACED_NOTIFICATION;
    const wanted = { pkg: DEFAULT_PACKAGE, id, channel };
    const replaced = { id, channel };
    const server = { id: 5401, channel: 'server' };

    test('is the notification PackageReplacedReceiver posts', () => {
        const source = fs.readFileSync(path.join(REPO_ROOT, 'android', 'app', 'src', 'main', 'java', 'io', 'github',
            'sillybunnyteam', 'sillybunny', 'update', 'UpdateNotifications.kt'), 'utf8');
        expect(source).toMatch(new RegExp(`\\bREPLACED_ID = ${id}\\b`));
        expect(source).toMatch(new RegExp(`\\bCHANNEL_ID = "${channel}"`));
    });

    test('a dump with only the server notification, posted and archived, does not count', () => {
        // Installing the update cancels the server notification, and the archive keeps it.
        const dump = notificationDump({ posted: [server], archived: [server] });
        expect(dump).toContain(`pkg=${DEFAULT_PACKAGE}`);
        expect(notificationPosted(dump, wanted)).toBe(false);
        expect(notificationPosted(dump.replace(/\n/g, '\r\n'), wanted)).toBe(false);
    });

    test('an archived or enqueued post-update notification, or another record of the package, does not count', () => {
        expect(notificationPosted(notificationDump({ archived: [server, replaced] }), wanted)).toBe(false);
        expect(notificationPosted(notificationDump({ archived: [replaced], api: 29 }), wanted)).toBe(false);
        expect(notificationPosted(notificationDump({ enqueued: [replaced] }), wanted)).toBe(false);
        expect(notificationPosted(notificationDump({ posted: [{ id, channel: 'server' }] }), wanted)).toBe(false);
        expect(notificationPosted(notificationDump({ posted: [{ id: 58010, channel }] }), wanted)).toBe(false);
        expect(notificationPosted(notificationDump({ posted: [{ ...replaced, pkg: `${DEFAULT_PACKAGE}.test` }] }), wanted)).toBe(false);
        expect(notificationPosted(notificationDump({ posted: [replaced] }), { ...wanted, pkg: 'io.github.sillybunnyteam.sillybunny' })).toBe(false);
        expect(notificationPosted('', wanted)).toBe(false);
    });

    test('the posted post-update notification counts, as API 37 and API 29 print it', () => {
        const dump = notificationDump({ posted: [server, replaced], archived: [server] });
        expect(notificationPosted(dump, wanted)).toBe(true);
        expect(notificationPosted(dump.replace(/\n/g, '\r\n'), wanted)).toBe(true);
        expect(notificationPosted(notificationDump({ posted: [replaced], archived: [replaced], api: 29 }), wanted)).toBe(true);
    });
});

describe('adb.js app files', () => {
    const pkg = DEFAULT_PACKAGE;

    test('encodes whole inputs as base64 in 76-column lines', () => {
        expect(base64Lines('lorum ipsum\n')).toBe('bG9ydW0gaXBzdW0K\n');
        expect(base64Lines(Buffer.alloc(0))).toBe('\n');
        const lines = base64Lines(BINARY).split('\n');
        expect(lines.pop()).toBe('');
        expect(lines.slice(0, -1).every(line => line.length === 76)).toBe(true);
        expect(lines.join('')).toMatch(/^[A-Za-z0-9+/]+=*$/);
        expect(Buffer.from(lines.join('\n'), 'base64')).toEqual(BINARY);
    });

    test('writes through adb shell as base64, so a failed device command fails the write', async () => {
        const adb = new RecordingAdb();
        await adb.writeAppFile(pkg, 'files/SillyBunny/.git/HEAD', 'lorum ipsum\n', { timeoutMs: 1_000 });
        await adb.untarIntoApp(pkg, 'files/SillyBunny/plugins', Buffer.from('tar'));
        expect(adb.calls.map(call => call.args)).toEqual([
            ['shell', `run-as ${pkg} sh -c 'base64 -d > files/SillyBunny/.git/HEAD'`],
            ['shell', `run-as ${pkg} sh -c 'mkdir -p cache files/SillyBunny/plugins && base64 -d > cache/smoke-upload.tar && tar -x -o -f cache/smoke-upload.tar -C files/SillyBunny/plugins; status=$?; rm -f cache/smoke-upload.tar; exit $status'`],
        ]);
        // No `check: false`, so Adb#run throws on the exit status that `adb shell` reports.
        expect(adb.calls.map(({ options }) => [options.input, options.check, options.timeoutMs])).toEqual([
            ['bG9ydW0gaXBzdW0K\n', undefined, 1_000],
            ['dGFy\n', undefined, 300_000],
        ]);
    });

    test('calls the smoke hook, with the method argument when there is one (step 10 kill)', async () => {
        const adb = new RecordingAdb([
            { code: 0, stdout: 'Result: Bundle[{json={"killed":4321}}]\r\n', stderr: '', timedOut: false },
            { code: 0, stdout: 'Result: Bundle[{json={"state":"Running","port":50123,"originChanged":false}}]\r\n', stderr: '', timedOut: false },
        ]);
        expect(await adb.hook(pkg, 'kill', { arg: 4321, timeoutMs: 30_000 })).toEqual({ killed: 4321 });
        expect(await adb.hook(pkg, 'state')).toMatchObject({ state: 'Running', port: 50123 });
        expect(adb.calls.map(({ args, options }) => [args, options])).toEqual([
            [['shell', `content call --uri content://${pkg}.smoke --method kill --arg 4321`], { timeoutMs: 30_000 }],
            [['shell', `content call --uri content://${pkg}.smoke --method state`], {}],
        ]);
    });

    test('reads base64 whatever line ends adb adds, and gives null when the device command fails', async () => {
        const windowsOutput = base64Lines(BINARY).replace(/\n/g, '\r\n');
        const adb = new RecordingAdb([
            { code: 0, stdout: windowsOutput, stderr: '', timedOut: false },
            { code: 1, stdout: '', stderr: 'base64: files/x: No such file or directory', timedOut: false },
            { code: 0, stdout: base64Lines('tar'), stderr: '', timedOut: false },
            { code: 1, stdout: '', stderr: 'tar: files/logs: No such file or directory', timedOut: false },
        ]);
        expect(await adb.readAppFile(pkg, 'files/a b')).toEqual(BINARY);
        expect(await adb.readAppFile(pkg, 'files/x')).toBeNull();
        expect(await adb.readAppArchive(pkg, 'files/logs')).toEqual(Buffer.from('tar'));
        expect(await adb.readAppArchive(pkg, 'files/logs')).toBeNull();
        expect(adb.calls.map(({ args, options }) => [args, options.check])).toEqual([
            [['shell', `run-as ${pkg} base64 'files/a b'`], false],
            [['shell', `run-as ${pkg} base64 files/x`], false],
            [['shell', `run-as ${pkg} sh -c 'mkdir -p cache && tar -cf cache/smoke-archive.tar files/logs && base64 cache/smoke-archive.tar; status=$?; rm -f cache/smoke-archive.tar; exit $status'`], false],
            [['shell', `run-as ${pkg} sh -c 'mkdir -p cache && tar -cf cache/smoke-archive.tar files/logs && base64 cache/smoke-archive.tar; status=$?; rm -f cache/smoke-archive.tar; exit $status'`], false],
        ]);
    });
});

describePosix('adb.js app files through a stand-in adb and run-as', () => {
    const PLUGIN = 'sillybunny-smoke-plugin';

    test('the device commands write, read and unpack byte for byte', async () => {
        const device = fakeDevice();
        try {
            await device.adb.runAs(DEFAULT_PACKAGE, ['mkdir', '-p', 'files/SillyBunny/.git']);
            await device.adb.writeAppFile(DEFAULT_PACKAGE, 'files/SillyBunny/.git/HEAD', 'lorum ipsum\n');
            expect(device.commands().slice(-1)).toEqual([`run-as ${DEFAULT_PACKAGE} sh -c 'base64 -d > files/SillyBunny/.git/HEAD'`]);
            expect(device.file('files/SillyBunny/.git/HEAD').toString('utf8')).toBe('lorum ipsum\n');

            const odd = 'files/SillyBunny/data/default-user/chats/smoke fixture/it\'s "x".jsonl';
            await device.adb.runAs(DEFAULT_PACKAGE, ['mkdir', '-p', path.posix.dirname(odd)]);
            await device.adb.writeAppFile(DEFAULT_PACKAGE, odd, BINARY);
            expect(device.file(odd)).toEqual(BINARY);
            expect(await device.adb.readAppFile(DEFAULT_PACKAGE, odd)).toEqual(BINARY);
            expect(await device.adb.readAppFile(DEFAULT_PACKAGE, 'files/missing')).toBeNull();

            const source = path.join(device.root, 'source');
            fs.mkdirSync(path.join(source, PLUGIN, '.git'), { recursive: true });
            fs.writeFileSync(path.join(source, PLUGIN, 'index.js'), BINARY);
            fs.writeFileSync(path.join(source, PLUGIN, '.git', 'HEAD'), 'ref: refs/heads/main\n');
            const archive = spawnSync('tar', ['--format', 'ustar', '-cf', '-', '-C', source, PLUGIN]).stdout;
            await device.adb.untarIntoApp(DEFAULT_PACKAGE, 'files/SillyBunny/plugins', archive);
            expect(device.file(`files/SillyBunny/plugins/${PLUGIN}/index.js`)).toEqual(BINARY);
            expect(device.file(`files/SillyBunny/plugins/${PLUGIN}/.git/HEAD`).toString('utf8')).toBe('ref: refs/heads/main\n');
            expect(fs.readdirSync(path.join(device.app, 'cache'))).toEqual([]);

            const back = await device.adb.readAppArchive(DEFAULT_PACKAGE, 'files/SillyBunny/plugins');
            const listing = spawnSync('tar', ['-tf', '-'], { input: back, encoding: 'utf8' }).stdout.split('\n');
            expect(listing).toContain(`files/SillyBunny/plugins/${PLUGIN}/index.js`);
            expect(fs.readdirSync(path.join(device.app, 'cache'))).toEqual([]);
        } finally {
            fs.rmSync(device.root, { recursive: true, force: true });
        }
    });

    test('a write or unpack that fails on the device throws', async () => {
        const device = fakeDevice();
        try {
            await expect(device.adb.writeAppFile(DEFAULT_PACKAGE, 'files/no-such-folder/x', 'x')).rejects.toThrow(/ exited [1-9]/);
            await expect(device.adb.writeAppFile('other.package', 'files/x', 'x')).rejects.toThrow(/ exited 1: run-as: unknown package/);
            await expect(device.adb.untarIntoApp(DEFAULT_PACKAGE, 'files/SillyBunny/plugins', Buffer.from('not a tar archive'))).rejects.toThrow(/ exited [1-9]/);
            expect(fs.readdirSync(path.join(device.app, 'cache'))).toEqual([]);
            expect(await device.adb.readAppArchive(DEFAULT_PACKAGE, 'files/missing')).toBeNull();
        } finally {
            fs.rmSync(device.root, { recursive: true, force: true });
        }
    });
});

describe('cdp.js and the smoke steps helpers', () => {
    test('redacts the per-install origin label and recognises the app origin', () => {
        expect(redactLabel('http://k3x9.localhost:50123/ and http://a-b.localhost/x')).toBe('http://<label>.localhost:50123/ and http://<label>.localhost/x');
        expect(redactLabel('http://127.0.0.1:50123/')).toBe('http://127.0.0.1:50123/');
        expect(isAppPageUrl('http://127.0.0.1:50123/', 50123)).toBe(true);
        expect(isAppPageUrl('http://k3x9.localhost:50123/#chat', 50123)).toBe(true);
        expect(isAppPageUrl('http://k3x9.localhost:50124/', 50123)).toBe(false);
        expect(isAppPageUrl('https://127.0.0.1:50123/', 50123)).toBe(false);
        expect(isAppPageUrl('http://example.com:50123/', 50123)).toBe(false);
        expect(isAppPageUrl('about:blank', 50123)).toBe(false);
        expect(isAppPageUrl('not a url', 50123)).toBe(false);
    });

    test('the cookie jar keeps the launch cookie for later requests', () => {
        const jar = new CookieJar();
        const headers = new Headers();
        headers.append('set-cookie', 'sillybunny_launch=abc; Path=/; HttpOnly; SameSite=Strict');
        headers.append('set-cookie', 'other=1');
        jar.store(headers);
        expect(jar.has('sillybunny_launch')).toBe(true);
        expect(jar.header()).toBe('sillybunny_launch=abc; other=1');
        jar.store(new Headers());
        expect(jar.header()).toBe('sillybunny_launch=abc; other=1');
    });

    test('step 7 switches to the remote branch entry, which is the name the UI sends', () => {
        const reply = [
            { current: true, commit: 'a1b2c3d', name: 'main', label: 'initial' },
            { current: false, commit: 'a1b2c3d', name: 'origin/main', label: 'initial' },
            { current: false, commit: 'e4f5a6b', name: 'origin/next', label: 'next' },
        ];
        expect(remoteBranchEntry(reply, 'next')).toBe(reply[2]);
        expect(remoteBranchEntry([{ name: 'next' }, { name: 'origin/nextgen' }, null], 'next')).toBeNull();
        expect(remoteBranchEntry('origin/next', 'next')).toBeNull();
        expect(remoteBranchEntry(null, 'next')).toBeNull();
    });

    test('the step context names the test package after the app', () => {
        const context = createContext({ adb: null, options: {}, fixtures: null, facts: null, out: scratch });
        expect(context.pkg).toBe(DEFAULT_PACKAGE);
        expect(context.testPkg).toBe(`${DEFAULT_PACKAGE}.test`);
        expect(context.state).toMatchObject({ noRestart: false, baseline: null, cdp: null });
    });

    test('the crash check notes the crashes from before the run, then gives the app\'s new ones', async () => {
        const later = [
            CRASH_LOG.trimEnd(),
            '10-23 21:30:00.000  6300  6300 F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***',
            `10-23 21:30:00.000  6300  6300 F DEBUG   : pid: 6290, ppid: 444, tid: 6290, name: illybunny.debug  >>> ${DEFAULT_PACKAGE} <<<`,
            '10-23 21:30:00.000  6300  6300 F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***',
            '10-23 21:30:00.000  6300  6300 F DEBUG   : pid: 6291, ppid: 444, tid: 6291, name: RenderThread  >>> com.android.systemui <<<',
            '',
        ].join('\n');
        const adb = new RecordingAdb([CRASH_LOG, CRASH_LOG, later, later].map(stdout => ({ code: 0, stdout, stderr: '', timedOut: false })));
        const context = createContext({ adb, options: {}, fixtures: null, facts: null, out: scratch });
        expect(await newAppCrashes(context)).toEqual([]);
        expect(await newAppCrashes(context)).toEqual([]);
        expect((await newAppCrashes(context)).map(crash => [crash.pid, crash.summary]))
            .toEqual([[6290, `a native crash in illybunny.debug of ${DEFAULT_PACKAGE} at 10-23 21:30:00.000`]]);
        expect(await newAppCrashes(context)).toEqual([]);
        expect(adb.calls.map(({ args }) => args)).toEqual(Array(4).fill(['logcat', '-d', '-b', 'crash', '-v', 'threadtime']));
    });

    test('looks for an app path with the shell builtin test, as API 29 has no test command (step 1)', async () => {
        const adb = new RecordingAdb([
            { code: 0, stdout: '', stderr: '', timedOut: false },
            { code: 1, stdout: '', stderr: '', timedOut: false },
        ]);
        const context = createContext({ adb, options: {}, fixtures: null, facts: null, out: scratch });
        expect(await appPathExists(context, 'files/SillyBunny/node_modules')).toBe(true);
        expect(await appPathExists(context, 'files/missing')).toBe(false);
        expect(adb.calls.map(({ args, options }) => [args, options.check])).toEqual([
            [['shell', `run-as ${DEFAULT_PACKAGE} sh -c 'test -e files/SillyBunny/node_modules'`], false],
            [['shell', `run-as ${DEFAULT_PACKAGE} sh -c 'test -e files/missing'`], false],
        ]);
    });

    test('picks the page target on the app origin from /json/list (old WebViews, steps 2 and 9)', () => {
        const targets = [
            { type: 'service_worker', url: 'http://sb-k3x9.localhost:50123/sw.js', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/1' },
            { type: 'page', url: 'http://sb-k3x9.localhost:50124/', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/2' },
            { type: 'page', url: 'http://sb-k3x9.localhost:50123/', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/3' },
        ];
        expect(appPageTarget(targets, 50123)).toBe(targets[2]);
        // A target that another DevTools client holds has no socket URL.
        expect(appPageTarget([{ ...targets[2], webSocketDebuggerUrl: undefined }], 50123)).toBeNull();
        expect(appPageTarget({ error: 'x' }, 50123)).toBeNull();
    });

    test('evaluates in an old WebView page through its DevTools socket (steps 2 and 9)', async () => {
        const socket = new FakeDevToolsSocket([
            { result: { result: { type: 'number', value: 200 } } },
            { result: { result: { type: 'boolean', value: false } } },
            { result: { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: navigated' } } } },
            { result: { result: { type: 'boolean', value: true } } },
            { result: { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is undefined' } } } },
            { error: { code: -32000, message: 'Cannot find context with specified id' } },
        ]);
        const page = new DevToolsPage(socket, 'http://sb-k3x9.localhost:50123/');
        expect(page.url()).toBe('http://sb-k3x9.localhost:50123/');
        expect(await page.evaluate(async target => (await fetch(target)).status, '/')).toBe(200);
        expect(await page.waitForFunction('document.title === "SillyBunny"', null, { timeout: 5_000, polling: 1 })).toBe(true);
        await expect(page.evaluate('x.y')).rejects.toThrow('Evaluation failed: TypeError: x is undefined');
        await expect(page.evaluate('1')).rejects.toThrow('Cannot find context with specified id (-32000)');

        expect(socket.sent.map(message => message.method)).toEqual(Array(6).fill('Runtime.evaluate'));
        expect(new Set(socket.sent.map(message => message.id)).size).toBe(6);
        expect(socket.sent[0].params).toMatchObject({ awaitPromise: true, returnByValue: true });
        expect(socket.sent[0].params.expression).toMatch(/^\(async target => [\s\S]+\)\("\/"\)$/);
        expect(socket.sent[1].params.expression).toBe('document.title === "SillyBunny"');
        expect(page.isClosed()).toBe(false);
    });

    test('an old WebView page session ends when its DevTools socket closes', async () => {
        const socket = new FakeDevToolsSocket();
        const page = new DevToolsPage(socket, 'http://127.0.0.1:50123/');
        const pending = page.evaluate('1');
        socket.close();
        await expect(pending).rejects.toThrow('The WebView page closed its DevTools socket');
        expect(page.isClosed()).toBe(true);
        await expect(page.evaluate('1')).rejects.toThrow('the DevTools page session is closed');
        await expect(page.waitForFunction('1', null, { timeout: 1_000, polling: 1 })).rejects.toThrow('waitForFunction: the page closed');
        page.close();
    });
});

describe('smoke-steps: the WebView and the frontend', () => {
    const webSources = path.join(REPO_ROOT, 'android', 'app', 'src', 'main', 'java', 'io', 'github', 'sillybunnyteam',
        'sillybunny', 'web');
    const providerLine = version => `Current WebView Update Service state\n  Current WebView package (name, version): (com.android.webview, ${version})\n  Minimum targetSdkVersion: 33\n`;

    test('the WebView minimum and the version warning tag are the app\'s', () => {
        expect(fs.readFileSync(path.join(webSources, 'WebViewVersion.kt'), 'utf8')).toMatch(new RegExp(`\\bMINIMUM_MAJOR = ${WEBVIEW_MINIMUM_MAJOR}\\b`));
        expect(fs.readFileSync(path.join(webSources, 'WebScreen.kt'), 'utf8')).toMatch(new RegExp(`\\bVERSION_WARNING = "${WEB_VERSION_WARNING_TAG}"`));
    });

    test('parseWebViewPackage reads the provider in use, as API 37 and API 29 print it', () => {
        const api37 = providerLine('145.0.7632.218').replace('com.android.webview', 'com.google.android.webview')
            + '  Preferred WebView package (name, version): (com.google.android.webview.beta, 146.0.1.1)\n';
        expect(parseWebViewPackage(api37)).toEqual({ package: 'com.google.android.webview', version: '145.0.7632.218', major: 145 });
        expect(parseWebViewPackage(api37.replace(/\n/g, '\r\n'))).toEqual({ package: 'com.google.android.webview', version: '145.0.7632.218', major: 145 });
        expect(parseWebViewPackage(providerLine('74.0.3729.185'))).toEqual({ package: 'com.android.webview', version: '74.0.3729.185', major: 74 });
        expect(parseWebViewPackage(providerLine('dev'))).toEqual({ package: 'com.android.webview', version: 'dev', major: null });
        expect(parseWebViewPackage('Current WebView Update Service state\n  Any WebView package installed: false\n')).toBeNull();
        expect(parseWebViewPackage('')).toBeNull();
    });

    test('webViewInfo asks the device once and runs the frontend from the app minimum up', async () => {
        const info = async (dump) => {
            const calls = [];
            const adb = { shellText: async (args) => {
                calls.push(args);
                return dump;
            } };
            const context = createContext({ adb, options: {}, fixtures: null, facts: null, out: scratch });
            const first = await webViewInfo(context);
            expect(await webViewInfo(context)).toBe(first);
            expect(calls).toEqual([['dumpsys', 'webviewupdate']]);
            return first;
        };
        expect(await info(providerLine('74.0.3729.185'))).toEqual({ package: 'com.android.webview', version: '74.0.3729.185', major: 74, frontend: false });
        expect(await info(providerLine(`${WEBVIEW_MINIMUM_MAJOR - 1}.0.1.2`))).toMatchObject({ frontend: false });
        expect(await info(providerLine(`${WEBVIEW_MINIMUM_MAJOR}.0.1.2`))).toMatchObject({ frontend: true });
        expect(await info(providerLine('145.0.7632.218'))).toMatchObject({ major: 145, frontend: true });
        // Unreadable: the WebView steps run and fail on their own evidence instead of being moved to a browser.
        expect(await info('')).toEqual({ package: null, version: null, major: null, frontend: true });
    });

    /** A page whose evaluate returns the given startup states in order, repeating the last one. */
    const startupPage = (states) => {
        const names = [];
        return {
            names,
            evaluate: async (_script, name) => {
                names.push(name);
                const next = states.length > 1 ? states.shift() : states[0];
                if (next instanceof Error) {
                    throw next;
                }
                return next;
            },
        };
    };
    const booted = { ready: true, preloader: false, acted: null };

    test('settleFrontend answers the startup prompts until the booted frontend stays quiet', async () => {
        const page = startupPage([
            { ready: false, preloader: true, acted: null },
            { ...booted, acted: 'popup' },
            { ...booted, acted: 'onboarding' },
            booted,
            { ...booted, acted: 'wizard' },
            booted,
        ]);
        await expect(settleFrontend(page, { intervalMs: 1 })).resolves.toEqual({ answered: ['popup', 'onboarding', 'wizard'] });
        // Five quiet polls in a row after the last answer; the quiet poll before the wizard does not count.
        expect(page.names).toHaveLength(10);
        expect(new Set(page.names)).toEqual(new Set(['lorum ipsum']));
    });

    test('settleFrontend counts a failed look, a preloader or a missing APP_READY as not settled', async () => {
        const navigating = startupPage([new Error('Execution context was destroyed'), booted]);
        await expect(settleFrontend(navigating, { intervalMs: 1 })).resolves.toEqual({ answered: [] });
        expect(navigating.names).toHaveLength(6);
        for (const stuck of [{ ...booted, preloader: true }, { ...booted, ready: false }, { ...booted, acted: 'popup' }]) {
            await expect(settleFrontend(startupPage([stuck]), { intervalMs: 1, timeoutMs: 30 })).rejects.toMatchObject({ code: 'frontend-not-ready' });
        }
        const aborted = AbortSignal.abort(new Error('step deadline'));
        await expect(settleFrontend(startupPage([booted]), { intervalMs: 1, signal: aborted })).rejects.toThrow('step deadline');
    });

    test('browserPage keeps no session whose page failed to open, so the next call opens a new one (API 29)', async () => {
        const reply = json => ({ code: 0, stdout: `Result: Bundle[{json=${JSON.stringify(json)}}]`, stderr: '', timedOut: false });
        const ok = { code: 0, stdout: '', stderr: '', timedOut: false };
        const running = reply({ state: 'Running', port: 50123 });
        const pid = { code: 0, stdout: '4321\n', stderr: '', timedOut: false };
        const adb = new RecordingAdb([running, pid, ok, ok, running, pid, ok, reply({})]);
        const contexts = [];
        const pages = [];
        let failures = 1;
        const context = createContext({ adb, options: {}, fixtures: null, facts: null, out: scratch });
        context.state.browserInstance = {
            newContext: async () => {
                const created = {
                    closed: false,
                    close: async () => {
                        created.closed = true;
                    },
                    newPage: async () => {
                        if (failures-- > 0) {
                            throw new Error('browserContext.newPage: Target closed');
                        }
                        const page = {
                            timeout: null,
                            setDefaultTimeout: (ms) => {
                                page.timeout = ms;
                            },
                            isClosed: () => false,
                        };
                        pages.push(page);
                        return page;
                    },
                };
                contexts.push(created);
                return created;
            },
        };
        await expect(browserPage(context)).rejects.toThrow('browserContext.newPage: Target closed');
        expect(context.state.browser).toBeNull();
        expect(contexts[0].closed).toBe(true);
        const forwards = adb.calls.map(({ args }) => args).filter(args => args[0] === 'forward');
        expect(forwards).toEqual([['forward', forwards[0][1], 'tcp:50123'], ['forward', '--remove', forwards[0][1]]]);
        expect(adb.forwards.size).toBe(0);
        // The second call gets past the page and stops at the hook's empty handoff reply.
        await expect(browserPage(context)).rejects.toMatchObject({ code: 'no-handoff' });
        expect(context.state.browser).toMatchObject({ pid: 4321, port: 50123, context: contexts[1], page: pages[0] });
        expect(pages[0].timeout).toBe(120_000);
    });
});

describe('run-smoke.js options', () => {
    const apk = scratchFile('options/app.apk', 'apk');
    const testApk = scratchFile('options/test.apk', 'apk');

    test('reads the run options with their defaults', () => {
        const options = parseRunOptions({ apk: [apk], 'test-apk': testApk }, { ANDROID_SERIAL: 'emulator-5554' });
        expect(options).toMatchObject({
            apk,
            testApk,
            updateApk: null,
            extraApks: [],
            serial: 'emulator-5554',
            adb: 'adb',
            steps: ALL_STEPS,
            defaultRef: 'staging',
            idleWaitMinutes: DEFAULT_IDLE_WAIT_MINUTES,
            out: null,
            scratch: null,
            source: REPO_ROOT,
            ref: 'HEAD',
            pkg: DEFAULT_PACKAGE,
            summary: null,
            uiTags: { ...DEFAULT_UI_TAGS },
        });
        const custom = parseRunOptions({
            apk: [apk], 'test-apk': testApk, 'update-apk': apk, serial: 'emulator-5628', steps: '1-3,9,14', 'default-ref': 'release',
            'idle-wait-minutes': '0', 'open-settings-tag': 'settings_open', 'failed-restart-tag': 'restart', 'failed-share-tag': 'share',
        }, { ANDROID_SERIAL: 'emulator-5554', GITHUB_STEP_SUMMARY: 'summary.md' });
        expect(custom).toMatchObject({
            updateApk: apk, serial: 'emulator-5628', steps: [1, 2, 3, 9, 14], defaultRef: 'release', idleWaitMinutes: 0, summary: 'summary.md',
            uiTags: { openSettings: 'settings_open', failedRestart: 'restart', failedShareLogs: 'share' },
        });
    });

    test('takes a new or empty scratch folder, which the fixtures start from', () => {
        const env = { ANDROID_SERIAL: 'emulator-5554' };
        const empty = path.join(scratch, 'options/empty-scratch');
        fs.mkdirSync(empty, { recursive: true });
        const fresh = path.join(scratch, 'options/new-scratch');
        expect(parseRunOptions({ apk: [apk], 'test-apk': testApk, scratch: empty }, env).scratch).toBe(empty);
        expect(parseRunOptions({ apk: [apk], 'test-apk': testApk, scratch: fresh }, env).scratch).toBe(fresh);
        expect(fs.existsSync(fresh)).toBe(false);
    });

    test('refuses a bad default-ref, steps, wait, serial, APK or scratch with a machine code', () => {
        const base = { apk: [apk], 'test-apk': testApk };
        const env = { ANDROID_SERIAL: 'emulator-5554' };
        const cases = [
            [{ ...base, 'default-ref': 'main' }, env, { code: 'invalid-default-ref', details: { option: 'default-ref', value: 'main' } }],
            [{ ...base, steps: '3-1' }, env, { code: 'invalid-steps' }],
            [{ ...base, 'idle-wait-minutes': '1.5' }, env, { code: 'invalid-integer' }],
            [{ ...base, 'idle-wait-minutes': '-1' }, env, { code: 'invalid-integer' }],
            [base, {}, { code: 'missing-option', details: { option: 'serial' } }],
            [{ ...base, apk: [apk, apk] }, env, { code: 'duplicate-option' }],
            [{ 'test-apk': testApk }, env, { code: 'missing-option', details: { option: 'apk' } }],
            [{ ...base, 'test-apk': path.join(scratch, 'missing.apk') }, env, { code: 'missing-file', details: { option: 'test-apk' } }],
            [{ ...base, scratch: path.dirname(apk) }, env, { code: 'scratch-not-empty', details: { option: 'scratch' } }],
            [{ ...base, scratch: apk }, env, { code: 'scratch-not-empty', details: { option: 'scratch' } }],
        ];
        for (const [values, environment, expected] of cases) {
            const error = thrown(() => parseRunOptions(values, environment));
            expect(error).toBeInstanceOf(UsageError);
            expect(error).toMatchObject(expected);
        }
    });

    test('reads integer options against a minimum', () => {
        expect(integerOption({}, 'n', 7)).toBe(7);
        expect(integerOption({ n: '12' }, 'n', 7)).toBe(12);
        expect(thrown(() => integerOption({ n: '0' }, 'n', 7, { min: 1 }))).toMatchObject({ code: 'invalid-integer' });
        expect(thrown(() => integerOption({ n: '1e3' }, 'n', 7))).toMatchObject({ code: 'invalid-integer' });
    });

    test('never prints a live handoff code', () => {
        expect(redactHandoff({ code: 'x'.repeat(75), path: '/__sillybunny/handoff', port: 50123 })).toEqual({ codeLength: 75, path: '/__sillybunny/handoff', port: 50123 });
        expect(redactHandoff({ error: 'not-running', state: 'Starting' })).toEqual({ error: 'not-running', state: 'Starting' });
    });
});

describe('run-smoke.js command line', () => {
    test('prints the Gradle fixture overrides', () => {
        const args = runCli(['gradle-args', '--format', 'args']);
        expect(args.code).toBe(0);
        expect(args.stdout.trim().split(' ')).toEqual(Object.entries(gradleProperties()).map(([key, value]) => `-P${key}=${value}`));
        const json = runCli(['gradle-args']);
        expect(JSON.parse(json.stdout)).toEqual({ ok: true, guestPorts: { ...GUEST_PORTS }, properties: gradleProperties(), args: args.stdout.trim().split(' ') });
    });

    test('answers usage errors with exit code 2, a placeholder message and a machine code', () => {
        const cases = [
            [['run', '--default-ref', 'main'], { code: 'invalid-default-ref', option: 'default-ref', value: 'main' }],
            [['bogus'], { code: 'unknown-command', value: 'bogus' }],
            [['guard', '--nope'], { code: 'invalid-arguments' }],
            [['gradle-args', '--format', 'xml'], { code: 'invalid-format', option: 'format', value: 'xml' }],
            [['apk-check'], { code: 'missing-option', option: 'apk' }],
        ];
        for (const [args, expected] of cases) {
            const result = runCli(args, { ANDROID_SERIAL: '' });
            expect([args.join(' '), result.code]).toEqual([args.join(' '), 2]);
            expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: 'TODO(copy)', ...expected });
        }
        expect(runCli(['help'])).toMatchObject({ code: 0, stdout: 'TODO(copy)\n' });
    });

    test('lists the steps', () => {
        const result = runCli(['steps']);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout).steps.map(step => step.id)).toEqual(ALL_STEPS);
    });

    test('apk-check fails an APK that ships Bun and passes one that does not', () => {
        const clean = scratchFile('apks/clean.apk', zipWithNames(['lib/x86_64/libnode.so', 'assets/web/bundle.js']));
        const bun = scratchFile('apks/bun.apk', zipWithNames(['lib/x86_64/libbun.so']));
        const passed = runCli(['apk-check', '--apk', clean]);
        expect(passed.code).toBe(0);
        expect(JSON.parse(passed.stdout)).toEqual({ ok: true, results: [{ apk: clean, bun: [] }] });
        const failed = runCli(['apk-check', '--apk', clean, '--apk', bun]);
        expect(failed.code).toBe(1);
        expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, error: 'TODO(copy)', code: 'bun-in-apk', results: [{ bun: [] }, { bun: ['lib/x86_64/libbun.so'] }] });
    });
});
