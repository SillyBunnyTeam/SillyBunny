/**
 * The fourteen end-user steps of the Android smoke (plan §7.1), as the entry point (`run-smoke.js run`)
 * drives them on one emulator: native screens and system dialogs through the UiAutomator smoke tests
 * (`android/app/src/androidTest/.../smoke/SmokeUiTest.kt`), the web UI through Playwright over CDP, the
 * server through `adb forward` with a handoff code from the debug-only hook
 * (`android/app/src/debug/.../smoke/SmokeHookProvider.kt`), and the app's files through `run-as`.
 *
 * Fixtures run on the host (track p61) and reach the guest through `adb reverse`: the test APK is built
 * once with fixed guest ports (`GUEST_PORTS`, smoke-config.js), and each run maps them to the fixtures' random host
 * ports. Every step leaves the app running for the next one, or says why it cannot.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isAppCrash, notificationPosted, parseCrashLog, parsePackageVersion, parseProcesses, parseWebViewPackage, shellQuote } from './adb.js';
import { attachWebView, attachWebViewPage, findAppPage, forwardToDevice, redactLabel } from './cdp.js';
import { checksumTree, compareChecksums, dataFixtureFiles } from './data-fixture.js';
import { runGit } from './git.js';
import { MOCK_MODEL_ID, MOCK_REPLY } from './mock-llm.js';
import { EXTENSION_SECOND_BRANCH, PLUGIN_ID, publishPending, pushMarkerCommit, raiseMinAppVersion, readRefs } from './repos.js';
import {
    BLOCKED_STATUS_FILE,
    bunEntries,
    CHECKOUT_DIR,
    DATA_DIR,
    DEFAULT_PACKAGE,
    guestUrls,
    MAIN_ACTIVITY,
    SERVER_LOG_FILE,
    setConfigFlag,
    resolveHead,
    SMOKE_TEST_CLASS,
    UPDATE_REPLACED_NOTIFICATION,
    WEB_VERSION_WARNING_TAG,
    WEBVIEW_MINIMUM_MAJOR,
    zipEntryNames,
} from './smoke-config.js';
import { dataSafetyVerdict, StepError, STEPS } from './smoke-runner.js';
import { writeUpdateFixture } from './update-manifest.js';
import { testSetup } from '../frontend/frontent-test-utils.js';

/**
 * Creates the shared context the steps work in.
 * @param {object} options Options.
 * @returns {object} Context.
 */
export function createContext({ adb, pkg = DEFAULT_PACKAGE, options, fixtures, facts, out, log = () => {} }) {
    return {
        adb,
        pkg,
        testPkg: `${pkg}.test`,
        options,
        fixtures,
        facts,
        out,
        log,
        state: { noRestart: false, baseline: null, seeded: [], cdp: null, serverPort: null, pid: null, crashKeys: null },
        records: [],
    };
}

/* ---------- device helpers ---------- */

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
        reject(signal.reason);
        return;
    }
    const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
    }, ms);
    const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
});

/** An error that ends an {@link eventually} wait at once instead of being retried. */
function fatal(code, detail) {
    const error = new StepError(code, detail);
    error.fatal = true;
    return error;
}

async function eventually(check, { timeoutMs, intervalMs = 2_000, signal, code, detail }) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        signal?.throwIfAborted();
        try {
            const value = await check();
            if (value) {
                return value;
            }
        } catch (error) {
            if (error?.fatal || signal?.aborted) {
                throw error;
            }
            last = error;
        }
        await sleep(intervalMs, signal);
    }
    throw new StepError(code, `${detail}${last ? ` (last error: ${last.message})` : ''}`);
}

/** Starts MainActivity like the launcher does and waits until it is drawn. */
export async function launchApp(ctx, signal) {
    const output = await ctx.adb.shellText(['am', 'start', '-W', '-n', `${ctx.pkg}/${MAIN_ACTIVITY}`,
        '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER'], { signal });
    if (!/Status: ok/.test(output)) {
        throw new StepError('launch-failed', `am start: ${output.slice(-300)}`);
    }
    const total = /TotalTime: (\d+)/.exec(output);
    return { totalTimeMs: total ? Number(total[1]) : null };
}

export async function forceStop(ctx, signal) {
    await ctx.adb.shell(['am', 'force-stop', ctx.pkg], { signal });
    await closeCdp(ctx);
}

/** The app's current pid, waiting for the process to exist. */
export async function waitForPid(ctx, { timeoutMs = 60_000, signal } = {}) {
    const pid = await eventually(() => ctx.adb.pidof(ctx.pkg, { signal }), {
        timeoutMs, intervalMs: 500, signal, code: 'no-app-process', detail: `${ctx.pkg} has no process`,
    });
    ctx.state.pid = pid;
    return pid;
}

/**
 * The app's crashes that the crash log buffer got since the previous call. The buffer keeps the crashes from before
 * the run until the device restarts, so the first call only notes them and gives none.
 */
export async function newAppCrashes(ctx, signal) {
    const crashes = parseCrashLog(await ctx.adb.crashLog({ signal })).filter(crash => isAppCrash(crash, ctx.pkg));
    const key = crash => `${crash.kind} ${crash.time} ${crash.pid}`;
    const seen = ctx.state.crashKeys;
    ctx.state.crashKeys = new Set([...(seen ?? []), ...crashes.map(key)]);
    return seen ? crashes.filter(crash => !seen.has(key(crash))) : [];
}

/** The hook's view of the server (`state`, `port` when running). */
export function serverState(ctx, signal) {
    return ctx.adb.hook(ctx.pkg, 'state', { signal, timeoutMs: 30_000 });
}

/**
 * Waits until the server is Running and returns the hook's reply. Failed ends the wait at once.
 * @param {object} ctx Context.
 * @param {object} [options] Options.
 * @param {number} [options.timeoutMs] Deadline.
 * @param {AbortSignal} [options.signal] Abort signal.
 * @param {(reply: object) => boolean} [options.accept] Extra condition on a Running reply.
 */
export async function waitForServer(ctx, { timeoutMs = 10 * 60_000, signal, accept = () => true } = {}) {
    const reply = await eventually(async () => {
        const state = await serverState(ctx, signal);
        if (state.state === 'Failed') {
            throw fatal('server-failed', `the server gave up: ${JSON.stringify(state).slice(0, 300)}`);
        }
        return state.state === 'Running' && accept(state) ? state : null;
    }, { timeoutMs, intervalMs: 2_000, signal, code: 'server-not-running', detail: 'the server did not reach Running' });
    ctx.state.serverPort = reply.port;
    return reply;
}

/** Waits for a given server state name (for example Failed). */
export function waitForServerState(ctx, name, { timeoutMs = 5 * 60_000, signal } = {}) {
    return eventually(async () => {
        const state = await serverState(ctx, signal);
        return state.state === name ? state : null;
    }, { timeoutMs, signal, code: 'server-state', detail: `the server never reached ${name}` });
}

/** A tiny cookie jar for host requests through `adb forward`. */
export class CookieJar {
    constructor() {
        this.cookies = new Map();
    }

    /** @param {Headers} headers Response headers. */
    store(headers) {
        const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
        for (const value of values) {
            const pair = /^\s*([^=;\s]+)=([^;]*)/.exec(value);
            if (pair) {
                this.cookies.set(pair[1], pair[2]);
            }
        }
    }

    has(name) {
        return this.cookies.has(name);
    }

    header() {
        return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
}

/**
 * Opens a host-side client to the app's server: `adb forward` to the server port, plus a cookie jar.
 * @returns {Promise<{base: string, jar: CookieJar, request: (pathname: string, init?: RequestInit) => Promise<Response>, close: () => Promise<void>}>}
 */
export async function openServerClient(ctx, port) {
    const hostPort = await forwardToDevice(ctx.adb, `tcp:${port}`);
    const base = `http://127.0.0.1:${hostPort}`;
    const jar = new CookieJar();
    return {
        base,
        jar,
        request: async (pathname, init = {}) => {
            const headers = new Headers(init.headers);
            if (jar.cookies.size > 0) {
                headers.set('cookie', jar.header());
            }
            const response = await fetch(`${base}${pathname}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000), ...init, headers });
            jar.store(response.headers);
            return response;
        },
        close: () => ctx.adb.removeForward(hostPort),
    };
}

/** Redeems a handoff code from the debug hook; the jar then holds the launch cookie. */
export async function redeemHandoff(ctx, client, signal) {
    const reply = await ctx.adb.hook(ctx.pkg, 'handoff', { signal, timeoutMs: 30_000 });
    if (!reply.code || !reply.path) {
        throw new StepError('no-handoff', `the hook gave no handoff code: ${JSON.stringify(reply).slice(0, 200)}`);
    }
    const target = `${reply.path}?c=${encodeURIComponent(reply.code)}`;
    const response = await client.request(target);
    return { target, status: response.status, cookie: client.jar.has('sillybunny_launch') };
}

async function checkHealth(ctx, port, signal) {
    const client = await openServerClient(ctx, port);
    try {
        const handoff = await redeemHandoff(ctx, client, signal);
        if (handoff.status !== 200 || !handoff.cookie) {
            throw new StepError('handoff-failed', `handoff answered ${handoff.status}, cookie ${handoff.cookie}`);
        }
        const health = await client.request('/__sillybunny/health');
        if (health.status !== 204) {
            throw new StepError('unhealthy', `health answered ${health.status}`);
        }
        return { health: health.status };
    } finally {
        await client.close();
    }
}

/** Whether a path exists in the app's data directory. */
export async function appPathExists(ctx, relative, signal) {
    // Through sh, because API 29 has `test` only as a shell builtin, which run-as cannot start.
    const result = await ctx.adb.runAs(ctx.pkg, ['sh', '-c', `test -e ${shellQuote(relative)}`], { check: false, signal, timeoutMs: 30_000 });
    return result.code === 0;
}

async function appText(ctx, relative, signal) {
    const contents = await ctx.adb.readAppFile(ctx.pkg, relative, { signal, timeoutMs: 60_000 });
    return contents === null ? null : contents.toString('utf8');
}

/** The checkout's HEAD branch and commit. */
export async function checkoutHead(ctx, signal) {
    const git = `${CHECKOUT_DIR}/.git`;
    const head = await appText(ctx, `${git}/HEAD`, signal);
    const ref = /^ref: (\S+)/.exec(String(head ?? '').trim());
    const loose = ref ? await appText(ctx, `${git}/${ref[1]}`, signal) : null;
    const packedRefs = loose ? null : await appText(ctx, `${git}/packed-refs`, signal);
    return resolveHead({ head, looseRef: () => loose, packedRefs });
}

async function setWifi(ctx, enabled, signal) {
    const modern = await ctx.adb.shell(['cmd', 'wifi', 'set-wifi-enabled', enabled ? 'enabled' : 'disabled'], { check: false, signal });
    if (modern.code !== 0) {
        await ctx.adb.shell(['svc', 'wifi', enabled ? 'enable' : 'disable'], { signal });
    }
    if (!enabled) {
        await ctx.adb.shell(['svc', 'data', 'enable'], { check: false, signal });
    }
}

/**
 * Runs one UiAutomator smoke test method. With `--no-restart` (where `am instrument` has it) the app keeps
 * running across the call; otherwise Android stops the app before and after the test.
 */
export async function runUi(ctx, method, args = {}, { timeoutMs = 10 * 60_000, signal, allowCrash = false } = {}) {
    const result = await ctx.adb.instrument({
        testPackage: ctx.testPkg,
        testClass: SMOKE_TEST_CLASS,
        method,
        // SmokeUiTest skips itself without smokeRun, so an ordinary androidTest run never drives these flows.
        args: { ...args, smokeRun: 'true' },
        noRestart: ctx.state.noRestart,
        timeoutMs,
        signal,
    });
    fs.mkdirSync(ctx.out, { recursive: true });
    fs.writeFileSync(path.join(ctx.out, `instrument-${method}-${Date.now()}.txt`), result.raw);
    if (result.ok || (allowCrash && result.crashed)) {
        if (!ctx.state.noRestart || result.crashed) {
            await closeCdp(ctx);
        }
        return result;
    }
    const failure = result.tests.find(test => test.status !== 'passed');
    const why = failure
        ? `${failure.status}: ${String(failure.stack ?? '').split('\n')[0]}`
        : result.failedToStart ?? result.shortMsg ?? `instrumentation code ${result.code}`;
    throw new StepError('ui-test-failed', `${method} ${why}`);
}

/** Ends the page sessions: the CDP connection to the WebView, and the host browser's context and port rule. */
export async function closeCdp(ctx) {
    const current = ctx.state.cdp;
    const browser = ctx.state.browser;
    ctx.state.cdp = null;
    ctx.state.browser = null;
    if (current) {
        await current.connection.close();
    }
    if (browser) {
        await browser.context.close().catch(() => {});
        await ctx.adb.removeForward(browser.hostPort);
    }
}

/** Closes the host browser that {@link browserPage} started, after {@link closeCdp}. */
export async function closeBrowser(ctx) {
    const instance = ctx.state.browserInstance;
    ctx.state.browserInstance = null;
    if (instance) {
        await instance.close().catch(() => {});
    }
}

/**
 * The WebView page on the app origin, attached over CDP (no readiness wait). Reattaches after the app
 * process or the server port changed.
 */
export async function attachAppPage(ctx, signal) {
    const port = ctx.state.serverPort ?? (await waitForServer(ctx, { signal })).port;
    const pid = await waitForPid(ctx, { signal });
    if (ctx.state.cdp && ctx.state.cdp.pid === pid && ctx.state.cdp.port === port && !ctx.state.cdp.page.isClosed()) {
        return ctx.state.cdp.page;
    }
    await closeCdp(ctx);
    if (!(await webViewInfo(ctx, signal)).frontend) {
        // Playwright lists no pages of such an old WebView, and the steps only read from it (see webPage).
        const connection = await attachWebViewPage({ adb: ctx.adb, pid, serverPort: port, signal, timeoutMs: 120_000 });
        connection.page.setDefaultTimeout(120_000);
        ctx.state.cdp = { pid, port, connection, page: connection.page, settled: false };
        return connection.page;
    }
    const connection = await attachWebView({ adb: ctx.adb, pid, signal });
    try {
        const page = await findAppPage(connection.browser, port, { signal, timeoutMs: 120_000 });
        page.setDefaultTimeout(120_000);
        ctx.state.cdp = { pid, port, connection, page, settled: false };
        return page;
    } catch (error) {
        await connection.close();
        throw error;
    }
}

/**
 * The system WebView, and whether it runs the frontend (major version at least {@link WEBVIEW_MINIMUM_MAJOR}).
 * An unreadable provider counts as able, so the WebView steps then fail on their own evidence.
 */
export async function webViewInfo(ctx, signal) {
    if (!ctx.state.webView) {
        const dump = await ctx.adb.shellText(['dumpsys', 'webviewupdate'], { check: false, signal, timeoutMs: 60_000 });
        const current = parseWebViewPackage(dump);
        ctx.state.webView = { ...(current ?? { package: null, version: null, major: null }),
            frontend: current?.major == null || current.major >= WEBVIEW_MINIMUM_MAJOR };
    }
    return ctx.state.webView;
}

/**
 * The app's frontend in a host browser, as the app's Open in browser offers it where the WebView cannot run the
 * frontend: `adb forward` to the server port, then a handoff code from the debug hook opens the launch cookie.
 * A new app process, a new port or a refused health check (a new run has a new token) starts a new session.
 */
export async function browserPage(ctx, signal) {
    const server = await waitForServer(ctx, { signal });
    const pid = await waitForPid(ctx, { signal });
    const current = ctx.state.browser;
    if (current && current.pid === pid && current.port === server.port && !current.page.isClosed()) {
        const health = await current.page.evaluate(async () => (await fetch('/__sillybunny/health')).status).catch(() => 0);
        if (health === 204) {
            return current.page;
        }
    }
    await closeCdp(ctx);
    if (!ctx.state.browserInstance) {
        const { chromium } = await import('@playwright/test');
        ctx.state.browserInstance = await chromium.launch({ headless: true });
    }
    const hostPort = await forwardToDevice(ctx.adb, `tcp:${server.port}`);
    let context = null;
    let page;
    try {
        context = await ctx.state.browserInstance.newContext();
        page = await context.newPage();
    } catch (error) {
        await context?.close().catch(() => {});
        await ctx.adb.removeForward(hostPort).catch(() => {});
        throw error;
    }
    page.setDefaultTimeout(120_000);
    // Stored only with its page: the reuse check above reads the page of a stored session.
    ctx.state.browser = { pid, port: server.port, hostPort, context, page, settled: false };
    const handoff = await ctx.adb.hook(ctx.pkg, 'handoff', { signal, timeoutMs: 30_000 });
    if (!handoff.code || !handoff.path) {
        throw new StepError('no-handoff', `the hook gave no handoff code: ${JSON.stringify(redactHandoffReply(handoff))}`);
    }
    await page.goto(`http://127.0.0.1:${hostPort}${handoff.path}?c=${encodeURIComponent(handoff.code)}`);
    // The handoff page sets the cookie and moves on to / (or /login with user accounts on).
    await page.waitForURL(url => url.pathname !== handoff.path, { timeout: 60_000 });
    return page;
}

function redactHandoffReply(reply) {
    return typeof reply?.code === 'string' ? { ...reply, code: `<${reply.code.length} characters>` } : reply;
}

/** The page the web steps drive: the WebView, or the host browser where the WebView cannot run the frontend. */
async function webPage(ctx, signal) {
    return (await webViewInfo(ctx, signal)).frontend ? attachAppPage(ctx, signal) : browserPage(ctx, signal);
}

/** Test input for the persona name the frontend's onboarding prompt asks for. */
const PERSONA_NAME = 'TODO(copy)';
/** Polls in a row with the frontend booted and no prompt to answer. */
const SETTLED_POLLS = 5;

/**
 * One look at the frontend's startup, run in the page. It answers the topmost startup prompt the way a user
 * would and reports what it did: the onboarding prompt gets a persona name, any other popup dialog is cancelled
 * (for example Quick Image Gen's offer to import settings a killed earlier boot left in the browser's storage),
 * and Quick Image Gen's setup wizard is skipped. These prompts stack in no fixed order, and a modal popup over
 * the wizard blocks a pointer click on Skip, so the answers are DOM clicks.
 */
async function frontendStartupStep(name) {
    const state = { preloader: document.getElementById('preloader') !== null, ready: false, acted: null };
    try {
        const { eventSource, event_types } = await import('/scripts/events.js');
        state.ready = eventSource.autoFireLastArgs.has(event_types.APP_READY);
    } catch {
        // The module graph is not loaded yet.
    }
    const shown = element => element !== null && element.getClientRects().length > 0;
    const onboarding = document.querySelector('dialog[open] .onboarding')?.closest('dialog') ?? null;
    if (onboarding) {
        const input = onboarding.querySelector('.popup-input');
        if (input) {
            input.value = name;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        onboarding.querySelector('.popup-button-ok')?.click();
        state.acted = 'onboarding';
        return state;
    }
    const popup = [...document.querySelectorAll('dialog.popup[open]')].pop() ?? null;
    if (popup) {
        const cancel = popup.querySelector('.popup-button-cancel');
        (shown(cancel) ? cancel : popup.querySelector('.popup-button-ok'))?.click();
        state.acted = 'popup';
        return state;
    }
    const wizard = document.getElementById('qig-setup-wizard');
    if (wizard !== null && wizard.style.display !== 'none') {
        document.getElementById('qig-wizard-skip')?.click();
        state.acted = 'wizard';
    }
    return state;
}

/**
 * Waits until the frontend has booted (no preloader, APP_READY) and stays free of startup prompts for
 * {@link SETTLED_POLLS} polls in a row, answering the prompts on the way (see {@link frontendStartupStep}).
 * A failed evaluation (the page navigating, for example) counts as not settled.
 * @returns {Promise<{answered: string[]}>} The prompts it answered, in order.
 */
export async function settleFrontend(page, { signal, timeoutMs = 300_000, intervalMs = 1_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const answered = [];
    let quiet = 0;
    let last = null;
    while (Date.now() < deadline) {
        signal?.throwIfAborted();
        last = await page.evaluate(frontendStartupStep, PERSONA_NAME).catch(error => ({ error: error.message }));
        if (last.acted) {
            answered.push(last.acted);
        }
        quiet = last.ready && !last.preloader && !last.acted ? quiet + 1 : 0;
        if (quiet >= SETTLED_POLLS) {
            return { answered };
        }
        await sleep(intervalMs, signal);
    }
    throw new StepError('frontend-not-ready', `the frontend did not settle: ${JSON.stringify({ last, answered })}`);
}

/** The app's page with the frontend booted and its startup prompts answered, in the WebView or the host browser. */
export async function appPage(ctx, signal) {
    const page = await webPage(ctx, signal);
    const session = ctx.state.cdp?.page === page ? ctx.state.cdp : ctx.state.browser;
    if (!session.settled) {
        const settled = await settleFrontend(page, { signal });
        session.settled = true;
        session.answered = settled.answered;
    }
    return page;
}

/** Calls a server endpoint from the page, with the UI's own request headers (CSRF). */
async function pageRequest(page, pathname, body) {
    return page.evaluate(async ({ pathname, body }) => {
        const context = window.SillyTavern.getContext();
        const response = await fetch(pathname, { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify(body ?? {}) });
        const text = await response.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch {
            // Not JSON.
        }
        return { status: response.status, json, text: text.slice(0, 500) };
    }, { pathname, body });
}

/** Relaunches the app (stop, start) and waits for a running server. */
async function relaunch(ctx, signal) {
    await forceStop(ctx, signal);
    await launchApp(ctx, signal);
    return waitForServer(ctx, { signal });
}

/* ---------- data safety (step 14) ---------- */

/** Seeds p61's data fixture into the checkout's data/ and records the baseline. */
export async function seedData(ctx, signal) {
    const files = dataFixtureFiles();
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-smoke-seed-'));
    try {
        for (const [relative, contents] of Object.entries(files)) {
            const target = `${DATA_DIR}/${relative}`;
            await ctx.adb.runAs(ctx.pkg, ['mkdir', '-p', path.posix.dirname(target)], { signal });
            await ctx.adb.writeAppFile(ctx.pkg, target, contents, { signal });
            const file = path.join(local, ...relative.split('/'));
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, contents);
        }
        const seeded = Object.keys(files).sort();
        ctx.state.seeded = seeded;
        ctx.state.baseline = await checksumTree(local, { include: seeded });
        fs.writeFileSync(path.join(ctx.out, 'data-baseline.json'), `${JSON.stringify(ctx.state.baseline, null, 4)}\n`);
    } finally {
        fs.rmSync(local, { recursive: true, force: true });
    }
    const check = await checkDataSafety(ctx, signal);
    if (!check.ok) {
        throw new StepError('seed-failed', `the seeded files read back differently: ${JSON.stringify(check)}`);
    }
    return { files: ctx.state.seeded };
}

/**
 * Compares the seeded files on the device with the baseline. Null before the fixture is seeded.
 * @returns {Promise<{ok: boolean, changed: string[], removed: string[], digest: string}|null>} Result.
 */
export async function checkDataSafety(ctx, signal) {
    if (!ctx.state.baseline) {
        return null;
    }
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-smoke-check-'));
    try {
        for (const relative of ctx.state.seeded) {
            const contents = await ctx.adb.readAppFile(ctx.pkg, `${DATA_DIR}/${relative}`, { signal, timeoutMs: 60_000 });
            if (contents !== null) {
                const file = path.join(local, ...relative.split('/'));
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, contents);
            }
        }
        const current = await checksumTree(local, { include: ctx.state.seeded });
        const comparison = compareChecksums(ctx.state.baseline, current, { allowAdded: [] });
        return { ok: comparison.ok, changed: comparison.changed, removed: comparison.removed, digest: current.digest };
    } finally {
        fs.rmSync(local, { recursive: true, force: true });
    }
}

/* ---------- the steps ---------- */

async function stepFirstRun(ctx, signal) {
    const { adb, pkg, testPkg, options } = ctx;
    await adb.uninstall(testPkg, { signal });
    await adb.uninstall(pkg, { signal });
    await adb.install(options.apk, { signal });
    await adb.install(options.testApk, { signal });
    const installed = parsePackageVersion(await adb.shellText(['dumpsys', 'package', pkg], { signal }));
    if (installed.versionCode !== ctx.facts.versionCode) {
        throw new StepError('wrong-version', `installed versionCode ${installed.versionCode}, expected ${ctx.facts.versionCode}`);
    }
    ctx.state.installedVersionCode = installed.versionCode;

    // The metered-network warning path: with Wi-Fi off, the emulator's only network is cellular.
    const started = Date.now();
    await setWifi(ctx, false, signal);
    try {
        await runUi(ctx, 'firstRun', { expectMetered: 'true', timeoutSeconds: 40 * 60 }, { timeoutMs: 42 * 60_000, signal });
    } finally {
        await setWifi(ctx, true).catch(() => {});
    }
    const firstRunMs = Date.now() - started;

    const head = await checkoutHead(ctx, signal);
    const expected = ctx.fixtures.remoteHeads()[options.defaultRef];
    if (head.branch !== options.defaultRef || head.commit !== expected) {
        throw new StepError('wrong-checkout', `checkout ${head.branch}@${head.commit}, expected ${options.defaultRef}@${expected}`);
    }
    for (const required of ['node_modules', 'config.yaml', 'data/default-user']) {
        if (!(await appPathExists(ctx, `${CHECKOUT_DIR}/${required}`, signal))) {
            throw new StepError('incomplete-install', `${CHECKOUT_DIR}/${required} is missing`);
        }
    }
    const seeded = await seedData(ctx, signal);
    return { versionCode: installed.versionCode, checkout: head.commit, firstRunMs, seeded: seeded.files.length };
}

/** SillyBunny's own page is in the document; ES5, because old WebViews that cannot run the frontend evaluate it. */
const PAGE_LOADED = 'document.title === "SillyBunny" && document.getElementById("send_textarea") !== null';

/** Resource ids on screen, from `uiautomator dump`; debug builds expose Compose test tags as resource ids. */
export async function windowResourceIds(ctx, signal) {
    const file = '/data/local/tmp/sillybunny-smoke-window.xml';
    const script = `uiautomator dump ${file} > /dev/null && cat ${file}; rm -f ${file}`;
    const xml = await eventually(async () => {
        const result = await ctx.adb.shell(['sh', '-c', script], { check: false, signal, timeoutMs: 60_000 });
        return String(result.stdout).includes('<hierarchy') ? String(result.stdout) : null;
    }, { timeoutMs: 90_000, intervalMs: 3_000, signal, code: 'no-window-dump', detail: 'uiautomator dump gave no hierarchy' });
    return [...xml.matchAll(/resource-id="([^"]+)"/g)].map(match => match[1]);
}

async function stepServerWebView(ctx, signal) {
    const started = Date.now();
    const launch = await launchApp(ctx, signal);
    const server = await waitForServer(ctx, { signal });
    const runningMs = Date.now() - started;
    const pid = await waitForPid(ctx, { signal });
    await checkHealth(ctx, server.port, signal);
    const webView = await webViewInfo(ctx, signal);
    // The server serves the app's own page only with the launch cookie, so this shows the WebView has it.
    const loaded = await attachAppPage(ctx, signal);
    await loaded.waitForFunction(PAGE_LOADED, null, { timeout: 300_000 });
    const details = {
        launchTotalTimeMs: launch.totalTimeMs,
        runningMs,
        loadedMs: Date.now() - started,
        port: server.port,
        pid,
        origin: redactLabel(new URL(loaded.url()).origin),
        webView: `${webView.package} ${webView.version}`,
    };
    if (webView.frontend) {
        await appPage(ctx, signal);
        return { ...details, readyMs: Date.now() - started, frontend: 'webview', answered: ctx.state.cdp.answered };
    }
    // Below the frontend's minimum the app shows its version warning, which offers Open in browser; the host
    // browser takes that role for the web steps.
    const ids = await windowResourceIds(ctx, signal);
    if (!ids.includes(WEB_VERSION_WARNING_TAG)) {
        throw new StepError('no-version-warning', `WebView ${webView.version} is too old, but ${WEB_VERSION_WARNING_TAG} is not on screen`);
    }
    await appPage(ctx, signal);
    return { ...details, readyMs: Date.now() - started, frontend: 'browser', answered: ctx.state.browser.answered };
}

async function stepChat(ctx, signal) {
    const page = await appPage(ctx, signal);
    const llmLog = ctx.fixtures.info.services.llm.log;
    const before = fs.existsSync(llmLog) ? fs.readFileSync(llmLog, 'utf8').split('\n').filter(Boolean).length : 0;
    await page.evaluate(({ url, model }) => {
        const $ = window.jQuery;
        $('#main_api').val('openai').trigger('change');
        $('#chat_completion_source').val('custom').trigger('change');
        $('#custom_api_url_text').val(url).trigger('input');
        $('#custom_model_id').val(model).trigger('input');
        $('#stream_toggle').prop('checked', true).trigger('change');
        $('#api_button_openai').trigger('click');
    }, { url: ctx.fixtures.urls.llmBase, model: MOCK_MODEL_ID });
    await page.waitForFunction(() => window.SillyTavern.getContext().onlineStatus !== 'no_connection', null, { timeout: 60_000 });

    // A sample character (never the seeded one, whose chat must stay unchanged) in a new chat.
    const selected = await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        const id = context.characters.findIndex(character => character && character.avatar !== 'smoke-fixture.png');
        if (id < 0) {
            return false;
        }
        await context.selectCharacterById(id, { switchMenu: false });
        return true;
    });
    if (!selected) {
        throw new StepError('no-character', 'no sample character to chat with');
    }
    // A late startup prompt would sit over the send button.
    await settleFrontend(page, { signal, timeoutMs: 120_000 });
    await page.evaluate(() => {
        const textarea = document.getElementById('send_textarea');
        textarea.value = 'TODO(copy)';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('#send_but').click();
    await page.waitForFunction((reply) => {
        const replies = [...document.querySelectorAll('#chat .mes[is_user="false"] .mes_text')];
        return replies.length > 0 && replies[replies.length - 1].textContent.includes(reply);
    }, MOCK_REPLY, { timeout: 120_000 });
    // The mock logs a request when its response ends, which can be after the UI shows the streamed text.
    const requests = () => fs.readFileSync(llmLog, 'utf8').split('\n').filter(Boolean).slice(before).map(line => JSON.parse(line));
    const streamed = await eventually(
        () => requests().find(entry => entry.path?.endsWith('/chat/completions') && entry.stream === true && entry.status === 200),
        { timeoutMs: 30_000, intervalMs: 500, signal, code: 'not-streamed', detail: 'the mock backend saw no streaming chat request' },
    );
    return { model: streamed.model, requests: requests().length };
}

async function stepGitUpdate(ctx, signal) {
    const before = await checkoutHead(ctx, signal);
    const pushed = pushMarkerCommit({ repo: ctx.fixtures.remotePath(), branch: ctx.options.defaultRef });
    await relaunch(ctx, signal);
    const after = await checkoutHead(ctx, signal);
    if (after.commit !== pushed.commit) {
        throw new StepError('not-updated', `HEAD ${after.commit}, expected the pushed ${pushed.commit} (was ${before.commit})`);
    }
    if (!(await appPathExists(ctx, `${CHECKOUT_DIR}/${pushed.marker}`, signal))) {
        throw new StepError('not-updated', `${pushed.marker} is missing from the checkout`);
    }
    const server = await waitForServer(ctx, { signal });
    await checkHealth(ctx, server.port, signal);
    return { from: before.commit, to: after.commit };
}

async function stepMinAppVersion(ctx, signal) {
    const before = await checkoutHead(ctx, signal);
    const raised = raiseMinAppVersion({ repo: ctx.fixtures.remotePath(), branch: ctx.options.defaultRef, above: ctx.state.installedVersionCode });
    await relaunch(ctx, signal);
    const after = await checkoutHead(ctx, signal);
    if (after.commit !== before.commit) {
        throw new StepError('gate-bypassed', `the pull was not skipped: HEAD moved to ${after.commit}`);
    }
    const blocked = await appText(ctx, BLOCKED_STATUS_FILE, signal);
    if (!blocked) {
        throw new StepError('no-blocked-status', `${BLOCKED_STATUS_FILE} was not written`);
    }
    await runUi(ctx, 'expectUpdatePrompt', { timeoutSeconds: 120 }, { timeoutMs: 5 * 60_000, signal });
    if (!ctx.state.noRestart) {
        await launchApp(ctx, signal);
    }
    const server = await waitForServer(ctx, { signal });
    await checkHealth(ctx, server.port, signal);

    // The same gate through the Server Tools update endpoint.
    const page = await appPage(ctx, signal);
    const update = await pageRequest(page, '/api/server-admin/update', {});
    if (update.status !== 409 || update.json?.code !== 'android_app_update_required') {
        throw new StepError('endpoint-not-gated', `/api/server-admin/update answered ${update.status}: ${update.text}`);
    }
    const still = await checkoutHead(ctx, signal);
    if (still.commit !== before.commit) {
        throw new StepError('gate-bypassed', `the endpoint moved HEAD to ${still.commit}`);
    }
    return { required: raised.minAppVersion, blockedCommit: raised.commit, head: before.commit };
}

async function stepApkSelfUpdate(ctx, signal) {
    if (!ctx.options.updateApk) {
        throw new StepError('no-update-apk', 'step 6 needs --update-apk (versionCode + 1, same debug key)');
    }
    const versionCode = ctx.state.installedVersionCode + 1;
    await writeUpdateFixture({
        dir: ctx.fixtures.info.services.update.root,
        apks: { x86_64: ctx.options.updateApk },
        versionCode,
        versionName: ctx.facts.versionName,
        releaseTag: `android-smoke-${versionCode}`,
        prerelease: false,
        defaultRef: ctx.options.defaultRef,
        runtime: ctx.facts.runtime,
        baseUrl: ctx.fixtures.urls.updateBase,
    });
    // The "install unknown apps" approval is a Settings screen, not the system installer this step drives.
    await ctx.adb.shell(['appops', 'set', ctx.pkg, 'REQUEST_INSTALL_PACKAGES', 'allow'], { signal });
    // Installing the update kills the app process, and the instrumentation with it.
    await runUi(ctx, 'acceptAppUpdate', { openSettingsTag: ctx.options.uiTags.openSettings, timeoutSeconds: 600 },
        { timeoutMs: 12 * 60_000, signal, allowCrash: true });
    await closeCdp(ctx);
    const updated = await eventually(async () => {
        const version = parsePackageVersion(await ctx.adb.shellText(['dumpsys', 'package', ctx.pkg], { signal }));
        return version.versionCode === versionCode ? version : null;
    }, { timeoutMs: 5 * 60_000, signal, code: 'not-updated', detail: `versionCode never became ${versionCode}` });
    ctx.state.installedVersionCode = updated.versionCode;
    const { id, channel } = UPDATE_REPLACED_NOTIFICATION;
    await eventually(async () => {
        const notifications = await ctx.adb.shellText(['dumpsys', 'notification', '--noredact'], { signal });
        return notificationPosted(notifications, { pkg: ctx.pkg, id, channel });
    }, { timeoutMs: 60_000, signal, code: 'no-update-notification', detail: `notification ${id} on channel ${channel} was not posted` });
    await launchApp(ctx, signal);
    const server = await waitForServer(ctx, { signal });
    await checkHealth(ctx, server.port, signal);
    return { versionCode: updated.versionCode };
}

/**
 * The `/api/extensions/branches` entry for the remote copy of `branch`, which is the name the UI sends to
 * `/api/extensions/switch`. The install clones with depth 1, so only its own branch exists locally, and
 * the switch creates a local branch only from an `origin/` name.
 * @param {unknown} branches Reply body.
 * @param {string} branch Branch name without the remote.
 * @returns {{name: string}|null} Entry.
 */
export function remoteBranchEntry(branches, branch) {
    return Array.isArray(branches) ? branches.find(entry => entry?.name === `origin/${branch}`) ?? null : null;
}

async function stepExtension(ctx, signal) {
    const page = await appPage(ctx, signal);
    const repo = ctx.fixtures.repoInfo('extension');
    const install = await pageRequest(page, '/api/extensions/install', { url: ctx.fixtures.urls.extension, global: false });
    if (install.status !== 200 || !install.json?.folderName) {
        throw new StepError('install-failed', `install answered ${install.status}: ${install.text}`);
    }
    const name = install.json.folderName;
    const version = () => pageRequest(page, '/api/extensions/version', { extensionName: name, global: false });
    const installed = await version();
    if (installed.json?.currentCommitHash !== repo.commits.initial) {
        throw new StepError('wrong-revision', `installed ${installed.json?.currentCommitHash}, expected ${repo.commits.initial}`);
    }
    const published = publishPending({ repo: repo.path });
    const pending = await version();
    if (pending.json?.isUpToDate !== false) {
        throw new StepError('no-update-seen', `the published commit was not seen: ${pending.text}`);
    }
    const update = await pageRequest(page, '/api/extensions/update', { extensionName: name, global: false });
    const updated = await version();
    if (update.status !== 200 || updated.json?.currentCommitHash !== published.commit) {
        throw new StepError('update-failed', `update answered ${update.status}; HEAD ${updated.json?.currentCommitHash}, expected ${published.commit}`);
    }
    const branches = await pageRequest(page, '/api/extensions/branches', { extensionName: name, global: false });
    const remote = remoteBranchEntry(branches.json, EXTENSION_SECOND_BRANCH);
    if (branches.status !== 200 || !remote) {
        throw new StepError('no-branch', `branches answered ${branches.status}: ${branches.text}`);
    }
    const switched = await pageRequest(page, '/api/extensions/switch', { extensionName: name, branch: remote.name, global: false });
    const onNext = await version();
    if (switched.status !== 204 || onNext.json?.currentBranchName !== EXTENSION_SECOND_BRANCH || onNext.json?.currentCommitHash !== repo.commits.next) {
        throw new StepError('switch-failed', `switch answered ${switched.status}; now ${onNext.json?.currentBranchName}@${onNext.json?.currentCommitHash}`);
    }
    // The UI loads the extension revision it now has.
    await page.reload();
    await settleFrontend(page, { signal });
    const loaded = await page.evaluate(() => window.sillyBunnySmokeExtension ?? null);
    if (loaded?.branch !== EXTENSION_SECOND_BRANCH) {
        throw new StepError('not-loaded', `the UI loaded ${JSON.stringify(loaded)}`);
    }
    return { extension: name, installed: repo.commits.initial, updated: published.commit, switched: repo.commits.next };
}

function hostTar(directory, entry) {
    return new Promise((resolve, reject) => {
        const child = spawn('tar', ['--format', 'ustar', '-cf', '-', '-C', directory, entry], { windowsHide: true });
        const chunks = [];
        let stderr = '';
        child.stdout.on('data', chunk => chunks.push(chunk));
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', code => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar exited ${code}: ${stderr}`))));
    });
}

async function pluginProbe(ctx, signal) {
    const server = await waitForServer(ctx, { signal });
    const client = await openServerClient(ctx, server.port);
    try {
        await redeemHandoff(ctx, client, signal);
        const response = await client.request(`/api/plugins/${PLUGIN_ID}/probe`);
        return response.status === 200 ? await response.json() : { status: response.status };
    } finally {
        await client.close();
    }
}

async function stepServerPlugin(ctx, signal) {
    // apply-release takes only https/ssh URLs without a port (p61 §6.1), so the plugin is cloned into
    // plugins/ with its origin on the fixture remote, and the startup update pulls the published commit.
    const repo = ctx.fixtures.repoInfo('plugin');
    const work = fs.mkdtempSync(path.join(ctx.fixtures.info.scratch, 'tmp', 'plugin-'));
    try {
        const clone = path.join(work, PLUGIN_ID);
        runGit(['clone', '--quiet', repo.path, clone]);
        runGit(['-C', clone, 'remote', 'set-url', 'origin', ctx.fixtures.urls.plugin]);
        await ctx.adb.untarIntoApp(ctx.pkg, `${CHECKOUT_DIR}/plugins`, await hostTar(work, PLUGIN_ID), { signal });
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
    const configPath = `${CHECKOUT_DIR}/config.yaml`;
    const config = await appText(ctx, configPath, signal);
    await ctx.adb.writeAppFile(ctx.pkg, configPath, setConfigFlag(config, 'enableServerPlugins', true), { signal });
    await relaunch(ctx, signal);
    const first = await pluginProbe(ctx, signal);
    if (first.version !== '1.0.0') {
        throw new StepError('plugin-not-loaded', `probe answered ${JSON.stringify(first)}`);
    }
    const published = publishPending({ repo: repo.path });
    await relaunch(ctx, signal);
    const second = await pluginProbe(ctx, signal);
    if (second.version !== '1.1.0') {
        throw new StepError('plugin-not-updated', `probe answered ${JSON.stringify(second)} after ${published.commit}`);
    }
    return { installed: first, updated: second };
}

async function stepTokenGate(ctx, signal) {
    const server = await waitForServer(ctx, { signal });
    const client = await openServerClient(ctx, server.port);
    const result = {};
    try {
        result.withoutCookie = (await client.request('/')).status;
        if (result.withoutCookie !== 403) {
            throw new StepError('gate-open', `/ without the cookie answered ${result.withoutCookie}`);
        }
        const handoff = await redeemHandoff(ctx, client, signal);
        result.handoff = handoff.status;
        const health = await client.request('/__sillybunny/health');
        result.health = health.status;
        const fresh = await openServerClient(ctx, server.port);
        try {
            result.replay = (await fresh.request(handoff.target)).status;
        } finally {
            await fresh.close();
        }
        if (result.handoff !== 200 || !handoff.cookie || result.health !== 204 || result.replay !== 403) {
            throw new StepError('handoff', `handoff ${result.handoff}, health ${result.health}, replay ${result.replay}`);
        }
    } finally {
        await client.close();
    }
    // The WebView's own request, with the cookie it holds; this needs no frontend, so old WebViews answer it too.
    const webView = await attachAppPage(ctx, signal);
    result.webView = await webView.evaluate(async () => (await fetch('/', { credentials: 'include' })).status);
    if (result.webView !== 200) {
        throw new StepError('webview-refused', `the WebView got ${result.webView}`);
    }

    // Login behind the gate with user accounts on, where the frontend runs (see webPage).
    const configPath = `${CHECKOUT_DIR}/config.yaml`;
    const config = await appText(ctx, configPath, signal);
    await ctx.adb.writeAppFile(ctx.pkg, configPath, setConfigFlag(config, 'enableUserAccounts', true), { signal });
    try {
        await relaunch(ctx, signal);
        const accountsPage = await webPage(ctx, signal);
        // The restart cache clear reloads the page twice after the relaunch, and a navigation during those reloads
        // can make WebView 133 (API 36) abort. So the login page opens only after the frontend booted.
        await settleFrontend(accountsPage, { signal });
        // A single user without a password is logged in automatically; `noauto` shows the login page anyway, so
        // the user picks the account there as on a multi-user install. The login page never fires APP_READY.
        await accountsPage.goto(new URL('/login?noauto=true', accountsPage.url()).href);
        if (!(await testSetup.isLoginPage({ page: accountsPage }))) {
            throw new StepError('no-login-page', `user accounts are on, but ${redactLabel(accountsPage.url())} is not the login page`);
        }
        await accountsPage.locator('#userList .userSelect').first().click();
        await accountsPage.waitForURL(url => url.pathname !== '/login', { timeout: 60_000 });
        result.answered = (await settleFrontend(accountsPage, { signal })).answered;
        const me = await accountsPage.evaluate(async () => {
            const response = await fetch('/api/users/me');
            return { status: response.status, handle: response.ok ? (await response.json()).handle : null };
        });
        if (me.status !== 200 || !me.handle) {
            throw new StepError('not-logged-in', `/api/users/me answered ${me.status} after the login`);
        }
        result.login = me.handle;
        result.frontend = ctx.state.webView.frontend ? 'webview' : 'browser';
    } finally {
        // Not bound to the step's signal: after a timeout the next steps still need the original config.yaml.
        await ctx.adb.writeAppFile(ctx.pkg, configPath, config);
        await relaunch(ctx);
    }
    return result;
}

async function nodeProcess(ctx, signal) {
    const pid = await waitForPid(ctx, { signal });
    const processes = parseProcesses(await ctx.adb.shellText(['ps', '-A', '-o', 'PID,PPID,USER,NAME,ARGS'], { signal }));
    const user = processes.find(item => item.pid === pid)?.user;
    return processes.find(item => item.user === user && /libnode\.so|(^|\/)node( |$)/.test(`${item.name} ${item.args}`) && /server\.js/.test(item.args)) ?? null;
}

async function waitForNode(ctx, signal, notPid = null) {
    return eventually(async () => {
        const state = await serverState(ctx, signal);
        if (state.state !== 'Running') {
            return null;
        }
        const node = await nodeProcess(ctx, signal);
        return node && node.pid !== notPid ? node : null;
    }, { timeoutMs: 5 * 60_000, signal, code: 'no-restart', detail: 'no new running node process' });
}

/** SIGKILL for an app process, sent by the debug hook from the app's own process (see SmokeHookProvider). */
async function killAppProcess(ctx, pid, signal) {
    const reply = await ctx.adb.hook(ctx.pkg, 'kill', { arg: pid, signal, timeoutMs: 30_000 });
    if (reply.killed !== pid) {
        throw new StepError('kill-failed', `the smoke hook did not kill ${pid}: ${JSON.stringify(reply)}`);
    }
}

async function stepCrashPolicy(ctx, signal) {
    const tags = ctx.options.uiTags;
    const first = await waitForNode(ctx, signal);
    await killAppProcess(ctx, first.pid, signal);
    const restarted = await waitForNode(ctx, signal, first.pid);
    // Three automatic restarts fit in the 5-minute window (RestartConfig); the fourth crash gives up.
    let previous = restarted.pid;
    for (let kill = 2; kill <= 4; kill++) {
        await killAppProcess(ctx, previous, signal);
        if (kill < 4) {
            previous = (await waitForNode(ctx, signal, previous)).pid;
        }
    }
    await waitForServerState(ctx, 'Failed', { signal });
    await runUi(ctx, 'errorScreen', { restartTag: tags.failedRestart, shareTag: tags.failedShareLogs, pressRestart: 'true' }, { timeoutMs: 5 * 60_000, signal });
    if (!ctx.state.noRestart) {
        await launchApp(ctx, signal);
    }
    const server = await waitForServer(ctx, { signal });
    await checkHealth(ctx, server.port, signal);
    return { firstPid: first.pid, restartedPid: restarted.pid };
}

async function stepBackgroundSurvival(ctx, signal) {
    const minutes = ctx.options.idleWaitMinutes;
    const { adb } = ctx;
    await waitForServer(ctx, { signal });
    await adb.shell(['input', 'keyevent', 'KEYCODE_HOME'], { signal });
    await adb.shell(['dumpsys', 'battery', 'unplug'], { signal });
    await adb.shell(['dumpsys', 'deviceidle', 'enable'], { check: false, signal });
    const forced = await adb.shellText(['dumpsys', 'deviceidle', 'force-idle'], { signal });
    try {
        await sleep(minutes * 60_000, signal);
        const state = await serverState(ctx, signal);
        if (state.state !== 'Running') {
            throw new StepError('server-stopped', `after ${minutes} min idle the server is ${state.state}`);
        }
        await checkHealth(ctx, state.port, signal);
        return { idleMinutes: minutes, forceIdle: forced.split('\n')[0] };
    } finally {
        await adb.shell(['dumpsys', 'deviceidle', 'unforce'], { check: false });
        await adb.shell(['dumpsys', 'battery', 'reset'], { check: false });
        await launchApp(ctx).catch(() => {});
    }
}

async function stepRepair(ctx, signal) {
    const configPath = `${CHECKOUT_DIR}/config.yaml`;
    const configBefore = await appText(ctx, configPath, signal);
    const extensionsDir = `${DATA_DIR}/default-user/extensions`;
    const hadExtensions = await appPathExists(ctx, extensionsDir, signal);
    const hadPlugin = await appPathExists(ctx, `${CHECKOUT_DIR}/plugins/${PLUGIN_ID}`, signal);
    // Corrupt the checkout's repository: HEAD no longer names a ref, so git cannot read it.
    await ctx.adb.writeAppFile(ctx.pkg, `${CHECKOUT_DIR}/.git/HEAD`, 'TODO(copy)\n', { signal });
    await forceStop(ctx, signal);
    await runUi(ctx, 'repair', { openSettingsTag: ctx.options.uiTags.openSettings, timeoutSeconds: 40 * 60 }, { timeoutMs: 42 * 60_000, signal });
    const head = await checkoutHead(ctx, signal);
    const expected = ctx.fixtures.remoteHeads()[ctx.options.defaultRef];
    if (head.commit !== expected) {
        throw new StepError('not-repaired', `checkout ${head.branch}@${head.commit}, expected ${expected}`);
    }
    if ((await appText(ctx, configPath, signal)) !== configBefore) {
        throw new StepError('config-lost', 'config.yaml differs after Repair');
    }
    if (hadExtensions && !(await appPathExists(ctx, extensionsDir, signal))) {
        throw new StepError('extensions-lost', 'the extensions folder was not migrated');
    }
    if (hadPlugin && !(await appPathExists(ctx, `${CHECKOUT_DIR}/plugins/${PLUGIN_ID}`, signal))) {
        throw new StepError('plugins-lost', 'the server plugin was not migrated');
    }
    const listing = await ctx.adb.runAs(ctx.pkg, ['ls', 'files'], { signal });
    const kept = String(listing.stdout).split(/\s+/).filter(name => /^SillyBunny\.broken-/.test(name));
    if (kept.length === 0) {
        throw new StepError('no-broken-folder', 'no SillyBunny.broken-* folder was kept');
    }
    if (!ctx.state.noRestart) {
        await launchApp(ctx, signal);
    }
    const server = await waitForServer(ctx, { signal });
    await checkHealth(ctx, server.port, signal);
    return { checkout: head.commit, kept };
}

async function stepNodeOnly(ctx, signal) {
    const apks = [ctx.options.apk, ctx.options.updateApk, ...ctx.options.extraApks].filter(Boolean);
    for (const apk of apks) {
        const found = bunEntries(zipEntryNames(fs.readFileSync(apk)));
        if (found.length > 0) {
            throw new StepError('bun-in-apk', `${path.basename(apk)} ships ${found.slice(0, 5).join(', ')}`);
        }
    }
    const server = await waitForServer(ctx, { signal });
    const node = await nodeProcess(ctx, signal);
    if (!node) {
        throw new StepError('no-node', 'no node server process');
    }
    const environ = await ctx.adb.readAppFile(ctx.pkg, `/proc/${node.pid}/environ`, { signal });
    const pathValue = String(environ ?? '').split('\0').find(entry => entry.startsWith('PATH='))?.slice(5) ?? '';
    const lookup = await ctx.adb.runAs(ctx.pkg, ['sh', '-c', `PATH=${shellQuote(pathValue)} command -v bun bunx`], { check: false, signal });
    if (String(lookup.stdout).trim() !== '') {
        throw new StepError('bun-on-path', `bun resolves on the server PATH: ${String(lookup.stdout).trim()}`);
    }
    const log = await appText(ctx, SERVER_LOG_FILE, signal) ?? '';
    const banners = [...log.matchAll(/startup on (\S+) v?(\d+\.\d+\.\d+)/g)];
    const banner = banners[banners.length - 1];
    if (!banner || banner[1] !== 'Node.js' || banner[2] !== ctx.facts.runtime.node) {
        throw new StepError('not-node', `server banner ${banner ? banner[0] : 'missing'}, expected Node.js ${ctx.facts.runtime.node}`);
    }
    return { apks: apks.length, node: banner[2], port: server.port };
}

async function stepDataSafety(ctx, signal) {
    const final = await checkDataSafety(ctx, signal);
    const verdict = dataSafetyVerdict(ctx.records);
    if (!final?.ok || verdict.failed.length > 0) {
        throw new StepError('data-changed', `failed after steps ${verdict.failed.join(', ') || 'none'}; now ${JSON.stringify(final)}`);
    }
    return { checkedAfter: verdict.checked, digest: final.digest };
}

const IMPLEMENTATIONS = {
    1: stepFirstRun,
    2: stepServerWebView,
    3: stepChat,
    4: stepGitUpdate,
    5: stepMinAppVersion,
    6: stepApkSelfUpdate,
    7: stepExtension,
    8: stepServerPlugin,
    9: stepTokenGate,
    10: stepCrashPolicy,
    11: stepBackgroundSurvival,
    12: stepRepair,
    13: stepNodeOnly,
    14: stepDataSafety,
};

/**
 * The runnable steps for {@link runSteps}: plan order, with step 11's deadline extended by its idle wait.
 * @param {{idleWaitMinutes: number}} options Run options.
 * @returns {object[]} Steps.
 */
export function smokeSteps({ idleWaitMinutes }) {
    return STEPS.map(step => ({
        ...step,
        timeoutMinutes: step.id === 11 ? step.timeoutMinutes + idleWaitMinutes : step.timeoutMinutes,
        run: IMPLEMENTATIONS[step.id],
    }));
}

/**
 * Fixture facts the steps need, from p61's `startFixtures` info.
 * @param {object} info Launcher info.
 * @returns {{info: object, urls: object, remotePath: () => string, remoteHeads: () => Record<string, string>, repoInfo: (name: string) => object}}
 */
export function fixtureView(info) {
    const repos = info.services.git.repos;
    return {
        info,
        urls: guestUrls(),
        remotePath: () => repos.sillybunny.path,
        remoteHeads: () => readRefs(repos.sillybunny.path).heads,
        repoInfo: name => repos[name],
    };
}
