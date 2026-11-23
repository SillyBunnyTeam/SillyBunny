/**
 * Performance telemetry parsers, snapshot collector, and budget evaluator for the Android smoke harness.
 * Keeps dependencies limited to Node built-ins so `run-smoke.js` can load it before `tests/` npm install.
 */

export const DEFAULT_ANDROID_PERF_BUDGETS = Object.freeze({
    maxFilesMb: 800,
    maxGitMb: 95,
    maxAppPssMb: 350,
    maxJankyPct: 25,
    maxCpuFrameMs: 250,
    maxWarmServerHealthyMs: 12_000,
});

function parseFirstMs(raw, pattern) {
    const match = pattern.exec(raw);
    return match ? Number(match[1]) : null;
}

/**
 * Parses `dumpsys gfxinfo <pkg> framestats`, resolving PROFILEDATA columns dynamically by header name
 * so API 36+ column changes do not break frame timing calculations.
 * @param {string} raw Output of `dumpsys gfxinfo <pkg> framestats`.
 * @returns {object} Parsed frame metrics.
 */
export function parseGfxinfoFramestats(raw) {
    const text = String(raw ?? '');
    const totalMatch = /Total frames rendered:\s*(\d+)/.exec(text);
    const jankyMatch = /Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/.exec(text);
    const legacyMatch = /Janky frames \(legacy\):\s*(\d+)\s*\(([\d.]+)%\)/.exec(text);

    const frames = [];
    const startIdx = text.indexOf('---PROFILEDATA---');
    if (startIdx !== -1) {
        const endIdx = text.indexOf('---PROFILEDATA---', startIdx + 17);
        const block = text.slice(startIdx, endIdx === -1 ? text.length : endIdx);
        let columns = null;
        for (const line of block.split(/\r?\n/)) {
            if (!line || line.startsWith('---')) {
                continue;
            }
            const parts = line.split(',');
            if (parts[0] === 'Flags') {
                columns = Object.fromEntries(parts.map((name, index) => [name.trim(), index]));
                continue;
            }
            if (!columns) {
                continue;
            }
            const valueOf = name => Number(parts[columns[name]] ?? 0);
            const flags = valueOf('Flags');
            const intendedVsync = valueOf('IntendedVsync');
            const frameCompleted = valueOf('FrameCompleted');
            if (flags !== 0 || intendedVsync <= 0 || frameCompleted <= intendedVsync) {
                continue;
            }
            const frameStart = valueOf('FrameStartTime') || valueOf('HandleInputStart') || intendedVsync;
            const syncQueued = valueOf('SyncQueued');
            const syncStart = valueOf('SyncStart');
            const swapBuffers = valueOf('SwapBuffers');
            const uiMs = syncQueued > frameStart ? (syncQueued - frameStart) / 1e6 : 0;
            const renderThreadMs = swapBuffers > syncStart ? (swapBuffers - syncStart) / 1e6 : 0;
            frames.push({
                frameCompleted,
                durMs: (frameCompleted - intendedVsync) / 1e6,
                cpuMs: uiMs + renderThreadMs,
            });
        }
    }

    let avgMs = null;
    let maxMs = null;
    let avgCpuMs = null;
    let maxCpuMs = null;
    let over16Cpu = 0;
    let over33Cpu = 0;
    let effectiveFps = null;

    if (frames.length > 0) {
        avgMs = +(frames.reduce((sum, frame) => sum + frame.durMs, 0) / frames.length).toFixed(2);
        maxMs = +Math.max(...frames.map(frame => frame.durMs)).toFixed(2);
        avgCpuMs = +(frames.reduce((sum, frame) => sum + frame.cpuMs, 0) / frames.length).toFixed(2);
        maxCpuMs = +Math.max(...frames.map(frame => frame.cpuMs)).toFixed(2);
        over16Cpu = frames.filter(frame => frame.cpuMs > 16.67).length;
        over33Cpu = frames.filter(frame => frame.cpuMs > 33.33).length;
        let activeTimeSeconds = 0;
        let activeFrames = 0;
        for (let index = 1; index < frames.length; index++) {
            const dt = (frames[index].frameCompleted - frames[index - 1].frameCompleted) / 1e9;
            if (dt > 0 && dt < 0.5) {
                activeTimeSeconds += dt;
                activeFrames++;
            }
        }
        if (activeTimeSeconds > 0.1) {
            effectiveFps = +(activeFrames / activeTimeSeconds).toFixed(1);
        }
    }

    return {
        totalFrames: totalMatch ? Number(totalMatch[1]) : 0,
        jankyFrames: jankyMatch ? Number(jankyMatch[1]) : 0,
        jankyPct: jankyMatch ? Number(jankyMatch[2]) : null,
        jankyLegacyPct: legacyMatch ? Number(legacyMatch[2]) : null,
        p50Ms: parseFirstMs(text, /50th percentile:\s*(\d+)ms/),
        p90Ms: parseFirstMs(text, /90th percentile:\s*(\d+)ms/),
        p95Ms: parseFirstMs(text, /95th percentile:\s*(\d+)ms/),
        p99Ms: parseFirstMs(text, /99th percentile:\s*(\d+)ms/),
        missedVsync: parseFirstMs(text, /Number Missed Vsync:\s*(\d+)/) ?? 0,
        slowUi: parseFirstMs(text, /Number Slow UI thread:\s*(\d+)/) ?? 0,
        framestatsCount: frames.length,
        avgMs,
        maxMs,
        avgCpuMs,
        maxCpuMs,
        over16Cpu,
        over33Cpu,
        effectiveFps,
    };
}

/**
 * Parses key memory totals from `dumpsys meminfo <pkg>`.
 * @param {string} raw Output of `dumpsys meminfo`.
 * @returns {{totalPssMb: number|null, totalRssMb: number|null, nativeHeapMb: number|null, dalvikHeapMb: number|null, webViews: number|null}} Summary.
 */
export function parseMeminfoSummary(raw) {
    const text = String(raw ?? '');
    const kbToMb = (pattern) => {
        const match = pattern.exec(text);
        return match ? +(Number(match[1]) / 1024).toFixed(1) : null;
    };
    const webViewsMatch = /WebViews:\s*(\d+)/.exec(text);
    return {
        totalPssMb: kbToMb(/TOTAL PSS:\s*(\d+)/),
        totalRssMb: kbToMb(/TOTAL RSS:\s*(\d+)/),
        nativeHeapMb: kbToMb(/Native Heap:\s*(\d+)/),
        dalvikHeapMb: kbToMb(/Dalvik Heap\s+(\d+)/),
        webViews: webViewsMatch ? Number(webViewsMatch[1]) : null,
    };
}

/**
 * Parses `du -sk` lines into megabytes keyed by relative directory path.
 * @param {string} raw Output of `du -sk ...`.
 * @returns {Record<string, number>} Map of path to size in MiB.
 */
export function parseDiskUsageMb(raw) {
    const sizes = {};
    for (const line of String(raw ?? '').split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (match) {
            sizes[match[2]] = +(Number(match[1]) / 1024).toFixed(1);
        }
    }
    return sizes;
}

/**
 * Extracts `[sillybunny-android] healthy afterMs=<N>` markers from `server.log`.
 * @param {string} serverLog Contents of `server.log`.
 * @returns {{count: number, firstMs: number|null, lastMs: number|null, minMs: number|null, maxMs: number|null, samples: number[]}} Timings.
 */
export function parseHealthyAfterMs(serverLog) {
    const samples = [];
    for (const match of String(serverLog ?? '').matchAll(/\[sillybunny-android\]\s+healthy\s+afterMs=(\d+)/g)) {
        samples.push(Number(match[1]));
    }
    return {
        count: samples.length,
        firstMs: samples[0] ?? null,
        lastMs: samples.at(-1) ?? null,
        minMs: samples.length > 0 ? Math.min(...samples) : null,
        maxMs: samples.length > 0 ? Math.max(...samples) : null,
        samples,
    };
}

/**
 * Evaluates a collected Android performance snapshot against numeric maximum ceilings.
 * Metrics that are absent from the snapshot are skipped so partial step selections remain usable.
 * @param {object} snapshot Collected performance snapshot.
 * @param {object} [budgets] Budget limits.
 * @returns {{ok: boolean, violations: Array<{metric: string, actual: number, max: number}>}} Evaluation result.
 */
export function evaluateAndroidPerfBudgets(snapshot, budgets = DEFAULT_ANDROID_PERF_BUDGETS) {
    const checks = [
        ['diskMb.files', snapshot?.diskMb?.files, budgets.maxFilesMb],
        ['diskMb.files/SillyBunny/.git', snapshot?.diskMb?.['files/SillyBunny/.git'], budgets.maxGitMb],
        ['meminfo.totalPssMb', snapshot?.meminfo?.totalPssMb, budgets.maxAppPssMb],
        ['gfxinfo.jankyPct', snapshot?.gfxinfo?.jankyPct, budgets.maxJankyPct],
        ['gfxinfo.maxCpuMs', snapshot?.gfxinfo?.maxCpuMs, budgets.maxCpuFrameMs],
        ['serverHealthy.warmMs', snapshot?.serverHealthy?.count > 1 ? snapshot.serverHealthy.lastMs : null, budgets.maxWarmServerHealthyMs],
    ];
    const violations = [];
    for (const [metric, actual, max] of checks) {
        if (typeof actual === 'number' && Number.isFinite(actual) && typeof max === 'number' && actual > max) {
            violations.push({ metric, actual, max });
        }
    }
    return { ok: violations.length === 0, violations };
}

/**
 * Formats a compact Markdown summary table for CI step summaries.
 * @param {object} snapshot Collected performance snapshot.
 * @param {{ok: boolean, violations: Array<{metric: string, actual: number, max: number}>}|null} [evaluation] Optional budget verdict.
 * @returns {string[]} Markdown lines.
 */
export function formatPerfSummaryMarkdown(snapshot, evaluation = null) {
    if (!snapshot) {
        return [];
    }
    const rows = [];
    if (typeof snapshot.diskMb?.files === 'number') {
        rows.push(`| App storage (\`files/\`) | ${snapshot.diskMb.files} MiB |`);
    }
    if (typeof snapshot.diskMb?.['files/SillyBunny/.git'] === 'number') {
        rows.push(`| Checkout \`.git\` | ${snapshot.diskMb['files/SillyBunny/.git']} MiB |`);
    }
    if (typeof snapshot.meminfo?.totalPssMb === 'number') {
        rows.push(`| App memory (TOTAL PSS) | ${snapshot.meminfo.totalPssMb} MiB |`);
    }
    if (typeof snapshot.serverHealthy?.firstMs === 'number') {
        rows.push(`| Server healthy (first / latest) | ${snapshot.serverHealthy.firstMs} ms / ${snapshot.serverHealthy.lastMs} ms |`);
    }
    if (snapshot.gfxinfo?.totalFrames > 0) {
        rows.push(`| Compose/UI frames (jank / max CPU) | ${snapshot.gfxinfo.totalFrames} frames (${snapshot.gfxinfo.jankyPct ?? '?'}% jank, ${snapshot.gfxinfo.maxCpuMs ?? '?'} ms max CPU) |`);
    }
    if (rows.length === 0) {
        return [];
    }
    const lines = [
        '',
        '### Android Performance Snapshot',
        '| Metric | Measured |',
        '| --- | --- |',
        ...rows,
    ];
    if (evaluation && !evaluation.ok) {
        lines.push('', `Performance budget violations: ${evaluation.violations.map(v => `${v.metric}=${v.actual} > ${v.max}`).join(', ')}`);
    }
    return lines;
}

/**
 * Collects read-only performance metrics from a running smoke emulator before teardown.
 * Failures are swallowed per probe so telemetry never masks functional smoke results.
 * @param {object} options Collector options.
 * @param {object} options.adb Adb client exposing `shellText`.
 * @param {string} options.pkg Target Android package name.
 * @param {object[]} [options.records] Completed step records.
 * @returns {Promise<object>} Snapshot object.
 */
export async function collectDevicePerfSnapshot({ adb, pkg, records = [] }) {
    const safeShell = async (args) => {
        try {
            return await adb.shellText(args, { timeoutMs: 20_000 });
        } catch {
            return '';
        }
    };

    const gfxRaw = await safeShell(['dumpsys', 'gfxinfo', pkg, 'framestats']);
    const memRaw = await safeShell(['dumpsys', 'meminfo', pkg]);
    const diskRaw = await safeShell([
        'run-as', pkg, 'sh', '-c',
        'du -sk files files/SillyBunny files/SillyBunny/.git files/SillyBunny/node_modules files/home 2>/dev/null || true',
    ]);
    const serverLog = await safeShell(['run-as', pkg, 'sh', '-c', 'cat files/logs/server.log 2>/dev/null || true']);

    return {
        collectedAt: new Date().toISOString(),
        pkg,
        stepDurationsMs: Object.fromEntries(
            records
                .filter(record => typeof record?.ms === 'number')
                .map(record => [`step-${record.id}-${record.key}`, record.ms]),
        ),
        diskMb: parseDiskUsageMb(diskRaw),
        meminfo: parseMeminfoSummary(memRaw),
        gfxinfo: parseGfxinfoFramestats(gfxRaw),
        serverHealthy: parseHealthyAfterMs(serverLog),
    };
}
