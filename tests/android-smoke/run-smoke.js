/**
 * The Android smoke entry point (plan §7.1, tasks 6.2-6.4). CI (`.github/workflows/android-smoke.yml`) and a
 * developer run the same commands. Each command prints one JSON line on stdout; progress goes to stderr.
 *
 *   guard       [--runtime-lock FILE] [--github-output FILE] [--step-summary FILE]
 *               Skip decision: every Node digest in android/runtime.lock pinned -> run; all null -> skip with
 *               a ::notice:: and a job-summary line; anything else fails (exit 1).
 *   gradle-args [--format json|args]
 *               The test APK's fixture URL overrides (fixed guest ports, see smoke-config.js GUEST_PORTS).
 *   apk-check   --apk FILE...
 *               Step 13's APK half: no Bun binary or link in any APK (exit 1 if one has).
 *   preflight   [--serial S] [--api-level L --avd NAME [--avd-home DIR]] [--emulator FILE] [--emulator-build ID]
 *               [--ui-timeout-seconds 300] [--dns-timeout-seconds 90] [--dns-host registry.npmjs.org] [--out DIR]
 *               Emulator checks before any step: hardware acceleration (-accel-check), the emulator build, the
 *               AVD's root .ini target, UI and system-service readiness beyond sys.boot_completed, and DNS.
 *   probe       --apk FILE --test-apk FILE [--serial S] [--out DIR] [--package ID]
 *               Harness check on the current app: install, launch, pid, the debug hook and a CDP attach.
 *   run         --apk FILE --test-apk FILE [--update-apk FILE] [--extra-apk FILE]... [--serial S] [--steps all|1-3,9,14]
 *               [--default-ref staging|release] [--idle-wait-minutes 10] [--out DIR] [--scratch DIR]
 *               [--source DIR] [--ref REV] [--package ID] [--summary FILE] [--open-settings-tag T]
 *               [--failed-restart-tag T] [--failed-share-tag T]
 *               Starts p61's fixtures in a new or empty --scratch folder (default: a new temporary one), maps
 *               them into the guest with adb reverse, runs the steps, checks the seeded data/ and the crash log
 *               after every step, collects logs and removes every port rule it added.
 *   steps       The step table.
 *
 * `--serial` defaults to ANDROID_SERIAL (set by the emulator runner action). Exit codes: 0 pass (or skip),
 * 1 failure, 2 usage error. Errors print `{ok:false, error:'TODO(copy)', code, ...}`.
 *
 * Only Node built-ins load up front, so `guard`, `gradle-args` and `apk-check` work before `npm ci` in tests/;
 * the device commands import Playwright and the fixtures when they start.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
    accelUsable,
    Adb,
    isErrorDialogWindow,
    parseDnsAddresses,
    parseEmulatorVersion,
    parseFocusedWindow,
    parseIni,
    parsePackageVersion,
    parsePingResolution,
    runCommand,
} from './adb.js';
import {
    bunEntries,
    DEFAULT_PACKAGE,
    DEFAULT_UI_TAGS,
    GUEST_PORTS,
    gradleProperties,
    MAIN_ACTIVITY,
    readRepositoryFacts,
    REPO_ROOT,
    SMOKE_TEST_CLASS,
    zipEntryNames,
} from './smoke-config.js';
import { appendOutputs, appendSummary, evaluateRuntimeLockFile, guardReport } from './smoke-guard.js';
import { parseStepSelection, runSteps, STEPS, summarize, summaryTable } from './smoke-runner.js';

/** The placeholder every message a person reads carries until the copy exists. */
const MESSAGE = 'TODO(copy)';

/** A command-line mistake: a machine code and the offending option, never prose. */
export class UsageError extends Error {
    constructor(code, details = {}) {
        super(code);
        this.code = code;
        this.details = details;
    }
}

export const OPTIONS = Object.freeze({
    'runtime-lock': { type: 'string' },
    'github-output': { type: 'string' },
    'step-summary': { type: 'string' },
    'format': { type: 'string' },
    'apk': { type: 'string', multiple: true },
    'test-apk': { type: 'string' },
    'update-apk': { type: 'string' },
    'extra-apk': { type: 'string', multiple: true },
    'serial': { type: 'string' },
    'adb': { type: 'string' },
    'steps': { type: 'string' },
    'default-ref': { type: 'string' },
    'idle-wait-minutes': { type: 'string' },
    'out': { type: 'string' },
    'scratch': { type: 'string' },
    'source': { type: 'string' },
    'ref': { type: 'string' },
    'package': { type: 'string' },
    'summary': { type: 'string' },
    'open-settings-tag': { type: 'string' },
    'failed-restart-tag': { type: 'string' },
    'failed-share-tag': { type: 'string' },
    'api-level': { type: 'string' },
    'avd': { type: 'string' },
    'avd-home': { type: 'string' },
    'emulator': { type: 'string' },
    'emulator-build': { type: 'string' },
    'ui-timeout-seconds': { type: 'string' },
    'dns-timeout-seconds': { type: 'string' },
    'dns-host': { type: 'string' },
    'help': { type: 'boolean' },
});

export const DEFAULT_IDLE_WAIT_MINUTES = 10;
export const DEFAULT_DNS_HOST = 'registry.npmjs.org';
export const DEFAULT_DNS_TIMEOUT_SECONDS = 90;
export const DEFAULT_UI_TIMEOUT_SECONDS = 300;

function required(values, name) {
    const value = values[name];
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
        throw new UsageError('missing-option', { option: name });
    }
    return value;
}

/**
 * A non-negative integer option.
 * @param {Record<string, any>} values Parsed options.
 * @param {string} name Option.
 * @param {number} fallback Value when absent.
 * @param {{min?: number}} [limits] Smallest allowed value.
 * @returns {number} Value.
 */
export function integerOption(values, name, fallback, { min = 0 } = {}) {
    if (values[name] === undefined) {
        return fallback;
    }
    const text = values[name];
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < min) {
        throw new UsageError('invalid-integer', { option: name });
    }
    return Number(text);
}

function existingFile(values, name) {
    const file = path.resolve(required(values, name));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new UsageError('missing-file', { option: name });
    }
    return file;
}

/**
 * The `--scratch` folder, which must be new or empty: launcher.js reuses the repositories it finds there with an
 * earlier run's helper commits, and the update folder keeps that run's manifest, so step 1 would start against a
 * raised min-app-version and an offered APK update.
 */
function freshScratch(values) {
    if (!values.scratch) {
        return null;
    }
    const dir = path.resolve(values.scratch);
    if (fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length > 0)) {
        throw new UsageError('scratch-not-empty', { option: 'scratch' });
    }
    return dir;
}

function serialOf(values, env) {
    const serial = values.serial ?? env.ANDROID_SERIAL;
    if (!serial) {
        throw new UsageError('missing-option', { option: 'serial' });
    }
    return serial;
}

/**
 * Validates the options of `run` (no device access; files are only checked for existence, the scratch folder for
 * being new or empty).
 * @param {Record<string, any>} values Parsed options.
 * @param {NodeJS.ProcessEnv} [env] Environment (ANDROID_SERIAL, GITHUB_STEP_SUMMARY).
 * @returns {object} Normalized options.
 */
export function parseRunOptions(values, env = process.env) {
    const apks = values.apk ?? [];
    if (apks.length > 1) {
        throw new UsageError('duplicate-option', { option: 'apk' });
    }
    const defaultRef = values['default-ref'] ?? 'staging';
    if (defaultRef !== 'staging' && defaultRef !== 'release') {
        throw new UsageError('invalid-default-ref', { option: 'default-ref', value: defaultRef });
    }
    let steps;
    try {
        steps = parseStepSelection(values.steps);
    } catch (error) {
        throw new UsageError(error.code ?? 'invalid-steps', { option: 'steps', value: values.steps });
    }
    return {
        apk: existingFile({ apk: apks[0] }, 'apk'),
        testApk: existingFile(values, 'test-apk'),
        updateApk: values['update-apk'] === undefined ? null : existingFile(values, 'update-apk'),
        extraApks: (values['extra-apk'] ?? []).map(file => existingFile({ 'extra-apk': file }, 'extra-apk')),
        serial: serialOf(values, env),
        adb: values.adb ?? 'adb',
        steps,
        defaultRef,
        idleWaitMinutes: integerOption(values, 'idle-wait-minutes', DEFAULT_IDLE_WAIT_MINUTES),
        out: values.out ? path.resolve(values.out) : null,
        scratch: freshScratch(values),
        source: values.source ? path.resolve(values.source) : REPO_ROOT,
        ref: values.ref ?? 'HEAD',
        pkg: values.package ?? DEFAULT_PACKAGE,
        summary: values.summary ?? env.GITHUB_STEP_SUMMARY ?? null,
        uiTags: {
            openSettings: values['open-settings-tag'] ?? DEFAULT_UI_TAGS.openSettings,
            failedRestart: values['failed-restart-tag'] ?? DEFAULT_UI_TAGS.failedRestart,
            failedShareLogs: values['failed-share-tag'] ?? DEFAULT_UI_TAGS.failedShareLogs,
        },
    };
}

/**
 * The handoff reply without the code itself: a live code redeems the launch cookie for 30 s.
 * @param {object} reply Hook reply.
 * @returns {object} Reply with the code's length instead of its value.
 */
export function redactHandoff(reply) {
    if (typeof reply?.code !== 'string') {
        return reply;
    }
    const { code, ...rest } = reply;
    return { ...rest, codeLength: code.length };
}

function print(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

function progress(line) {
    process.stderr.write(`[android-smoke] ${line}\n`);
}

function outDir(requested, prefix) {
    const dir = requested ?? fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

async function commandGuard(values) {
    const lock = path.resolve(values['runtime-lock'] ?? path.join(REPO_ROOT, 'android', 'runtime.lock'));
    const decision = evaluateRuntimeLockFile(lock);
    const report = guardReport(decision);
    const outputFile = values['github-output'] ?? process.env.GITHUB_OUTPUT;
    const summaryFile = values['step-summary'] ?? process.env.GITHUB_STEP_SUMMARY;
    if (outputFile) {
        appendOutputs(outputFile, report.outputs);
    }
    if (summaryFile) {
        appendSummary(summaryFile, report.summary);
    }
    for (const command of report.commands) {
        process.stdout.write(`${command}\n`);
    }
    print({ ok: decision.ok, run: decision.run, code: decision.code, abis: decision.abis, ...(decision.detail ? { detail: decision.detail } : {}) });
    if (!decision.ok) {
        process.exitCode = 1;
    }
}

async function commandGradleArgs(values) {
    const properties = gradleProperties();
    const args = Object.entries(properties).map(([key, value]) => `-P${key}=${value}`);
    const format = values.format ?? 'json';
    if (format === 'args') {
        process.stdout.write(`${args.join(' ')}\n`);
    } else if (format === 'json') {
        print({ ok: true, guestPorts: GUEST_PORTS, properties, args });
    } else {
        throw new UsageError('invalid-format', { option: 'format', value: format });
    }
}

async function commandApkCheck(values) {
    const files = required(values, 'apk').map(file => existingFile({ apk: file }, 'apk'));
    const results = files.map(file => ({ apk: file, bun: bunEntries(zipEntryNames(fs.readFileSync(file))) }));
    const ok = results.every(result => result.bun.length === 0);
    print({ ok, results, ...(ok ? {} : { error: MESSAGE, code: 'bun-in-apk' }) });
    if (!ok) {
        process.exitCode = 1;
    }
}

async function poll(check, { timeoutMs, intervalMs = 2_000 }) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        try {
            last = await check();
            if (last?.ok) {
                return last;
            }
        } catch (error) {
            last = { ok: false, error: error.message };
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return { ...last, ok: false, timedOut: true };
}

/**
 * UI and system services are usable, not just `sys.boot_completed`. A system error dialog with the focus is
 * dismissed, and the check fails until the next poll finds the focus elsewhere.
 * @param {Adb} adb Device.
 * @param {string[]} dismissed Receives the title of each error dialog dismissed.
 */
async function uiReady(adb, dismissed) {
    const checks = {};
    checks.bootCompleted = (await adb.getprop('sys.boot_completed', { timeoutMs: 15_000 })) === '1';
    checks.bootAnimation = (await adb.getprop('init.svc.bootanim', { timeoutMs: 15_000 })) !== 'running';
    const services = await adb.shellText(['service', 'list'], { check: false, timeoutMs: 15_000 });
    checks.services = ['package', 'activity', 'window', 'settings', 'input', 'connectivity'].every(name => new RegExp(`\\s${name}: \\[`).test(services));
    checks.packageManager = /^package:/.test(await adb.shellText(['pm', 'path', 'android'], { check: false, timeoutMs: 30_000 }));
    await adb.shell(['wm', 'dismiss-keyguard'], { check: false, timeoutMs: 15_000 });
    // The whole dump: API 37 prints mCurrentFocus with the displays, API 29 with the windows.
    const focus = parseFocusedWindow(await adb.shellText(['dumpsys', 'window'], { check: false, timeoutMs: 30_000 }));
    checks.focusedWindow = focus !== null && !isErrorDialogWindow(focus);
    if (isErrorDialogWindow(focus)) {
        // A slow boot can leave "System UI isn't responding" over every screen (seen on API 36), and UiAutomator
        // then finds none of the app's elements. The system closes this dialog on CLOSE_SYSTEM_DIALOGS as on Wait.
        dismissed.push(focus);
        await adb.shell(['am', 'broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS'], { check: false, timeoutMs: 15_000 });
    }
    return { ok: Object.values(checks).every(Boolean), ...checks };
}

/** DNS has servers and resolves a public name (S2.1 §6: lookups fail for 30-60 s after boot on API 37). */
async function dnsReady(adb, host) {
    const connectivity = await adb.shellText(['dumpsys', 'connectivity'], { check: false, timeoutMs: 30_000 });
    const dns = parseDnsAddresses(connectivity);
    const ping = await adb.shell(['ping', '-c', '1', '-W', '2', host], { check: false, timeoutMs: 20_000 });
    const resolved = parsePingResolution(`${ping.stdout}\n${ping.stderr}`);
    return { ok: dns.length > 0 && resolved !== null, dnsServers: dns.length, resolved: resolved !== null };
}

async function commandPreflight(values) {
    const adb = new Adb({ serial: serialOf(values, process.env), adb: values.adb ?? 'adb', log: progress });
    const out = values.out ? outDir(path.resolve(values.out), 'sillybunny-android-preflight-') : null;
    const uiTimeout = integerOption(values, 'ui-timeout-seconds', DEFAULT_UI_TIMEOUT_SECONDS, { min: 1 });
    const dnsTimeout = integerOption(values, 'dns-timeout-seconds', DEFAULT_DNS_TIMEOUT_SECONDS, { min: 1 });
    const result = { ok: false, serial: adb.serial };
    const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? '';
    const emulator = values.emulator ?? path.join(sdkRoot, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator');
    try {
        const accel = await runCommand(emulator, ['-accel-check'], { timeoutMs: 60_000 });
        result.accel = { usable: accelUsable(`${accel.stdout}\n${accel.stderr}`, accel.code), code: accel.code };
        if (!result.accel.usable) {
            throw new Error(`emulator -accel-check: ${`${accel.stdout} ${accel.stderr}`.trim().slice(0, 500)}`);
        }
        const version = await runCommand(emulator, ['-version'], { timeoutMs: 60_000 });
        result.emulator = parseEmulatorVersion(`${version.stdout}\n${version.stderr}`);
        if (values['emulator-build'] && result.emulator.buildId !== values['emulator-build']) {
            throw new Error(`emulator build ${result.emulator.buildId}, expected ${values['emulator-build']}`);
        }
        if (values.avd) {
            const home = values['avd-home'] ?? process.env.ANDROID_AVD_HOME ?? path.join(os.homedir(), '.android', 'avd');
            const root = parseIni(fs.readFileSync(path.join(home, `${values.avd}.ini`), 'utf8'));
            // The root .ini's `path` names the AVD folder, which `avdmanager create avd -p` puts anywhere.
            const folder = root.path && fs.existsSync(root.path) ? root.path : path.join(home, `${values.avd}.avd`);
            const config = parseIni(fs.readFileSync(path.join(folder, 'config.ini'), 'utf8'));
            result.avd = { target: root.target ?? null, image: config['image.sysdir.1'] ?? null, ramSize: config['hw.ramSize'] ?? null };
            if (values['api-level'] && root.target !== `android-${values['api-level']}`) {
                throw new Error(`AVD ${values.avd} targets ${root.target}, expected android-${values['api-level']}`);
            }
        }
        const started = Date.now();
        const dismissed = [];
        result.ui = await poll(() => uiReady(adb, dismissed), { timeoutMs: uiTimeout * 1000 });
        result.ui.seconds = Math.round((Date.now() - started) / 1000);
        result.ui.dismissedDialogs = dismissed;
        if (!result.ui.ok) {
            throw new Error(`the UI was not ready within ${uiTimeout} s: ${JSON.stringify(result.ui)}`);
        }
        const dnsStarted = Date.now();
        result.dns = await poll(() => dnsReady(adb, values['dns-host'] ?? DEFAULT_DNS_HOST), { timeoutMs: dnsTimeout * 1000 });
        result.dns.seconds = Math.round((Date.now() - dnsStarted) / 1000);
        if (!result.dns.ok) {
            throw new Error(`DNS did not resolve within ${dnsTimeout} s: ${JSON.stringify(result.dns)}`);
        }
        result.sdk = await adb.sdkLevel();
        result.ok = true;
    } catch (error) {
        result.error = MESSAGE;
        result.detail = error.message;
        process.exitCode = 1;
        if (out) {
            await adb.saveLogcat(path.join(out, 'preflight-logcat.txt')).catch(() => {});
            await adb.saveScreenshot(path.join(out, 'preflight-screen.png')).catch(() => {});
        }
    }
    if (out) {
        fs.writeFileSync(path.join(out, 'preflight.json'), `${JSON.stringify(result, null, 4)}\n`);
    }
    print(result);
}

/**
 * The CDP attach on today's app: `SmokeUiTest#webViewHost` shows a WebView in the app process and waits
 * until its title becomes a token; the host attaches over CDP and sets that title.
 */
async function probeCdp(ctx, attachWebView) {
    const title = `smoke-${process.pid}-${Date.now()}`;
    let finished = false;
    const instrumentation = ctx.adb.instrument({
        testPackage: ctx.testPkg,
        testClass: SMOKE_TEST_CLASS,
        method: 'webViewHost',
        args: { title, timeoutSeconds: 120, smokeRun: 'true' },
        timeoutMs: 180_000,
    }).finally(() => {
        finished = true;
    });
    // Awaited below; this keeps an early adb failure from counting as an unhandled rejection meanwhile.
    instrumentation.catch(() => {});
    const deadline = Date.now() + 120_000;
    let attached = null;
    let lastError = null;
    let loopError = null;
    try {
        while (!attached && !finished && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 1_000));
            const pid = await ctx.adb.pidof(ctx.pkg);
            if (!pid) {
                continue;
            }
            const sockets = await ctx.adb.shellText(['cat', '/proc/net/unix'], { check: false });
            if (!sockets.includes(`@webview_devtools_remote_${pid}`)) {
                continue;
            }
            try {
                const connection = await attachWebView({ adb: ctx.adb, pid });
                try {
                    const pages = connection.browser.contexts().flatMap(context => context.pages());
                    if (pages.length === 0) {
                        throw new Error('no WebView page');
                    }
                    await pages[0].evaluate((value) => {
                        document.title = value;
                    }, title);
                    attached = { pid, devtools: connection.version.Browser ?? null, pages: pages.length };
                } finally {
                    await connection.close();
                }
            } catch (error) {
                lastError = error;
            }
        }
    } catch (error) {
        loopError = error;
    }
    // The test method ends once the title is set or its own timeout passes; its result explains most failures.
    const result = await instrumentation;
    fs.writeFileSync(path.join(ctx.out, 'instrument-webViewHost.txt'), result.raw);
    if (!result.ok) {
        const tests = result.tests.map(test => `${test.status} ${String(test.stack ?? '').split('\n')[0]}`).join('; ');
        throw new Error(`webViewHost: ${tests || result.failedToStart || result.shortMsg || result.code}`);
    }
    if (loopError) {
        throw loopError;
    }
    if (!attached) {
        throw new Error(`no CDP attach: ${lastError?.message ?? 'no devtools socket'}`);
    }
    return attached;
}

async function commandProbe(values) {
    const { attachWebView } = await import('./cdp.js');
    const { closeCdp, createContext, launchApp } = await import('./smoke-steps.js');
    const options = {
        apk: existingFile({ apk: (values.apk ?? [])[0] }, 'apk'),
        testApk: existingFile(values, 'test-apk'),
        pkg: values.package ?? DEFAULT_PACKAGE,
    };
    const out = outDir(values.out ? path.resolve(values.out) : null, 'sillybunny-android-probe-');
    const adb = new Adb({ serial: serialOf(values, process.env), adb: values.adb ?? 'adb', log: progress });
    const ctx = createContext({ adb, pkg: options.pkg, options, fixtures: null, facts: null, out, log: progress });
    const result = { ok: false, out, checks: {} };
    const timed = async (name, work) => {
        const started = Date.now();
        try {
            const value = await work();
            result.checks[name] = { ok: true, ms: Date.now() - started, ...(value ?? {}) };
        } catch (error) {
            result.checks[name] = { ok: false, ms: Date.now() - started, error: error.message };
            throw error;
        }
    };
    try {
        await timed('device', async () => ({ state: await adb.state(), sdk: await adb.sdkLevel(), noRestart: await adb.supportsNoRestart() }));
        await timed('install', async () => {
            await adb.uninstall(ctx.testPkg);
            await adb.uninstall(ctx.pkg);
            await adb.install(options.apk);
            await adb.install(options.testApk);
            return parsePackageVersion(await adb.shellText(['dumpsys', 'package', ctx.pkg]));
        });
        await timed('launch', async () => ({ ...(await launchApp(ctx)), activity: MAIN_ACTIVITY }));
        await timed('pid', async () => {
            const pid = await adb.pidof(ctx.pkg);
            if (!pid) {
                throw new Error(`${ctx.pkg} has no process`);
            }
            return { pid };
        });
        await timed('hookState', async () => ({ reply: await adb.hook(ctx.pkg, 'state') }));
        await timed('hookHandoff', async () => ({ reply: redactHandoff(await adb.hook(ctx.pkg, 'handoff')) }));
        await timed('cdp', () => probeCdp(ctx, attachWebView));
        result.ok = true;
    } catch (error) {
        result.error = MESSAGE;
        result.detail = error.message;
        process.exitCode = 1;
    } finally {
        await closeCdp(ctx).catch(() => {});
        await adb.removeAllRules().catch(() => {});
        fs.writeFileSync(path.join(out, 'probe.json'), `${JSON.stringify(result, null, 4)}\n`);
    }
    print(result);
}

/** Logs that help after a failure; never the app's data/ or config.yaml. */
async function collectDiagnostics(ctx) {
    const { adb, out } = ctx;
    const attempt = async (name, work) => {
        try {
            await work();
        } catch (error) {
            progress(`diagnostics ${name}: ${error.message}`);
        }
    };
    await attempt('logcat', () => adb.saveLogcat(path.join(out, 'logcat.txt')));
    await attempt('screenshot', () => adb.saveScreenshot(path.join(out, 'screen.png')));
    await attempt('window', () => adb.saveWindowDump(path.join(out, 'window.xml')));
    await attempt('app-logs', async () => {
        const archive = await adb.readAppArchive(ctx.pkg, 'files/logs', { timeoutMs: 120_000 });
        if (archive?.length > 0) {
            fs.writeFileSync(path.join(out, 'app-logs.tar'), archive);
        }
    });
    await attempt('fixture-logs', () => {
        const logs = ctx.fixtures?.info?.logs;
        if (logs && fs.existsSync(logs)) {
            fs.mkdirSync(path.join(out, 'fixtures'), { recursive: true });
            for (const name of fs.readdirSync(logs)) {
                fs.copyFileSync(path.join(logs, name), path.join(out, 'fixtures', name));
            }
        }
    });
}

/**
 * The lines of summary.md and of the job summary: the step table, then the run's own failure, which no step record
 * holds (the steps could not start, or an unhandled rejection came outside them).
 * @param {object[]} records Step records.
 * @param {string} [detail] The run's failure, English for the CI log.
 * @returns {string[]} Markdown lines.
 */
export function runSummary(records, detail) {
    const table = summaryTable(records);
    if (!detail) {
        return table;
    }
    // A code span, so that a redacted `<label>` stays visible in GitHub's rendering.
    const text = String(detail).replace(/\s+/g, ' ').replace(/`/g, '\'').slice(0, 1000);
    return [...table, '', `${MESSAGE}: \`${text}\``];
}

async function commandRun(values) {
    const options = parseRunOptions(values);
    const { SERVICES, startFixtures } = await import('./launcher.js');
    const { checkDataSafety, closeBrowser, closeCdp, createContext, fixtureView, newAppCrashes, smokeSteps } = await import('./smoke-steps.js');
    // Playwright's errors name the page URL; its per-install origin label stays out of the logs and summaries.
    const { redactLabel } = await import('./cdp.js');
    const out = outDir(options.out, 'sillybunny-android-smoke-');
    const scratch = outDir(options.scratch, 'sillybunny-android-smoke-scratch-');
    const adb = new Adb({ serial: options.serial, adb: options.adb, log: progress });
    const facts = readRepositoryFacts(REPO_ROOT);
    const result = { ok: false, out, serial: options.serial, steps: options.steps, defaultRef: options.defaultRef };
    let fixtures = null;
    let ctx = null;
    let records = [];
    // A rejection nobody awaits (for example from a Playwright page handler) would end the process before the
    // port rules, the fixtures and the results are dealt with. It is logged instead, and fails the step that was
    // running when it came, or the run when no step was.
    const unhandled = [];
    const outsideSteps = [];
    const onUnhandled = (error) => {
        unhandled.push(redactLabel(String(error?.message ?? error).split('\n')[0]));
        progress(`unhandled rejection: ${unhandled[unhandled.length - 1]}`);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
        const state = await adb.state();
        if (state !== 'device') {
            throw new Error(`device ${options.serial} is ${state || 'not attached'}`);
        }
        result.sdk = await adb.sdkLevel();
        fixtures = await startFixtures({ services: [...SERVICES], scratch, source: options.source, ref: options.ref });
        for (const [service, guestPort] of Object.entries(GUEST_PORTS)) {
            await adb.reverse(guestPort, fixtures.info.services[service].port);
        }
        ctx = createContext({ adb, pkg: options.pkg, options, fixtures: fixtureView(fixtures.info), facts, out, log: progress });
        ctx.state.noRestart = await adb.supportsNoRestart();
        result.noRestart = ctx.state.noRestart;
        // The crash log keeps the crashes from before the run, so this first look only notes them.
        await newAppCrashes(ctx).catch(error => progress(`crash log: ${error.message}`));
        outsideSteps.push(...unhandled.splice(0));
        records = await runSteps({
            steps: smokeSteps(options),
            selected: options.steps,
            context: ctx,
            newRejections: () => unhandled.splice(0),
            newCrashes: () => newAppCrashes(ctx),
            afterStep: () => checkDataSafety(ctx),
            redact: redactLabel,
            onRecord: (record) => {
                ctx.records.push(record);
                const why = record.error ? ` (${record.code}: ${record.error})` : record.reason ? ` (${record.reason})` : '';
                progress(`step ${record.id} ${record.key}: ${record.status}${why}`);
            },
        });
        Object.assign(result, summarize(records, options.steps));
        outsideSteps.push(...unhandled.splice(0));
        if (outsideSteps.length > 0) {
            result.ok = false;
            result.unhandled = outsideSteps;
            result.error = MESSAGE;
            result.detail = `unhandled rejections outside the steps: ${outsideSteps.join('; ').slice(0, 1000)}`;
        }
    } catch (error) {
        result.error = MESSAGE;
        result.detail = redactLabel(error.message);
    } finally {
        if (ctx && !result.ok) {
            await collectDiagnostics(ctx);
        }
        if (ctx) {
            await closeCdp(ctx).catch(() => {});
            await closeBrowser(ctx).catch(() => {});
        }
        await adb.removeAllRules().catch(() => {});
        if (fixtures) {
            await fixtures.close().catch(() => {});
        }
        process.off('unhandledRejection', onUnhandled);
    }
    result.records = records;
    fs.writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(result, null, 4)}\n`);
    const lines = runSummary(records, result.detail);
    fs.writeFileSync(path.join(out, 'summary.md'), `${lines.join('\n')}\n`);
    if (options.summary) {
        appendSummary(options.summary, [`API ${result.sdk ?? '?'} (${options.serial})`, '', ...lines, '']);
    }
    print({ ok: result.ok, out, passed: result.passed, failed: result.failed, notRun: result.notRun, ...(result.detail ? { error: MESSAGE, detail: result.detail } : {}) });
    if (!result.ok) {
        process.exitCode = 1;
    }
}

const COMMANDS = Object.freeze({
    guard: commandGuard,
    'gradle-args': commandGradleArgs,
    'apk-check': commandApkCheck,
    preflight: commandPreflight,
    probe: commandProbe,
    run: commandRun,
    steps: async () => print({ ok: true, steps: STEPS }),
});

/**
 * Runs the CLI.
 * @param {string[]} argv Arguments after the script path.
 * @returns {Promise<void>}
 */
export async function main(argv) {
    const [command, ...args] = argv;
    try {
        const { values } = parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false });
        if (values.help || command === 'help' || command === undefined) {
            process.stdout.write(`${MESSAGE}\n`);
            return;
        }
        const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
        if (!handler) {
            throw new UsageError('unknown-command', { value: command });
        }
        await handler(values);
    } catch (error) {
        if (error instanceof UsageError) {
            print({ ok: false, error: MESSAGE, code: error.code, ...error.details });
            process.exitCode = 2;
        } else if (String(error?.code ?? '').startsWith('ERR_PARSE_ARGS')) {
            print({ ok: false, error: MESSAGE, code: 'invalid-arguments' });
            process.exitCode = 2;
        } else {
            print({ ok: false, error: MESSAGE, code: 'failed', detail: String(error?.message ?? error) });
            process.exitCode = 1;
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await main(process.argv.slice(2));
}
