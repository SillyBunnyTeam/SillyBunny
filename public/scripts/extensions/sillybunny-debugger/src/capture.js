/**
 * Always-on error/log capture. Console methods, window errors, unhandled
 * rejections and failed network requests land in fixed-size ring buffers
 * that feed the diagnostic report.
 *
 * The shared wrappers stay installed so later tooling can safely chain on top.
 * deactivate() stops recording and clears captured data.
 */

const CONSOLE_LIMIT = 500;
const REQUEST_LIMIT = 50;
const TEXT_LIMIT = 500;
const ENTRY_LIMIT = 1000;
const STACK_LIMIT = 2000;
const STACK_LINES = 10;
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'];
const REDACTED = '[redacted]';
const TEXT_REDACTED = '[text redacted]';
const STRUCTURED_REDACTED = '[structured data redacted]';
const UNSUPPORTED_URL = '[unsupported URL]';
const SAFE_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
const SAFE_ERROR_NAMES = new Set([
    'AbortError', 'AggregateError', 'DataCloneError', 'Error', 'EvalError',
    'IndexSizeError', 'InvalidCharacterError', 'InvalidModificationError',
    'InvalidStateError', 'NamespaceError', 'NetworkError', 'NotAllowedError',
    'NotFoundError', 'NotReadableError', 'NotSupportedError', 'OperationError',
    'QuotaExceededError', 'RangeError', 'ReferenceError', 'SecurityError',
    'SuppressedError', 'SyntaxError', 'TimeoutError', 'TypeError', 'URIError',
]);
const STACK_LOCATION_PATTERN = /((?:[a-z][a-z\d+.-]*:\/\/|\/)[^\s()]*)\)?$/i;

export function createRing(limit) {
    const items = [];
    let start = 0;
    return {
        push(item) {
            if (items.length < limit) {
                items.push(item);
            } else {
                items[start] = item;
                start = (start + 1) % limit;
            }
        },
        entries() {
            return items.slice(start).concat(items.slice(0, start));
        },
        clear() {
            items.length = 0;
            start = 0;
        },
    };
}

function truncate(text, limit = TEXT_LIMIT) {
    const value = String(text);
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function cropStack(stack) {
    const lines = String(stack ?? '').split('\n');
    const firstLine = lines[0]?.trim() ?? '';
    const firstIsFrame = STACK_LOCATION_PATTERN.test(firstLine)
        && (/^at\s/i.test(firstLine) || firstLine.includes('@') || /^(?:[a-z][a-z\d+.-]*:\/\/|\/)/i.test(firstLine));
    const start = firstIsFrame ? 0 : 1;
    const frames = lines.slice(start, start + STACK_LINES);
    const sanitized = frames.map((frame) => {
        const trimmed = frame.trim();
        const locationMatch = trimmed.match(STACK_LOCATION_PATTERN);
        if (!locationMatch) return '    at [frame redacted]';

        return `    at ${sanitizeUrl(locationMatch[1])}`;
    }).join('\n');
    return truncate(sanitized, STACK_LIMIT);
}

export function redactSensitiveText(value) {
    const sample = String(value ?? '').slice(0, 256).trimStart();
    const structured = sample.startsWith('{')
        || /^\[\s*(?:[[{"\d-]|true\b|false\b|null\b)/.test(sample);
    return structured ? STRUCTURED_REDACTED : TEXT_REDACTED;
}

export function sanitizeMethod(value) {
    const method = String(value ?? '').toUpperCase();
    return SAFE_METHODS.has(method) ? method : 'OTHER';
}

function safeErrorName(value) {
    const name = String(value || 'Error');
    return SAFE_ERROR_NAMES.has(name) ? name : 'Error';
}

function getErrorDetails(value) {
    try {
        const isDomException = typeof DOMException !== 'undefined' && value instanceof DOMException;
        if (!(value instanceof Error) && !isDomException) return null;
        return {
            name: safeErrorName(value.name),
            stack: typeof value.stack === 'string' ? value.stack : '',
        };
    } catch {
        return null;
    }
}

export function serializeArg(value) {
    if (typeof value === 'string') {
        return redactSensitiveText(value);
    }
    const error = getErrorDetails(value);
    if (error) {
        return `${error.name}: [message redacted]`;
    }
    if (value === null) return '[null]';
    if (value && typeof value === 'object') {
        // Do not inspect application objects: getters, proxies and toJSON can execute code.
        return '[object]';
    }
    return `[${typeof value}]`;
}

/** Builds one ring entry from console-style arguments. Pure. */
export function makeEntry(kind, args, ts = Date.now(), stack) {
    return {
        ts,
        kind,
        text: truncate(args.map(serializeArg).join(' '), ENTRY_LIMIT),
        stack: stack ? cropStack(stack) : undefined,
    };
}

export function isFailedStatus(status) {
    return status >= 400;
}

const entries = createRing(CONSOLE_LIMIT);
const requests = createRing(REQUEST_LIMIT);
const counters = { total: 0 };
const xhrRequests = new WeakMap();
let installed = false;
let recording = false;
let captureGeneration = 0;

function record(kind, args, stack) {
    if (!recording) {
        return;
    }
    try {
        const error = args.map(getErrorDetails).find(Boolean);
        counters.total += 1;
        entries.push(makeEntry(kind, args, Date.now(), stack || error?.stack));
    } catch {
        // Capture must never break the app.
    }
}

function recordSafe(kind, text, stack) {
    if (!recording) return;
    counters.total += 1;
    entries.push({
        ts: Date.now(),
        kind,
        text: truncate(text, ENTRY_LIMIT),
        stack: stack ? cropStack(stack) : undefined,
    });
}

export function sanitizeUrl(value) {
    try {
        const raw = String(value);
        if (!raw) return '[missing URL]';
        if (raw === UNSUPPORTED_URL) return raw;
        const absolute = /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//');
        const url = new URL(raw, globalThis.location?.href ?? 'http://localhost');
        if (!['http:', 'https:'].includes(url.protocol)) {
            return UNSUPPORTED_URL;
        }
        url.username = '';
        url.password = '';
        const pathname = url.pathname === '/' ? '/' : `/${REDACTED}`;
        const path = `${pathname}${url.search ? '?[redacted]' : ''}`;
        return truncate(absolute ? `${url.origin}${path}` : path);
    } catch {
        return '[invalid URL]';
    }
}

function recordRequest(method, sanitizedUrl, status, generation) {
    if (!recording || generation !== captureGeneration) {
        return;
    }
    requests.push({ ts: Date.now(), method, url: sanitizedUrl, status });
}

export function getEntries() {
    return entries.entries();
}

export function getRequests() {
    return requests.entries();
}

export function getCounters() {
    return { ...counters };
}

export function disableCapture() {
    captureGeneration += 1;
    recording = false;
    entries.clear();
    requests.clear();
    counters.total = 0;
}

export function installCapture() {
    if (!recording) captureGeneration += 1;
    recording = true;
    if (installed || typeof window === 'undefined') {
        return;
    }
    const undo = [];
    try {
        for (const method of CONSOLE_METHODS) {
            const original = console[method];
            const wrapped = (...args) => {
                record(method, args);
                Reflect.apply(original, console, args);
            };
            console[method] = wrapped;
            undo.push(() => {
                if (console[method] === wrapped) console[method] = original;
            });
        }

        // Capture phase so failed <img>/<script>/<link> loads are seen too.
        const onError = (event) => {
            if (event.target && event.target !== window && !(event instanceof ErrorEvent)) {
                const source = sanitizeUrl(event.target.src ?? event.target.href ?? '');
                const nodeName = String(event.target.nodeName || 'resource').toLowerCase().replace(/[^a-z-]/g, '') || 'resource';
                recordSafe('resource-error', `${nodeName} failed to load: ${source}`);
                return;
            }
            const location = event.filename ? ` (${sanitizeUrl(event.filename)})` : '';
            const error = getErrorDetails(event.error);
            if (error) record('window-error', [event.error], error.stack);
            else recordSafe('window-error', `Script error${location}`);
        };
        const onRejection = (event) => {
            const error = getErrorDetails(event.reason);
            if (error) record('rejection', [event.reason], error.stack);
            else recordSafe('rejection', 'Non-Error rejection reason redacted');
        };
        window.addEventListener('error', onError, true);
        window.addEventListener('unhandledrejection', onRejection);
        undo.push(() => window.removeEventListener('error', onError, true));
        undo.push(() => window.removeEventListener('unhandledrejection', onRejection));

        const nativeFetch = window.fetch;
        const wrappedFetch = function (input, options) {
            const generation = captureGeneration;
            const method = sanitizeMethod(options?.method ?? input?.method ?? 'GET');
            const url = sanitizeUrl(typeof input === 'string' ? input : input?.url ?? String(input));
            return Reflect.apply(nativeFetch, this, [input, options]).then(
                (response) => {
                    if (isFailedStatus(response.status)) recordRequest(method, url, response.status, generation);
                    return response;
                },
                (error) => {
                    if (!(typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')) {
                        recordRequest(method, url, 0, generation);
                    }
                    throw error;
                },
            );
        };
        window.fetch = wrappedFetch;
        undo.push(() => {
            if (window.fetch === wrappedFetch) window.fetch = nativeFetch;
        });

        // The host still drives plenty of traffic through jQuery, hence XHR too.
        const nativeOpen = XMLHttpRequest.prototype.open;
        const wrappedOpen = function (method, url, ...rest) {
            xhrRequests.set(this, { method: sanitizeMethod(method), url: sanitizeUrl(url) });
            return Reflect.apply(nativeOpen, this, [method, url, ...rest]);
        };
        XMLHttpRequest.prototype.open = wrappedOpen;
        undo.push(() => {
            if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = nativeOpen;
        });

        const nativeSend = XMLHttpRequest.prototype.send;
        const wrappedSend = function (...args) {
            const request = xhrRequests.get(this);
            const generation = captureGeneration;
            const cleanup = () => {
                xhrRequests.delete(this);
                this.removeEventListener('load', onLoad);
                this.removeEventListener('error', onFailure);
                this.removeEventListener('timeout', onFailure);
                this.removeEventListener('abort', cleanup);
            };
            const onLoad = () => {
                cleanup();
                if (request && this.status >= 400) recordRequest(request.method, request.url, this.status, generation);
            };
            const onFailure = () => {
                cleanup();
                if (request) recordRequest(request.method, request.url, 0, generation);
            };
            this.addEventListener('load', onLoad);
            this.addEventListener('error', onFailure);
            this.addEventListener('timeout', onFailure);
            this.addEventListener('abort', cleanup);
            try {
                return Reflect.apply(nativeSend, this, args);
            } catch (error) {
                cleanup();
                throw error;
            }
        };
        XMLHttpRequest.prototype.send = wrappedSend;
        undo.push(() => {
            if (XMLHttpRequest.prototype.send === wrappedSend) XMLHttpRequest.prototype.send = nativeSend;
        });
        installed = true;
    } catch (error) {
        recording = false;
        for (const restore of undo.reverse()) {
            try {
                restore();
            } catch {
                // Keep rolling back the remaining hooks.
            }
        }
        throw error;
    }
}
