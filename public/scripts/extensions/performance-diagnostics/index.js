const REPORT_SCHEMA_VERSION = 2;
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
let initialized = false;
let activeDiagnosticsRun = null;
const SENSITIVE_DIAGNOSTIC_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|token|secret|password|authorization|cookie|credential|session)/i;
const PRIVATE_DIAGNOSTIC_KEY_PATTERN = /^(?:host(?:[_-]?name)?|origin|path(?:[_-]?name)?|file(?:[_-]?name)?|avatar(?:[_-]?(?:id|name))?|media(?:[_-]?(?:id|name))?|user(?:[_-]?(?:id|name))?)$/i;
const SENSITIVE_STRING_KEY_SOURCE = '(?:[a-z0-9_-]{0,64}(?:api[_-]?key|access[_-]?token|token|secret|password|cookie|credential|session)[a-z0-9_-]{0,64}|authorization|proxy[_-]?authorization)';

function getNow() {
    return performance.now();
}

function getTimestamp() {
    return new Date().toISOString();
}

function getLocationHref() {
    return globalThis.location?.href ?? 'http://localhost/';
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
            name: redactDiagnosticString(readErrorProperty(value, 'name', 'Error')),
            message: redactDiagnosticString(readErrorProperty(value, 'message', '')),
            stack: redactDiagnosticString(readErrorProperty(value, 'stack', '')).slice(0, 1500),
        };
    }

    if (typeof value !== 'object') {
        return String(value);
    }

    if (seen.has(value)) {
        return '[circular]';
    }

    if (depth >= 2) {
        try {
            return Object.prototype.toString.call(value);
        } catch (error) {
            return `[unserializable: ${redactDiagnosticString(getErrorMessage(error))}]`;
        }
    }

    seen.add(value);

    if (Array.isArray(value)) {
        const result = [];
        for (let index = 0; index < Math.min(value.length, 10); index++) {
            try {
                result.push(serializeDiagnosticValue(value[index], { depth: depth + 1, seen }));
            } catch (error) {
                result.push(`[unserializable: ${redactDiagnosticString(getErrorMessage(error))}]`);
            }
        }
        return result;
    }

    const result = {};
    let keys;
    try {
        keys = Object.keys(value).slice(0, 12);
    } catch (error) {
        return `[unserializable: ${redactDiagnosticString(getErrorMessage(error))}]`;
    }

    for (const key of keys) {
        const sanitizedKeyBase = redactDiagnosticString(key).slice(0, 100);
        let sanitizedKey = sanitizedKeyBase;
        let duplicateIndex = 2;
        while (Object.hasOwn(result, sanitizedKey)) {
            sanitizedKey = `${sanitizedKeyBase}-${duplicateIndex++}`;
        }
        try {
            result[sanitizedKey] = SENSITIVE_DIAGNOSTIC_KEY_PATTERN.test(key) || PRIVATE_DIAGNOSTIC_KEY_PATTERN.test(key)
                ? '[redacted]'
                : serializeDiagnosticValue(value[key], { depth: depth + 1, seen });
        } catch (error) {
            result[sanitizedKey] = `[unserializable: ${redactDiagnosticString(getErrorMessage(error))}]`;
        }
    }

    return result;
}

function getErrorMessage(error) {
    try {
        return String(error?.message ?? error);
    } catch {
        return 'unavailable';
    }
}

function readErrorProperty(error, key, fallback) {
    try {
        const value = error?.[key];
        return value === undefined || value === null ? fallback : String(value);
    } catch (getterError) {
        return `[unreadable: ${redactDiagnosticString(getErrorMessage(getterError))}]`;
    }
}

function decodePercentEncodedDiagnosticString(value) {
    let result = String(value);

    for (let pass = 0; pass < 2; pass++) {
        const decoded = result.replace(/(?:%[0-9a-f]{2})+/gi, sequence => {
            try {
                return decodeURIComponent(sequence);
            } catch {
                return sequence;
            }
        });
        if (decoded === result) {
            break;
        }
        result = decoded;
    }

    return result;
}

function formatEmbeddedUrlForReport(rawUrl) {
    const metadata = sanitizeUrlForReport(rawUrl);
    const queryMetadata = metadata.queryParameterCount > 0 ? `:query-count(${metadata.queryParameterCount})` : '';
    return `[url:${metadata.origin}:${metadata.protocol || 'unknown'}:${metadata.category}:${metadata.extension || 'none'}${queryMetadata}]`;
}

function redactEmbeddedUrls(value, replaceUrl) {
    return String(value)
        .replace(/\b[a-z][a-z0-9+.-]*(?::|%3a)(?:(?:\/|%2f){2})[^\s<>"']+/gi, match => replaceUrl(decodePercentEncodedDiagnosticString(match)))
        .replace(/\b(?:blob|data)(?::|%3a)[^\s<>"']+/gi, match => replaceUrl(decodePercentEncodedDiagnosticString(match)))
        .replace(/(^|[\s("'=])((?:%2f){1,2}[^\s<>"']+)/gim, (_, prefix, url) => `${prefix}${replaceUrl(decodePercentEncodedDiagnosticString(url))}`)
        .replace(/(^|[\s("'=])(\/{1,2}[^\s<>"']+)/gm, (_, prefix, url) => `${prefix}${replaceUrl(url)}`);
}

function redactDiagnosticString(value) {
    const quotedDoubleValuePattern = new RegExp(`((?:"?${SENSITIVE_STRING_KEY_SOURCE}"?)\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi');
    const quotedSingleValuePattern = new RegExp(`((?:'?${SENSITIVE_STRING_KEY_SOURCE}'?)\\s*:\\s*)'(?:\\\\.|[^'\\\\])*'`, 'gi');
    const unquotedValuePattern = new RegExp(`\\b(${SENSITIVE_STRING_KEY_SOURCE})(\\s*[:=]\\s*)([^,\\r\\n;&}#]+)`, 'gi');
    const urls = [];
    const replaceUrl = (rawUrl) => {
        const index = urls.push(formatEmbeddedUrlForReport(rawUrl)) - 1;
        return `__SB_DIAGNOSTIC_URL_${index}__`;
    };
    let result = redactEmbeddedUrls(value, replaceUrl);
    result = decodePercentEncodedDiagnosticString(result);
    result = redactEmbeddedUrls(result, replaceUrl);

    result = result
        .replace(quotedDoubleValuePattern, '$1"[redacted]"')
        .replace(quotedSingleValuePattern, '$1\'[redacted]\'')
        .replace(/\b((?:authorization|proxy-authorization)\s*:\s*)(?:basic|bearer)\s+[^\s,;]+/gi, '$1[redacted]')
        .replace(/\b((?:basic|bearer)\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
        .replace(/\b((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, '$1[redacted]')
        .replace(unquotedValuePattern, '$1$2[redacted]')
        .replace(/([?&][^=?&#\s]+)=([^&#\s]*)/g, '$1=[redacted]')
        .replace(/\b((?:host|origin|referer)\s*:\s*)[^\s,;]+/gi, '$1[redacted]')
        .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '[path]')
        .replace(/(^|[\s("'=])((?:\.{0,2}[\\/])?(?:[a-z0-9_@.-]+[\\/])+[a-z0-9_@.-]+(?::\d+){0,2})/gim, '$1[path]')
        .replace(/\[[0-9a-f:]+\](?::\d{1,5})?/gi, '[host]')
        .replace(/\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?::\d{1,5})?\b/gi, '[host]');

    return result.replace(/__SB_DIAGNOSTIC_URL_(\d+)__/g, (_, index) => urls[Number(index)] ?? '[url]');
}

function serializeError(error) {
    let value = error;
    for (const key of ['error', 'reason']) {
        try {
            if (error?.[key] !== undefined && error[key] !== null) {
                value = error[key];
                break;
            }
        } catch (getterError) {
            value = new Error(readErrorProperty(getterError, 'message', ''));
            break;
        }
    }
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
    let protocol = String(locationObject.protocol || '');
    if (!protocol) {
        try {
            protocol = new URL(locationObject.href || getLocationHref()).protocol;
        } catch {
            protocol = '';
        }
    }

    return {
        protocol,
        queryParameterCount: Array.from(params.keys()).length,
    };
}

function summarizeConsoleArgs(args) {
    return args.slice(0, 8).map((arg) => {
        if (arg instanceof Error) {
            return {
                type: 'error',
                name: redactDiagnosticString(readErrorProperty(arg, 'name', 'Error')),
                message: redactDiagnosticString(readErrorProperty(arg, 'message', '')),
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
            let keys = [];
            try {
                keys = Object.keys(arg).slice(0, 8).map(key => redactDiagnosticString(key).slice(0, 100));
            } catch {
                keys = ['[unavailable]'];
            }
            return {
                type: Array.isArray(arg) ? 'array' : 'object',
                keys,
            };
        }

        return {
            type: typeof arg,
        };
    });
}

export function sanitizeUrlForReport(rawUrl, baseUrl = getLocationHref(), initiatorType = '') {
    try {
        const base = new URL(baseUrl, getLocationHref());
        const url = new URL(String(rawUrl), base);
        const extensionMatch = url.pathname.match(/\.([a-z0-9]{1,12})$/i);
        const extension = extensionMatch?.[1]?.toLowerCase() ?? '';

        return {
            origin: url.origin === base.origin ? 'same-origin' : 'cross-origin',
            protocol: url.protocol,
            category: getResourceCategory(extension, initiatorType),
            extension,
            queryParameterCount: Array.from(url.searchParams.keys()).length,
        };
    } catch {
        return {
            origin: 'unknown',
            protocol: '',
            category: 'other',
            extension: '',
            queryParameterCount: 0,
        };
    }
}

function clonePerformanceEntry(entry) {
    const sanitizedUrl = sanitizeUrlForReport(entry.name, getLocationHref(), entry.initiatorType);
    const result = {
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

function getResourceCategory(extension, initiatorType = '') {
    if (['js', 'mjs', 'cjs'].includes(extension)) {
        return 'script';
    }
    if (extension === 'css') {
        return 'style';
    }
    if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(extension)) {
        return 'font';
    }
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'avif'].includes(extension)) {
        return 'image';
    }
    if (['mp3', 'wav', 'ogg', 'm4a', 'mp4', 'webm'].includes(extension)) {
        return 'media';
    }
    if (['html', 'htm'].includes(extension)) {
        return 'document';
    }
    if (['json', 'xml'].includes(extension)) {
        return 'data';
    }
    if (extension) {
        return 'other';
    }

    switch (String(initiatorType).toLowerCase()) {
        case 'script':
            return 'script';
        case 'css':
        case 'link':
            return 'style';
        case 'font':
            return 'font';
        case 'image':
        case 'img':
            return 'image';
        case 'audio':
        case 'video':
            return 'media';
        case 'document':
        case 'iframe':
        case 'navigation':
            return 'document';
        case 'beacon':
        case 'fetch':
        case 'xmlhttprequest':
            return 'data';
        default:
            return 'other';
    }
}

function getResourceAssetType(entry) {
    const category = entry.url?.category
        ?? sanitizeUrlForReport(entry.name, getLocationHref(), entry.initiatorType).category;

    switch (category) {
        case 'script':
            return 'js';
        case 'style':
            return 'css';
        case 'font':
            return 'font';
        case 'image':
            return 'image';
        default:
            return 'other';
    }
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
        totals[getResourceAssetType(entry)] += bytes;
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
        url: sanitizeUrlForReport(getLocationHref(), getLocationHref(), 'document'),
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
        if (isStopped) {
            return;
        }

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

        stoppedAt = getTimestamp();
        push('logger-stopped');
        isStopped = true;
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

function createDiagnosticsCancelledError() {
    const error = new Error('Performance diagnostics cancelled.');
    error.name = 'AbortError';
    return error;
}

function throwIfDiagnosticsAborted(signal) {
    if (signal?.aborted) {
        throw createDiagnosticsCancelledError();
    }
}

function isDiagnosticsRunCurrent(run) {
    return extensionActive && activeDiagnosticsRun === run && !run.controller.signal.aborted;
}

function assertDiagnosticsRunCurrent(run) {
    if (!isDiagnosticsRunCurrent(run)) {
        throw createDiagnosticsCancelledError();
    }
}

function waitForDelay(delayMs, signal) {
    return new Promise((resolve, reject) => {
        throwIfDiagnosticsAborted(signal);
        let timeoutId;
        const onAbort = () => {
            clearTimeout(timeoutId);
            signal?.removeEventListener?.('abort', onAbort);
            reject(createDiagnosticsCancelledError());
        };
        timeoutId = setTimeout(() => {
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
        }, delayMs);
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

function waitForNextFrame(signal) {
    return new Promise((resolve, reject) => {
        throwIfDiagnosticsAborted(signal);
        let settled = false;
        let firstFrame;
        let secondFrame;

        const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
        const finish = (callback, value) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            callback(value);
        };
        const onAbort = () => {
            globalThis.cancelAnimationFrame?.(firstFrame);
            globalThis.cancelAnimationFrame?.(secondFrame);
            finish(reject, createDiagnosticsCancelledError());
        };

        signal?.addEventListener?.('abort', onAbort, { once: true });
        firstFrame = requestAnimationFrame(() => {
            if (signal?.aborted) {
                onAbort();
                return;
            }
            secondFrame = requestAnimationFrame(() => finish(resolve));
        });
    });
}

async function waitForAppReady({ timeoutMs = 60000, signal } = {}) {
    const started = getNow();

    while (getNow() - started < timeoutMs) {
        throwIfDiagnosticsAborted(signal);
        const preloaderGone = document.getElementById('preloader') === null;
        const context = getContext();
        const chatElement = document.getElementById('chat');
        if (preloaderGone && context && chatElement instanceof HTMLElement) {
            return { context, chatElement };
        }
        await waitForDelay(100, signal);
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

export async function measureScrollFps({ durationMs = 1000, stepPx = 24, signal } = {}) {
    throwIfDiagnosticsAborted(signal);
    const scroller = document.getElementById('chat') || document.scrollingElement;
    if (!scroller) {
        return { available: false, reason: 'chat-scroller-unavailable', scrollRange: 0, movedPixels: 0 };
    }

    const measuredScrollRange = Number(scroller.scrollHeight) - Number(scroller.clientHeight);
    const scrollRange = Number.isFinite(measuredScrollRange) ? Math.max(0, measuredScrollRange) : 0;
    if (scrollRange <= 0) {
        return { available: false, reason: 'not-scrollable', scrollRange, movedPixels: 0 };
    }

    const previousScrollTop = Number(scroller.scrollTop) || 0;
    const startScrollTop = Math.min(scrollRange, Math.max(0, previousScrollTop));
    const downwardRange = scrollRange - startScrollTop;
    const upwardRange = startScrollTop;
    let direction = downwardRange >= upwardRange ? 1 : -1;
    const initialDirection = direction > 0 ? 'down' : 'up';
    const scrollStep = Math.max(1, Math.abs(Number(stepPx) || 24));
    const frameTimes = [];
    let movedPixels = 0;
    let previous = getNow();
    const start = previous;

    try {
        return await new Promise((resolve, reject) => {
            let frameId;
            let settled = false;
            const finish = (callback, value) => {
                if (settled) {
                    return;
                }
                settled = true;
                signal?.removeEventListener?.('abort', onAbort);
                callback(value);
            };
            const onAbort = () => {
                globalThis.cancelAnimationFrame?.(frameId);
                finish(reject, createDiagnosticsCancelledError());
            };

            function step(now) {
                if (signal?.aborted) {
                    onAbort();
                    return;
                }

                frameTimes.push(now - previous);
                previous = now;
                const before = Number(scroller.scrollTop) || 0;
                let next = Math.min(scrollRange, Math.max(0, before + (direction * scrollStep)));
                if (next === before) {
                    direction *= -1;
                    next = Math.min(scrollRange, Math.max(0, before + (direction * scrollStep)));
                }
                scroller.scrollTop = next;
                const after = Number(scroller.scrollTop) || 0;
                movedPixels += Math.abs(after - before);

                if (now - start >= durationMs) {
                    const averageFrame = frameTimes.reduce((total, frame) => total + frame, 0) / Math.max(1, frameTimes.length);
                    const result = {
                        available: movedPixels > 0,
                        frames: frameTimes.length,
                        averageFrame,
                        estimatedFps: averageFrame ? 1000 / averageFrame : 0,
                        scrollRange,
                        direction: initialDirection,
                        startScrollTop,
                        endScrollTop: after,
                        movedPixels,
                    };
                    if (movedPixels <= 0) {
                        result.reason = 'no-scroll-movement';
                    }
                    finish(resolve, result);
                    return;
                }

                frameId = requestAnimationFrame(step);
            }

            signal?.addEventListener?.('abort', onAbort, { once: true });
            frameId = requestAnimationFrame(step);
        });
    } finally {
        scroller.scrollTop = previousScrollTop;
    }
}

async function measureDetachedLongChatRender(context, options = {}) {
    if (typeof context.messageFormatting !== 'function') {
        return { available: false, reason: 'message-formatting-unavailable' };
    }

    const signal = options.signal;
    throwIfDiagnosticsAborted(signal);
    const visibleCount = Number(options.visibleCount) || DEFAULT_RENDER_VISIBLE_COUNT;
    const messages = createLongChatMessages(options).slice(-visibleCount);
    const host = createHiddenHost();

    try {
        const start = getNow();
        for (const message of messages) {
            throwIfDiagnosticsAborted(signal);

            const messageElement = document.createElement('div');
            messageElement.className = 'mes';
            const textElement = document.createElement('div');
            textElement.className = 'mes_text';
            textElement.innerHTML = context.messageFormatting(message.mes, message.name, message.is_system, message.is_user, -1, {}, false);
            messageElement.appendChild(textElement);
            host.appendChild(messageElement);
        }
        await waitForNextFrame(signal);
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

    const signal = options.signal;
    throwIfDiagnosticsAborted(signal);
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
            throwIfDiagnosticsAborted(signal);

            const stepStart = getNow();
            const formatStart = getNow();
            const formatted = context.messageFormatting(step, 'Bunny Guide', false, false, -1, {}, false);
            formatTotalMs += getNow() - formatStart;
            const writeStart = getNow();
            target.innerHTML = formatted;
            writeTotalMs += getNow() - writeStart;
            maxStepMs = Math.max(maxStepMs, getNow() - stepStart);
        }

        await waitForNextFrame(signal);
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

export async function copyPerformanceReport(report = lastReport) {
    if (!report) {
        throw new Error('No performance diagnostics report is available to copy.');
    }

    const text = JSON.stringify(report, null, 2);
    if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    try {
        textarea.select();
        document.execCommand('copy');
    } finally {
        textarea.remove();
    }
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
    if (!extensionActive || activeDiagnosticsRun) {
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

    if (activeLogger) {
        return {
            ...createReportBase(options),
            error: {
                name: 'InvalidStateError',
                message: 'performance-logging-active',
            },
        };
    }

    const run = {
        controller: new AbortController(),
        logger: null,
    };
    activeDiagnosticsRun = run;
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
    run.logger = logger;
    logger.start();
    logger.mark('self-test-started');

    const report = createReportBase(resolvedOptions);
    try {
        assertDiagnosticsRunCurrent(run);
        const { context } = await waitForAppReady({
            ...resolvedOptions,
            signal: run.controller.signal,
        });
        assertDiagnosticsRunCurrent(run);
        report.snapshots = {
            before: createSnapshot('before'),
        };
        report.measurements = {
            scrollFps: await measureScrollFps({
                ...resolvedOptions.scroll,
                signal: run.controller.signal,
            }),
        };
        assertDiagnosticsRunCurrent(run);
        report.measurements.longChatRender = await measureDetachedLongChatRender(context, {
            ...resolvedOptions.longChat,
            signal: run.controller.signal,
        });
        assertDiagnosticsRunCurrent(run);
        report.measurements.streamingRender = await measureDetachedStreamingRender(context, {
            ...resolvedOptions.streaming,
            signal: run.controller.signal,
        });
        assertDiagnosticsRunCurrent(run);
        report.snapshots.after = createSnapshot('after');
        logger.mark('self-test-finished');
    } catch (error) {
        report.error = serializeError(error);
        logger.mark('self-test-failed', report.error);
    } finally {
        logger.stop();
        report.log = logger.getReport();
        const ownsRun = activeDiagnosticsRun === run;
        if (ownsRun) {
            activeDiagnosticsRun = null;
        }

        if (extensionActive && ownsRun && !run.controller.signal.aborted) {
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
        const report = startPerformanceLogging(getPanelOptions(root));
        if (report) {
            setExtensionSummary(root, { kind: 'sillybunny-performance-log-active', createdAt: getTimestamp() });
        }
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

    if (triggerOptions.runDiagnostics) {
        await runPerformanceDiagnostics(triggerOptions);
    } else if (triggerOptions.startLogging) {
        startPerformanceLogging(triggerOptions);
    }
}

export function init() {
    if (initialized) {
        return;
    }

    initialized = true;
    extensionActive = true;
    exposeDiagnosticsApi();
    const root = ensureExtensionPanel();
    bindExtensionPanel(root);
    addExtensionsMenuButton();
    handleLocationTriggers().catch(error => console.error('Failed to start SillyBunny performance diagnostics.', error));
}

export function disable() {
    initialized = false;
    extensionActive = false;
    const diagnosticsRun = activeDiagnosticsRun;
    activeDiagnosticsRun = null;
    diagnosticsRun?.controller.abort();
    diagnosticsRun?.logger?.stop();
    if (activeLogger) {
        stopPerformanceLogging({ showPanel: false });
    }
    document.getElementById('sb-performance-diagnostics-extension')?.remove();
    document.getElementById('sb_performance_diagnostics_wand')?.remove();
    panel?.remove();
    panel = null;
    removeDiagnosticsApi();
}
