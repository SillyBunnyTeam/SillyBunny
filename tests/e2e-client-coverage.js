import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

export const E2E_COVERAGE_DIR_VARIABLE = 'SILLYBUNNY_E2E_COVERAGE_DIR';

const INSTALLED_SYMBOL = Symbol.for('sillybunny.e2eClientCoverageInstalled');
const PAGE_CLOSE_WRAPPED_SYMBOL = Symbol.for('sillybunny.e2eClientCoveragePageCloseWrapped');
const STOP_COVERAGE_TIMEOUT_MS = 5_000;

/**
 * Merges `[start, end]` byte intervals into minimal sorted non-overlapping pairs.
 * @param {[number, number][]} intervals Byte intervals
 * @returns {[number, number][]}
 */
export function mergeIntervals(intervals) {
    const valid = intervals
        .filter(pair => Array.isArray(pair) && pair.length >= 2
            && Number.isFinite(pair[0]) && Number.isFinite(pair[1]) && pair[1] > pair[0])
        .map(([start, end]) => [Math.max(0, Math.floor(start)), Math.floor(end)])
        .filter(([start, end]) => end > start)
        .sort((left, right) => left[0] - right[0] || left[1] - right[1]);

    if (valid.length === 0) {
        return [];
    }

    const merged = [valid[0]];
    for (let index = 1; index < valid.length; index++) {
        const [start, end] = valid[index];
        const previous = merged[merged.length - 1];
        if (start <= previous[1]) {
            if (end > previous[1]) {
                previous[1] = end;
            }
        } else {
            merged.push([start, end]);
        }
    }

    return merged;
}

/**
 * Sums covered byte counts across merged `[start, end]` intervals.
 * @param {[number, number][]} intervals Byte intervals
 * @returns {number}
 */
export function countCoveredBytes(intervals) {
    let total = 0;
    for (const [start, end] of mergeIntervals(intervals)) {
        total += end - start;
    }
    return total;
}

/**
 * Normalizes a Chromium script URL or pathname to a POSIX path under `/script.js` or `/scripts/**`.
 * Returns `null` for non-client, non-JS, external-scheme or traversal URLs.
 * @param {string} urlString Script URL or pathname
 * @returns {string | null}
 */
export function normalizeClientScriptPathname(urlString) {
    if (typeof urlString !== 'string' || !urlString.trim()) {
        return null;
    }

    let pathname;
    const trimmed = urlString.trim();
    if (trimmed.startsWith('/')) {
        pathname = trimmed.split(/[?#]/)[0];
    } else {
        let parsed;
        try {
            parsed = new URL(trimmed);
        } catch {
            return null;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        pathname = parsed.pathname;
    }

    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }

    const normalized = path.posix.normalize(decoded.replace(/\\/g, '/'));
    if (!normalized.startsWith('/') || normalized.includes('/../') || normalized.endsWith('/..')) {
        return null;
    }

    if (normalized === '/script.js' || (normalized.startsWith('/scripts/') && normalized.endsWith('.js'))) {
        return normalized;
    }

    return null;
}

/**
 * Flattens nested V8 precise block-coverage ranges from one `stopJSCoverage()` entry into
 * merged executed `[start, end]` byte intervals and total byte length.
 * @param {{ source?: string, functions?: { ranges?: { startOffset: number, endOffset: number, count: number }[] }[] }} entry V8 script coverage entry
 * @returns {{ totalBytes: number, coveredRanges: [number, number][] }}
 */
export function extractCoveredIntervals(entry) {
    const flattened = [];
    let maxEndOffset = typeof entry?.source === 'string' ? entry.source.length : 0;
    let order = 0;

    for (const fn of entry?.functions ?? []) {
        for (const range of fn?.ranges ?? []) {
            const startOffset = Number(range?.startOffset);
            const endOffset = Number(range?.endOffset);
            const count = Number(range?.count);
            if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset) || !Number.isFinite(count) || endOffset <= startOffset) {
                continue;
            }
            if (endOffset > maxEndOffset) {
                maxEndOffset = endOffset;
            }
            flattened.push({
                startOffset: Math.max(0, Math.floor(startOffset)),
                endOffset: Math.floor(endOffset),
                count: Math.max(0, count),
                order: order++,
            });
        }
    }

    flattened.sort((left, right) => (
        left.startOffset - right.startOffset
        || right.endOffset - left.endOffset
        || left.order - right.order
    ));

    const covered = [];
    const stack = [];
    let cursor = 0;
    const emit = (from, to, count) => {
        if (count > 0 && to > from) {
            covered.push([from, to]);
        }
    };

    for (const range of flattened) {
        while (stack.length > 0 && stack[stack.length - 1].endOffset <= range.startOffset) {
            const top = stack.pop();
            emit(cursor, top.endOffset, top.count);
            cursor = Math.max(cursor, top.endOffset);
        }

        const enclosing = stack[stack.length - 1];
        if (enclosing && enclosing.startOffset === range.startOffset && enclosing.endOffset === range.endOffset) {
            // Later V8 function entries are more specific than the outer script range of the same span.
            enclosing.count = range.count;
            continue;
        }

        if (enclosing && range.startOffset > cursor) {
            emit(cursor, range.startOffset, enclosing.count);
        }
        cursor = Math.max(cursor, range.startOffset);
        stack.push({ ...range });
    }

    while (stack.length > 0) {
        const top = stack.pop();
        emit(cursor, top.endOffset, top.count);
        cursor = Math.max(cursor, top.endOffset);
    }

    return {
        totalBytes: maxEndOffset,
        coveredRanges: mergeIntervals(covered),
    };
}

/**
 * In-memory per-worker client coverage accumulator that flushes a compact JSON file without source text.
 * @param {{ outputDir: string, workerId?: string, pid?: number }} options Collector options
 */
export function createCoverageCollector({ outputDir, workerId = '0', pid = process.pid }) {
    const scripts = new Map();
    const outputFile = path.join(outputDir, `worker-${String(workerId).replace(/[^\w.-]/g, '_')}-${pid}.json`);
    let dirty = false;

    const recordEntries = entries => {
        if (!Array.isArray(entries)) {
            return;
        }
        for (const entry of entries) {
            const pathname = normalizeClientScriptPathname(entry?.url);
            if (!pathname) {
                continue;
            }
            const { totalBytes, coveredRanges } = extractCoveredIntervals(entry);
            const existing = scripts.get(pathname);
            if (!existing) {
                scripts.set(pathname, {
                    totalBytes,
                    coveredRanges,
                    hits: 1,
                });
            } else {
                existing.totalBytes = Math.max(existing.totalBytes, totalBytes);
                existing.coveredRanges = mergeIntervals([...existing.coveredRanges, ...coveredRanges]);
                existing.hits += 1;
            }
            dirty = true;
        }
    };

    const snapshot = () => {
        const serialized = {};
        for (const pathname of [...scripts.keys()].sort((left, right) => left.localeCompare(right))) {
            const record = scripts.get(pathname);
            serialized[pathname] = {
                totalBytes: record.totalBytes,
                coveredRanges: record.coveredRanges,
                hits: record.hits,
            };
        }
        return {
            version: 1,
            workerId: String(workerId),
            pid,
            scripts: serialized,
        };
    };

    const flush = ({ force = false } = {}) => {
        if (!outputDir || (!dirty && !force)) {
            return false;
        }
        fs.mkdirSync(outputDir, { recursive: true });
        const tempFile = `${outputFile}.tmp`;
        fs.writeFileSync(tempFile, `${JSON.stringify(snapshot())}\n`, 'utf8');
        fs.renameSync(tempFile, outputFile);
        dirty = false;
        return true;
    };

    return {
        outputFile,
        recordEntries,
        snapshot,
        flush,
    };
}

function stopCoverageWithTimeout(page, timeoutMs = STOP_COVERAGE_TIMEOUT_MS) {
    let timer;
    return Promise.race([
        page.coverage.stopJSCoverage(),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('stopJSCoverage timed out')), timeoutMs);
            timer.unref?.();
        }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * Installs opt-in Chromium V8 JS coverage collection on Playwright worker launches when
 * `SILLYBUNNY_E2E_COVERAGE_DIR` is set. Does nothing when the variable is unset.
 * @param {{ env?: NodeJS.ProcessEnv, browserType?: typeof chromium, force?: boolean }} [options]
 * @returns {{ installed: boolean, outputDir?: string, collector?: ReturnType<typeof createCoverageCollector> }}
 */
export function installE2eClientCoverage({ env = process.env, browserType = chromium, force = false } = {}) {
    const rawDir = env[E2E_COVERAGE_DIR_VARIABLE];
    const outputDir = typeof rawDir === 'string' ? rawDir.trim() : '';
    if (!outputDir) {
        return { installed: false };
    }

    const resolvedDir = path.resolve(outputDir);
    fs.mkdirSync(resolvedDir, { recursive: true });

    const workerId = env.TEST_PARALLEL_INDEX;
    // Skip the main coordinator and globalSetup server-priming boots; only measure test workers.
    if (!force && (workerId === undefined || workerId === '')) {
        return { installed: false, outputDir: resolvedDir };
    }

    if (browserType[INSTALLED_SYMBOL]) {
        return { installed: true, outputDir: resolvedDir, collector: browserType[INSTALLED_SYMBOL] };
    }

    const collector = createCoverageCollector({
        outputDir: resolvedDir,
        workerId: workerId || '0',
    });

    const startPromises = new WeakMap();
    const activePages = new Set();

    const collectPageCoverage = async page => {
        if (!page) {
            return;
        }
        const pendingStart = startPromises.get(page);
        if (pendingStart) {
            await pendingStart.catch(() => {});
        }
        if (!activePages.has(page)) {
            return;
        }
        activePages.delete(page);
        try {
            const entries = await stopCoverageWithTimeout(page);
            collector.recordEntries(entries);
        } catch {
            // Closed or crashed pages must never fail an e2e test.
        }
    };

    const wrapPageClose = page => {
        if (!page || page[PAGE_CLOSE_WRAPPED_SYMBOL] || typeof page.close !== 'function') {
            return;
        }
        page[PAGE_CLOSE_WRAPPED_SYMBOL] = true;
        const originalClose = page.close.bind(page);
        page.close = async (...closeArgs) => {
            await collectPageCoverage(page);
            return originalClose(...closeArgs);
        };
    };

    const startPageCoverage = page => {
        if (!page) {
            return Promise.resolve();
        }
        const existing = startPromises.get(page);
        if (existing) {
            return existing;
        }
        const promise = (async () => {
            if (typeof page.coverage?.startJSCoverage !== 'function') {
                return;
            }
            wrapPageClose(page);
            try {
                await page.coverage.startJSCoverage({
                    resetOnNavigation: false,
                    reportAnonymousScripts: false,
                });
                activePages.add(page);
            } catch {
                // Ignore pages that close before CDP coverage attaches.
            }
        })();
        startPromises.set(page, promise);
        return promise;
    };

    const instrumentContext = context => {
        if (!context) {
            return context;
        }
        const contextPages = new Set();
        const trackPage = page => {
            if (page) {
                contextPages.add(page);
            }
            return startPageCoverage(page);
        };

        if (typeof context.on === 'function') {
            context.on('page', page => {
                void trackPage(page);
            });
        }

        if (typeof context.newPage === 'function') {
            const originalNewPage = context.newPage.bind(context);
            context.newPage = async (...pageArgs) => {
                const page = await originalNewPage(...pageArgs);
                await trackPage(page);
                return page;
            };
        }

        if (typeof context.close === 'function') {
            const originalClose = context.close.bind(context);
            context.close = async (...closeArgs) => {
                await Promise.allSettled([...contextPages].map(collectPageCoverage));
                contextPages.clear();
                try {
                    collector.flush();
                } catch {
                    // Best-effort flush; never fail teardown.
                }
                return originalClose(...closeArgs);
            };
        }

        return context;
    };

    const originalLaunch = browserType.launch.bind(browserType);
    browserType.launch = async (...launchArgs) => {
        const browser = await originalLaunch(...launchArgs);
        const loosePages = new Set();

        if (typeof browser.newContext === 'function') {
            const originalNewContext = browser.newContext.bind(browser);
            browser.newContext = async (...contextArgs) => {
                const context = await originalNewContext(...contextArgs);
                return instrumentContext(context);
            };
        }

        if (typeof browser.newPage === 'function') {
            const originalBrowserNewPage = browser.newPage.bind(browser);
            browser.newPage = async (...pageArgs) => {
                const page = await originalBrowserNewPage(...pageArgs);
                loosePages.add(page);
                await startPageCoverage(page);
                return page;
            };
        }

        if (typeof browser.close === 'function') {
            const originalBrowserClose = browser.close.bind(browser);
            browser.close = async (...closeArgs) => {
                await Promise.allSettled([...loosePages].map(collectPageCoverage));
                loosePages.clear();
                try {
                    collector.flush();
                } catch {
                    // Best-effort flush on browser shutdown.
                }
                return originalBrowserClose(...closeArgs);
            };
        }

        return browser;
    };

    process.once('exit', () => {
        try {
            collector.flush();
        } catch {
            // Best-effort synchronous flush on worker exit.
        }
    });

    browserType[INSTALLED_SYMBOL] = collector;
    return { installed: true, outputDir: resolvedDir, collector };
}
