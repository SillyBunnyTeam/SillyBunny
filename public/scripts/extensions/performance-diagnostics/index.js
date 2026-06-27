const REPORT_SCHEMA_VERSION = 1;
const DEFAULT_RESOURCE_TIMING_BUFFER_SIZE = 2000;
const DEFAULT_LOG_LIMIT = 400;
const DEFAULT_RENDER_MESSAGE_COUNT = 96;
const DEFAULT_RENDER_VISIBLE_COUNT = 24;
const DEFAULT_RENDER_FILLER_REPEAT = 36;
const DEFAULT_STREAM_STEP_COUNT = 32;
const DEFAULT_STREAM_FILLER_REPEAT = 48;
const DEFAULT_STREAM_CODE_REPEAT = 12;

let activeLogger = null;
let lastReport = null;
let panel = null;
let extensionActive = false;
let activeDiagnosticsRun = false;
let diagnosticsRunId = 0;
let activeDiagnosticsLogger = null;
const SENSITIVE_DIAGNOSTIC_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|token|secret|password)/i;

function getNow() {
    return performance.now();
}

function getTimestamp() {
    return new Date().toISOString();
}

function getLocationHref() {
    return globalThis.location?.href ?? 'http://localhost/';
}

function getLocationOrigin() {
    return globalThis.location?.origin ?? new URL(getLocationHref()).origin;
}

function setResourceTimingBufferSize(size = DEFAULT_RESOURCE_TIMING_BUFFER_SIZE) {
    if (typeof performance.setResourceTimingBufferSize === 'function') {
        performance.setResourceTimingBufferSize(size);
    }
}

export function serializeDiagnosticValue(value, { depth = 0, seen = new WeakSet() } = {}) {
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
        return value ?? null;
    }

    if (typeof value === 'string') {
        const redacted = redactDiagnosticString(value);
        return redacted.length > 500 ? `${redacted.slice(0, 500)}...` : redacted;
    }

    if (typeof value === 'function') {
        return '[function]';
    }

    if (value instanceof Error) {
        return {
            name: value.name,
            message: redactDiagnosticString(value.message),
            stack: typeof value.stack === 'string' ? redactDiagnosticString(value.stack).slice(0, 1500) : '',
        };
    }

    if (typeof value !== 'object') {
        return String(value);
    }

    if (seen.has(value)) {
        return '[circular]';
    }

    if (depth >= 2) {
        return Object.prototype.toString.call(value);
    }

    seen.add(value);

    if (Array.isArray(value)) {
        return value.slice(0, 10).map(item => serializeDiagnosticValue(item, { depth: depth + 1, seen }));
    }

    const result = {};
    for (const key of Object.keys(value).slice(0, 12)) {
        try {
            result[key] = SENSITIVE_DIAGNOSTIC_KEY_PATTERN.test(key)
                ? '[redacted]'
                : serializeDiagnosticValue(value[key], { depth: depth + 1, seen });
        } catch (error) {
            result[key] = `[unserializable: ${error?.message ?? error}]`;
        }
    }

    return result;
}

function redactDiagnosticString(value) {
    return String(value)
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
        .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password)=([^\s&]+)/gi, '$1=[redacted]')
        .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^\s&]+/gi, '$1[redacted]');
}

function serializeError(error) {
    const value = error?.error ?? error?.reason ?? error;
    const serialized = serializeDiagnosticValue(value);
    if (typeof serialized === 'object' && serialized !== null) {
        return serialized;
    }

    return {
        name: 'Error',
        message: String(serialized),
    };
}

export function sanitizeLocation(locationObject = globalThis.location ?? new URL(getLocationHref())) {
    const params = new URLSearchParams(locationObject.search || '');
    const hash = String(locationObject.hash || '').replace(/^#/, '');

    return {
        origin: locationObject.origin,
        pathname: locationObject.pathname,
        queryKeys: Array.from(params.keys()).sort(),
        hashFlags: hash ? hash.split(/[&/]/).map(value => redactDiagnosticString(value.trim())).filter(Boolean).sort() : [],
    };
}

function summarizeConsoleArgs(args) {
    return args.slice(0, 8).map((arg) => {
        if (arg instanceof Error) {
            return {
                type: 'error',
                name: arg.name,
                message: redactDiagnosticString(arg.message),
            };
        }

        if (typeof arg === 'string') {
            return {
                type: 'string',
                length: arg.length,
            };
        }

        if (arg === null || arg === undefined) {
            return {
                type: String(arg),
            };
        }

        if (typeof arg === 'object') {
            return {
                type: Array.isArray(arg) ? 'array' : 'object',
                keys: Object.keys(arg).slice(0, 8),
            };
        }

        return {
            type: typeof arg,
        };
    });
}

export function sanitizeUrlForReport(rawUrl, baseUrl = getLocationHref()) {
    try {
        const url = new URL(String(rawUrl), baseUrl);
        const queryKeys = Array.from(url.searchParams.keys()).sort();

        return {
            origin: url.origin === getLocationOrigin() ? 'same-origin' : 'cross-origin',
            protocol: url.protocol,
            pathname: url.pathname,
            queryKeys,
        };
    } catch {
        return {
            origin: 'unknown',
            protocol: '',
            pathname: '[unparseable-url]',
            queryKeys: [],
        };
    }
}

function clonePerformanceEntry(entry) {
    const sanitizedUrl = sanitizeUrlForReport(entry.name);
    const result = {
        name: sanitizedUrl.pathname,
        url: sanitizedUrl,
        entryType: entry.entryType,
        startTime: entry.startTime,
        duration: entry.duration,
    };

    for (const key of ['initiatorType', 'transferSize', 'encodedBodySize', 'decodedBodySize', 'renderBlockingStatus']) {
        if (key in entry) {
            result[key] = entry[key];
        }
    }

    return result;
}

function summarizeByAssetType(entries, byteKey) {
    const totals = {
        count: entries.length,
        js: 0,
        css: 0,
        font: 0,
        image: 0,
        other: 0,
    };

    for (const entry of entries) {
        const bytes = Number(entry[byteKey]) || 0;
        const url = String(entry.name || entry.url?.pathname || '');
        if (/\.m?js(?:\?|$)/i.test(url)) {
            totals.js += bytes;
        } else if (/\.css(?:\?|$)/i.test(url)) {
            totals.css += bytes;
        } else if (/\.(?:woff2?|ttf)(?:\?|$)/i.test(url)) {
            totals.font += bytes;
        } else if (/\.(?:png|jpe?g|webp|gif|svg|ico)(?:\?|$)/i.test(url)) {
            totals.image += bytes;
        } else {
            totals.other += bytes;
        }
    }

    return totals;
}

export function summarizePerformanceResources(entries) {
    return {
        transfer: summarizeByAssetType(entries, 'transferSize'),
        encoded: summarizeByAssetType(entries, 'encodedBodySize'),
        decoded: summarizeByAssetType(entries, 'decodedBodySize'),
        zeroTransferCount: entries.filter(entry => (Number(entry.transferSize) || 0) === 0).length,
        zeroTransferWithEncodedBodyCount: entries.filter(entry => (Number(entry.transferSize) || 0) === 0 && (Number(entry.encodedBodySize) || 0) > 0).length,
    };
}

function getPaintTimings() {
    return Object.fromEntries(performance.getEntriesByType('paint').map(entry => [entry.name, entry.startTime]));
}

function getNavigationTiming() {
    const navigation = performance.getEntriesByType('navigation')[0];
    if (!navigation) {
        return null;
    }

    return {
        domContentLoaded: navigation.domContentLoadedEventEnd,
        load: navigation.loadEventEnd,
        transferSize: navigation.transferSize,
        encodedBodySize: navigation.encodedBodySize,
        decodedBodySize: navigation.decodedBodySize,
        type: navigation.type,
    };
}

function getViewportSnapshot() {
    return {
        innerWidth: globalThis.innerWidth,
        innerHeight: globalThis.innerHeight,
        outerWidth: globalThis.outerWidth,
        outerHeight: globalThis.outerHeight,
        devicePixelRatio: globalThis.devicePixelRatio,
        screen: {
            width: globalThis.screen?.width ?? null,
            height: globalThis.screen?.height ?? null,
            availWidth: globalThis.screen?.availWidth ?? null,
            availHeight: globalThis.screen?.availHeight ?? null,
        },
        visualViewport: globalThis.visualViewport ? {
            width: globalThis.visualViewport.width,
            height: globalThis.visualViewport.height,
            offsetLeft: globalThis.visualViewport.offsetLeft,
            offsetTop: globalThis.visualViewport.offsetTop,
            pageLeft: globalThis.visualViewport.pageLeft,
            pageTop: globalThis.visualViewport.pageTop,
            scale: globalThis.visualViewport.scale,
        } : null,
    };
}

function getConnectionSnapshot() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!connection) {
        return null;
    }

    return {
        effectiveType: connection.effectiveType ?? null,
        downlink: connection.downlink ?? null,
        rtt: connection.rtt ?? null,
        saveData: connection.saveData ?? null,
    };
}

function getMemorySnapshot() {
    if (!performance.memory) {
        return null;
    }

    return {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
    };
}

function getEnvironmentSnapshot() {
    return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        languages: navigator.languages,
        hardwareConcurrency: navigator.hardwareConcurrency ?? null,
        deviceMemory: navigator.deviceMemory ?? null,
        maxTouchPoints: navigator.maxTouchPoints ?? 0,
        standalone: Boolean(navigator.standalone || matchMedia('(display-mode: standalone)').matches),
        location: sanitizeLocation(),
        viewport: getViewportSnapshot(),
        connection: getConnectionSnapshot(),
    };
}

function getResourceSnapshot() {
    const resources = performance.getEntriesByType('resource').map(clonePerformanceEntry);
    const navigation = performance.getEntriesByType('navigation')[0];
    const documentEntry = navigation ? [{
        name: sanitizeUrlForReport(getLocationHref()).pathname,
        url: sanitizeUrlForReport(getLocationHref()),
        entryType: 'navigation',
        initiatorType: 'document',
        transferSize: navigation.transferSize || 0,
        encodedBodySize: navigation.encodedBodySize || 0,
        decodedBodySize: navigation.decodedBodySize || 0,
        startTime: navigation.startTime || 0,
        duration: navigation.duration || 0,
    }] : [];
    const entries = [...documentEntry, ...resources];

    return {
        count: entries.length,
        summary: summarizePerformanceResources(entries),
        largest: entries
            .slice()
            .sort((a, b) => (Number(b.encodedBodySize) || 0) - (Number(a.encodedBodySize) || 0))
            .slice(0, 20),
    };
}

function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function createLogger({ captureConsole = false, maxEntries = DEFAULT_LOG_LIMIT } = {}) {
    const entries = [];
    const counters = {
        resize: 0,
        scroll: 0,
        visualViewportResize: 0,
        visualViewportScroll: 0,
        visibilityChange: 0,
        errors: 0,
        unhandledRejections: 0,
    };
    const observers = [];
    const cleanups = [];
    const originalConsole = {};
    let startedAt = getTimestamp();
    let stoppedAt = null;
    let isStopped = false;

    const push = (type, data = {}) => {
        entries.push({
            type,
            at: getNow(),
            data: serializeDiagnosticValue(data),
        });
        if (entries.length > maxEntries) {
            entries.splice(0, entries.length - maxEntries);
        }
    };

    const addListener = (target, type, listener, options) => {
        target?.addEventListener?.(type, listener, options);
        cleanups.push(() => target?.removeEventListener?.(type, listener, options));
    };

    const observe = (type, callback) => {
        if (typeof PerformanceObserver !== 'function') {
            return;
        }

        try {
            const observer = new PerformanceObserver((list) => callback(list.getEntries()));
            observer.observe({ type, buffered: true });
            observers.push(observer);
        } catch {
            // Unsupported entry types vary by browser.
        }
    };

    const start = () => {
        startedAt = getTimestamp();
        push('logger-started', { captureConsole });

        if (captureConsole) {
            for (const level of ['error', 'warn', 'info', 'log', 'debug']) {
                originalConsole[level] = console[level];
                console[level] = function (...args) {
                    push(`console-${level}`, { args: summarizeConsoleArgs(args) });
                    return originalConsole[level].apply(this, args);
                };
            }
        }

        addListener(window, 'error', (event) => {
            counters.errors++;
            push('window-error', serializeError(event));
        });
        addListener(window, 'unhandledrejection', (event) => {
            counters.unhandledRejections++;
            push('unhandled-rejection', serializeError(event));
        });
        addListener(window, 'resize', () => {
            counters.resize++;
            push('resize', getViewportSnapshot());
        }, { passive: true });
        addListener(document, 'scroll', () => {
            counters.scroll++;
        }, { passive: true, capture: true });
        addListener(document, 'visibilitychange', () => {
            counters.visibilityChange++;
            push('visibility-change', { visibilityState: document.visibilityState });
        });
        addListener(globalThis.visualViewport, 'resize', () => {
            counters.visualViewportResize++;
            push('visual-viewport-resize', getViewportSnapshot().visualViewport);
        }, { passive: true });
        addListener(globalThis.visualViewport, 'scroll', () => {
            counters.visualViewportScroll++;
        }, { passive: true });

        observe('longtask', entriesList => {
            for (const entry of entriesList) {
                push('longtask', clonePerformanceEntry(entry));
            }
        });
        observe('layout-shift', entriesList => {
            for (const entry of entriesList) {
                push('layout-shift', {
                    startTime: entry.startTime,
                    duration: entry.duration,
                    value: entry.value,
                    hadRecentInput: entry.hadRecentInput,
                });
            }
        });
    };

    const stop = () => {
        if (isStopped) {
            return;
        }

        isStopped = true;
        stoppedAt = getTimestamp();
        push('logger-stopped');
        for (const observer of observers) {
            observer.disconnect();
        }
        for (const cleanup of cleanups.splice(0)) {
            cleanup();
        }
        for (const [level, original] of Object.entries(originalConsole)) {
            console[level] = original;
        }
    };

    const mark = (name, data = {}) => push('mark', { name, ...data });

    const getReport = () => ({
        startedAt,
        stoppedAt,
        counters,
        entries: entries.slice(),
    });

    return { start, stop, mark, getReport };
}

function isDiagnosticsRunCurrent(runId) {
    return extensionActive && runId === diagnosticsRunId;
}

function assertDiagnosticsRunCurrent(runId) {
    if (!isDiagnosticsRunCurrent(runId)) {
        throw new Error('Performance diagnostics cancelled.');
    }
}

function waitForNextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function waitForAppReady({ timeoutMs = 60000 } = {}) {
    const started = getNow();

    while (getNow() - started < timeoutMs) {
        const preloaderGone = document.getElementById('preloader') === null;
        const context = getContext();
        const chatElement = document.getElementById('chat');
        if (preloaderGone && context && chatElement instanceof HTMLElement) {
            return { context, chatElement };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error('Performance diagnostics timed out waiting for the app to finish loading.');
}

function createLongChatMessages({
    messageCount = DEFAULT_RENDER_MESSAGE_COUNT,
    fillerRepeat = DEFAULT_RENDER_FILLER_REPEAT,
} = {}) {
    const messages = [];

    for (let index = 0; index < messageCount; index++) {
        const isUser = index % 2 === 0;
        messages.push({
            name: isUser ? 'Scroll Tester' : 'Bunny Guide',
            is_user: isUser,
            is_system: false,
            mes: `performance synthetic message ${index}\n${'long chat filler '.repeat(fillerRepeat)}`,
            extra: {},
        });
    }

    return messages;
}

function createStreamingSteps({
    stepCount = DEFAULT_STREAM_STEP_COUNT,
    fillerRepeat = DEFAULT_STREAM_FILLER_REPEAT,
    codeRepeat = DEFAULT_STREAM_CODE_REPEAT,
} = {}) {
    const codeLines = Array.from({ length: codeRepeat }, (_, index) => `console.log('stream fixture ${index}');`).join('\n');
    const fullText = [
        'Streaming performance fixture.',
        `${'reasoning detail '.repeat(fillerRepeat)}`,
        '```js',
        codeLines,
        '```',
        `${'final response text '.repeat(fillerRepeat)}`,
    ].join('\n');
    const steps = [];

    for (let index = 1; index <= stepCount; index++) {
        const end = Math.ceil((fullText.length * index) / stepCount);
        steps.push(fullText.slice(0, end));
    }

    return { fullText, steps };
}

function createHiddenHost() {
    const host = document.createElement('div');
    host.setAttribute('data-sb-performance-diagnostics-host', 'true');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:390px;height:844px;overflow:hidden;contain:strict;visibility:hidden;pointer-events:none;';
    document.body.appendChild(host);
    return host;
}

async function measureScrollFps({ durationMs = 1000, stepPx = 24, shouldContinue = () => true } = {}) {
    const scroller = document.getElementById('chat') || document.scrollingElement;
    if (!scroller) {
        return { available: false, reason: 'chat-scroller-unavailable' };
    }

    const previousScrollTop = scroller.scrollTop;
    const frameTimes = [];
    let previous = getNow();
    const start = previous;

    try {
        return await new Promise(resolve => {
            function step(now) {
                if (!shouldContinue()) {
                    resolve({ available: false, reason: 'cancelled' });
                    return;
                }

                frameTimes.push(now - previous);
                previous = now;
                scroller.scrollTop += stepPx;

                if (now - start >= durationMs) {
                    const averageFrame = frameTimes.reduce((total, frame) => total + frame, 0) / Math.max(1, frameTimes.length);
                    resolve({
                        available: true,
                        frames: frameTimes.length,
                        averageFrame,
                        estimatedFps: averageFrame ? 1000 / averageFrame : 0,
                    });
                    return;
                }

                requestAnimationFrame(step);
            }

            requestAnimationFrame(step);
        });
    } finally {
        scroller.scrollTop = previousScrollTop;
    }
}

async function measureDetachedLongChatRender(context, options = {}) {
    if (typeof context.messageFormatting !== 'function') {
        return { available: false, reason: 'message-formatting-unavailable' };
    }

    const shouldContinue = typeof options.shouldContinue === 'function' ? options.shouldContinue : () => true;
    const visibleCount = Number(options.visibleCount) || DEFAULT_RENDER_VISIBLE_COUNT;
    const messages = createLongChatMessages(options).slice(-visibleCount);
    const host = createHiddenHost();

    try {
        const start = getNow();
        for (const message of messages) {
            if (!shouldContinue()) {
                return { available: false, reason: 'cancelled' };
            }

            const messageElement = document.createElement('div');
            messageElement.className = 'mes';
            const textElement = document.createElement('div');
            textElement.className = 'mes_text';
            textElement.innerHTML = context.messageFormatting(message.mes, message.name, message.is_system, message.is_user, -1, {}, false);
            messageElement.appendChild(textElement);
            host.appendChild(messageElement);
        }
        await waitForNextFrame();
        const durationMs = getNow() - start;

        return {
            available: true,
            mode: 'detached-hidden-dom',
            durationMs,
            renderedCount: host.querySelectorAll('.mes').length,
            domNodeCount: host.querySelectorAll('*').length,
            htmlBytes: new TextEncoder().encode(host.innerHTML).length,
            fixture: {
                messageCount: Number(options.messageCount) || DEFAULT_RENDER_MESSAGE_COUNT,
                visibleCount,
                fillerRepeat: Number(options.fillerRepeat) || DEFAULT_RENDER_FILLER_REPEAT,
            },
        };
    } finally {
        host.remove();
    }
}

async function measureDetachedStreamingRender(context, options = {}) {
    if (typeof context.messageFormatting !== 'function') {
        return { available: false, reason: 'message-formatting-unavailable' };
    }

    const shouldContinue = typeof options.shouldContinue === 'function' ? options.shouldContinue : () => true;
    const { steps } = createStreamingSteps(options);
    const host = createHiddenHost();
    const target = document.createElement('div');
    target.className = 'mes_text';
    host.appendChild(target);

    try {
        let formatTotalMs = 0;
        let writeTotalMs = 0;
        let maxStepMs = 0;
        const start = getNow();

        for (const step of steps) {
            if (!shouldContinue()) {
                return { available: false, reason: 'cancelled' };
            }

            const stepStart = getNow();
            const formatStart = getNow();
            const formatted = context.messageFormatting(step, 'Bunny Guide', false, false, -1, {}, false);
            formatTotalMs += getNow() - formatStart;
            const writeStart = getNow();
            target.innerHTML = formatted;
            writeTotalMs += getNow() - writeStart;
            maxStepMs = Math.max(maxStepMs, getNow() - stepStart);
        }

        await waitForNextFrame();
        const totalMs = getNow() - start;

        return {
            available: true,
            mode: 'detached-hidden-dom',
            totalMs,
            formatTotalMs,
            writeTotalMs,
            averageStepMs: totalMs / Math.max(1, steps.length),
            maxStepMs,
            stepCount: steps.length,
            finalHtmlBytes: new TextEncoder().encode(target.innerHTML).length,
            domNodeCount: target.querySelectorAll('*').length,
            codeBlockCount: target.querySelectorAll('pre code').length,
            fixture: {
                stepCount: Number(options.stepCount) || DEFAULT_STREAM_STEP_COUNT,
                fillerRepeat: Number(options.fillerRepeat) || DEFAULT_STREAM_FILLER_REPEAT,
                codeRepeat: Number(options.codeRepeat) || DEFAULT_STREAM_CODE_REPEAT,
            },
        };
    } finally {
        host.remove();
    }
}

function getChatSnapshot() {
    const chatElement = document.getElementById('chat');
    const context = getContext();

    return {
        contextAvailable: Boolean(context),
        chatLength: Array.isArray(context?.chat) ? context.chat.length : null,
        renderedMessages: chatElement ? chatElement.querySelectorAll('.mes').length : null,
        scrollHeight: chatElement?.scrollHeight ?? null,
        clientHeight: chatElement?.clientHeight ?? null,
        scrollTop: chatElement?.scrollTop ?? null,
    };
}

function createSnapshot(label) {
    return {
        label,
        at: getTimestamp(),
        navigation: getNavigationTiming(),
        paint: getPaintTimings(),
        memory: getMemorySnapshot(),
        viewport: getViewportSnapshot(),
        resources: getResourceSnapshot(),
        chat: getChatSnapshot(),
    };
}

function createReportBase(options) {
    return {
        schemaVersion: REPORT_SCHEMA_VERSION,
        kind: 'sillybunny-performance-diagnostics',
        createdAt: getTimestamp(),
        options: serializeDiagnosticValue(options),
        environment: getEnvironmentSnapshot(),
    };
}

function createDownloadName(report) {
    const timestamp = String(report.createdAt || getTimestamp()).replace(/[:.]/g, '-');
    return `sillybunny-performance-${timestamp}.json`;
}

export function downloadPerformanceReport(report = lastReport) {
    if (!report) {
        throw new Error('No performance diagnostics report is available to download.');
    }

    const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = createDownloadName(report);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyPerformanceReport(report = lastReport) {
    if (!report) {
        throw new Error('No performance diagnostics report is available to copy.');
    }

    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
}

function ensurePanel() {
    if (panel) {
        return panel;
    }

    panel = document.createElement('div');
    panel.id = 'sb-performance-diagnostics-panel';
    panel.style.cssText = 'position:fixed;inset:auto 12px 12px 12px;z-index:100000;padding:12px;border:1px solid rgba(255,255,255,.25);border-radius:12px;background:rgba(20,24,32,.96);color:#f4f7fb;font:14px/1.4 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.35);max-height:55dvh;overflow:auto;';
    panel.innerHTML = `
        <strong data-sb-performance-diagnostics-title>Performance Diagnostics</strong>
        <div data-sb-performance-diagnostics-status>Ready.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
            <button type="button" data-sb-performance-diagnostics-stop>Stop Logging</button>
            <button type="button" data-sb-performance-diagnostics-download>Download Report</button>
            <button type="button" data-sb-performance-diagnostics-copy>Copy Report</button>
            <button type="button" data-sb-performance-diagnostics-close>Close</button>
        </div>
        <pre data-sb-performance-diagnostics-summary style="white-space:pre-wrap;max-height:180px;overflow:auto;margin:8px 0 0;"></pre>
    `;
    panel.querySelector('[data-sb-performance-diagnostics-download]')?.addEventListener('click', () => downloadPerformanceReport());
    panel.querySelector('[data-sb-performance-diagnostics-copy]')?.addEventListener('click', () => copyPerformanceReport().catch(error => console.warn('Failed to copy performance diagnostics report.', error)));
    panel.querySelector('[data-sb-performance-diagnostics-stop]')?.addEventListener('click', () => stopPerformanceLogging({ showPanel: true }));
    panel.querySelector('[data-sb-performance-diagnostics-close]')?.addEventListener('click', () => {
        panel?.remove();
        panel = null;
    });
    document.body.appendChild(panel);
    return panel;
}

function updatePanel(status, report = null) {
    const root = ensurePanel();
    const statusElement = root.querySelector('[data-sb-performance-diagnostics-status]');
    const summaryElement = root.querySelector('[data-sb-performance-diagnostics-summary]');
    if (statusElement) {
        statusElement.textContent = status;
    }
    if (summaryElement && report) {
        summaryElement.textContent = JSON.stringify({
            createdAt: report.createdAt,
            environment: report.environment,
            measurements: report.measurements,
            logCounters: report.log?.counters,
        }, null, 2);
    }
}

export function startPerformanceLogging(options = {}) {
    if (!extensionActive) {
        return null;
    }

    if (activeLogger) {
        return activeLogger.getReport();
    }

    const resolvedOptions = {
        showPanel: true,
        captureConsole: false,
        ...options,
    };
    setResourceTimingBufferSize(options.resourceTimingBufferSize || DEFAULT_RESOURCE_TIMING_BUFFER_SIZE);
    activeLogger = createLogger(resolvedOptions);
    activeLogger.start();
    if (resolvedOptions.showPanel) {
        updatePanel('Logging performance events...');
    }
    return activeLogger.getReport();
}

export function stopPerformanceLogging(options = {}) {
    if (!activeLogger) {
        return null;
    }

    const logger = activeLogger;
    activeLogger = null;
    logger.stop();
    const report = {
        ...createReportBase(options),
        kind: 'sillybunny-performance-log',
        snapshots: {
            final: createSnapshot('final'),
        },
        log: logger.getReport(),
    };
    lastReport = report;
    if (options.showPanel !== false) {
        updatePanel('Performance log ready.', report);
    }
    if (options.autoDownload) {
        downloadPerformanceReport(report);
    }
    return report;
}

export function getLastPerformanceReport() {
    return lastReport;
}

export async function runPerformanceDiagnostics(options = {}) {
    if (!extensionActive) {
        return null;
    }

    if (activeDiagnosticsRun) {
        return {
            ...createReportBase(options),
            error: {
                name: 'Error',
                message: 'Performance diagnostics already running.',
            },
        };
    }

    activeDiagnosticsRun = true;
    const runId = ++diagnosticsRunId;
    const resolvedOptions = {
        showPanel: true,
        autoDownload: false,
        captureConsole: false,
        ...options,
    };

    setResourceTimingBufferSize(resolvedOptions.resourceTimingBufferSize || DEFAULT_RESOURCE_TIMING_BUFFER_SIZE);
    if (resolvedOptions.showPanel) {
        updatePanel('Running diagnostics...');
    }

    const logger = createLogger(resolvedOptions);
    activeDiagnosticsLogger = logger;
    logger.start();
    logger.mark('self-test-started');

    const report = createReportBase(resolvedOptions);
    try {
        assertDiagnosticsRunCurrent(runId);
        const { context } = await waitForAppReady(resolvedOptions);
        assertDiagnosticsRunCurrent(runId);
        report.snapshots = {
            before: createSnapshot('before'),
        };
        report.measurements = {
            scrollFps: await measureScrollFps({
                ...resolvedOptions.scroll,
                shouldContinue: () => isDiagnosticsRunCurrent(runId),
            }),
        };
        assertDiagnosticsRunCurrent(runId);
        report.measurements.longChatRender = await measureDetachedLongChatRender(context, {
            ...resolvedOptions.longChat,
            shouldContinue: () => isDiagnosticsRunCurrent(runId),
        });
        assertDiagnosticsRunCurrent(runId);
        report.measurements.streamingRender = await measureDetachedStreamingRender(context, {
            ...resolvedOptions.streaming,
            shouldContinue: () => isDiagnosticsRunCurrent(runId),
        });
        assertDiagnosticsRunCurrent(runId);
        report.snapshots.after = createSnapshot('after');
        logger.mark('self-test-finished');
    } catch (error) {
        report.error = serializeError(error);
        logger.mark('self-test-failed', report.error);
    } finally {
        if (activeDiagnosticsLogger === logger) {
            activeDiagnosticsLogger = null;
        }
        logger.stop();
        activeDiagnosticsRun = false;

        if (extensionActive && runId === diagnosticsRunId) {
            report.log = logger.getReport();
            lastReport = report;
            if (resolvedOptions.showPanel) {
                updatePanel('Diagnostics report ready.', report);
            }
            if (resolvedOptions.autoDownload) {
                downloadPerformanceReport(report);
            }
        }
    }

    return report;
}

export function getPerformanceDiagnosticsUrl(baseUrl = globalThis.location?.href ?? 'http://localhost/') {
    const url = new URL(baseUrl, globalThis.location?.href ?? baseUrl);
    url.searchParams.set('performance-diagnostics', '1');
    return url.toString();
}

function getTriggerOptionsFromLocation() {
    const searchParams = new URLSearchParams(globalThis.location?.search ?? '');
    const hashFlags = new Set(String(globalThis.location?.hash ?? '').replace(/^#/, '').split(/[&/]/).map(value => value.trim()).filter(Boolean));
    const shouldRunDiagnostics = searchParams.has('performance-diagnostics') || hashFlags.has('performance-diagnostics');
    const shouldStartLogging = searchParams.has('performance-logging') || hashFlags.has('performance-logging');

    if (!shouldRunDiagnostics && !shouldStartLogging) {
        return null;
    }

    return {
        runDiagnostics: shouldRunDiagnostics,
        startLogging: shouldStartLogging,
        autoDownload: searchParams.get('performance-diagnostics') === 'download' || searchParams.get('performance-logging') === 'download',
        captureConsole: searchParams.has('performance-console') || hashFlags.has('performance-console'),
    };
}

function exposeDiagnosticsApi() {
    globalThis.SillyBunnyPerformanceDiagnostics ??= {};
    const api = {
        run: runPerformanceDiagnostics,
        startLogging: startPerformanceLogging,
        stopLogging: stopPerformanceLogging,
        download: downloadPerformanceReport,
        getLastReport: getLastPerformanceReport,
        getUrl: getPerformanceDiagnosticsUrl,
    };

    for (const [name, value] of Object.entries(api)) {
        if (!(name in globalThis.SillyBunnyPerformanceDiagnostics)) {
            Object.defineProperty(globalThis.SillyBunnyPerformanceDiagnostics, name, {
                configurable: true,
                enumerable: true,
                value,
            });
        }
    }
}

function removeDiagnosticsApi() {
    const api = globalThis.SillyBunnyPerformanceDiagnostics;
    if (!api) {
        return;
    }

    for (const name of ['run', 'startLogging', 'stopLogging', 'download', 'getLastReport', 'getUrl']) {
        delete api[name];
    }
}

function ensureExtensionPanel() {
    const existing = document.getElementById('sb-performance-diagnostics-extension');
    if (existing) {
        return existing;
    }

    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings') || document.body;
    const root = document.createElement('div');
    root.id = 'sb-performance-diagnostics-extension';
    root.className = 'inline-drawer wide100p flexFlowColumn';
    root.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b><i class="fa-solid fa-gauge-high"></i> <span>Performance Diagnostics</span></b>
            <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="sb-performance-diagnostics-extension-body">
                <p>Measure this browser and export a troubleshooting report.</p>
                <label class="checkbox_label">
                    <input type="checkbox" data-sb-performance-diagnostics-console>
                    <span>Capture console activity</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" data-sb-performance-diagnostics-download>
                    <span>Download report when finished</span>
                </label>
                <div class="flex-container flexGap5 flexWrap">
                    <button type="button" class="menu_button" data-sb-performance-diagnostics-run>Run Self-Test</button>
                    <button type="button" class="menu_button" data-sb-performance-diagnostics-start>Start Logging</button>
                    <button type="button" class="menu_button" data-sb-performance-diagnostics-stop>Stop Logging</button>
                    <button type="button" class="menu_button" data-sb-performance-diagnostics-copy>Copy Report</button>
                    <button type="button" class="menu_button" data-sb-performance-diagnostics-save>Download Report</button>
                </div>
                <pre data-sb-performance-diagnostics-extension-summary></pre>
            </div>
        </div>
    `;
    host.appendChild(root);
    return root;
}

function getPanelOptions(root) {
    return {
        showPanel: true,
        captureConsole: Boolean(root.querySelector('[data-sb-performance-diagnostics-console]')?.checked),
        autoDownload: Boolean(root.querySelector('[data-sb-performance-diagnostics-download]')?.checked),
    };
}

function setExtensionSummary(root, report) {
    const summary = root.querySelector('[data-sb-performance-diagnostics-extension-summary]');
    if (!summary) {
        return;
    }

    if (!report) {
        summary.textContent = 'No report yet.';
        return;
    }

    summary.textContent = JSON.stringify({
        createdAt: report.createdAt,
        kind: report.kind,
        measurements: report.measurements,
        logCounters: report.log?.counters,
        error: report.error,
    }, null, 2);
}

function bindExtensionPanel(root) {
    root.querySelector('[data-sb-performance-diagnostics-run]')?.addEventListener('click', async () => {
        setExtensionSummary(root, null);
        setExtensionSummary(root, await runPerformanceDiagnostics(getPanelOptions(root)));
    });
    root.querySelector('[data-sb-performance-diagnostics-start]')?.addEventListener('click', () => {
        startPerformanceLogging(getPanelOptions(root));
        setExtensionSummary(root, { kind: 'sillybunny-performance-log-active', createdAt: getTimestamp() });
    });
    root.querySelector('[data-sb-performance-diagnostics-stop]')?.addEventListener('click', () => {
        setExtensionSummary(root, stopPerformanceLogging(getPanelOptions(root)) ?? getLastPerformanceReport());
    });
    root.querySelector('[data-sb-performance-diagnostics-copy]')?.addEventListener('click', () => copyPerformanceReport().catch(error => console.warn('Failed to copy performance diagnostics report.', error)));
    root.querySelector('[data-sb-performance-diagnostics-save]')?.addEventListener('click', () => downloadPerformanceReport());
}

function addExtensionsMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('sb_performance_diagnostics_wand')) {
        return;
    }

    const button = document.createElement('div');
    button.id = 'sb_performance_diagnostics_wand';
    button.className = 'list-group-item flex-container flexGap5 interactable';
    button.tabIndex = 0;
    button.innerHTML = '<i class="fa-solid fa-gauge-high extensionsMenuExtensionButton"></i><span>Run Performance Diagnostics</span>';
    button.addEventListener('click', () => runPerformanceDiagnostics({ showPanel: true }));
    menu.appendChild(button);
}

async function handleLocationTriggers() {
    const triggerOptions = getTriggerOptionsFromLocation();
    if (!triggerOptions) {
        return;
    }

    if (triggerOptions.startLogging) {
        startPerformanceLogging(triggerOptions);
    }
    if (triggerOptions.runDiagnostics) {
        await runPerformanceDiagnostics(triggerOptions);
    }
}

export function init() {
    extensionActive = true;
    exposeDiagnosticsApi();
    const root = ensureExtensionPanel();
    bindExtensionPanel(root);
    addExtensionsMenuButton();
    handleLocationTriggers().catch(error => console.error('Failed to start SillyBunny performance diagnostics.', error));
}

export function disable() {
    extensionActive = false;
    diagnosticsRunId++;
    activeDiagnosticsRun = false;
    activeDiagnosticsLogger?.stop();
    activeDiagnosticsLogger = null;
    if (activeLogger) {
        stopPerformanceLogging({ showPanel: false });
    }
    document.getElementById('sb-performance-diagnostics-extension')?.remove();
    document.getElementById('sb_performance_diagnostics_wand')?.remove();
    panel?.remove();
    panel = null;
    removeDiagnosticsApi();
}
