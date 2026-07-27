import { readResponseText } from "./security.js";

function abortWithReason(controller, reason) {
    try {
        controller.abort(reason);
    } catch {
        controller.abort();
    }
}

function timeoutError(message = "The operation timed out") {
    if (typeof DOMException === "function") return new DOMException(message, "TimeoutError");
    const error = new Error(message);
    error.name = "TimeoutError";
    return error;
}

export function combineAbortSignals(signals = []) {
    const controller = new AbortController();
    const activeSignals = signals.filter(signal => signal && typeof signal.addEventListener === "function");
    const listeners = new Map();
    const cleanup = () => {
        for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
        listeners.clear();
    };
    const abortFrom = (signal) => {
        if (controller.signal.aborted) return;
        cleanup();
        abortWithReason(controller, signal.reason);
    };

    for (const signal of activeSignals) {
        if (signal.aborted) {
            abortFrom(signal);
            break;
        }
        const listener = () => abortFrom(signal);
        listeners.set(signal, listener);
        signal.addEventListener("abort", listener, { once: true });
    }
    return controller.signal;
}

export function createAbortDeadline(parentSignal, timeoutMs, message = "The operation timed out") {
    const controller = new AbortController();
    const delay = Number(timeoutMs);
    if (!Number.isFinite(delay) || delay < 0) throw new TypeError("Abort deadline must be a non-negative finite number");

    let timedOut = false;
    let timeoutId = null;
    const abortFromParent = () => abortWithReason(controller, parentSignal?.reason);
    if (parentSignal?.aborted) {
        abortFromParent();
    } else {
        parentSignal?.addEventListener("abort", abortFromParent, { once: true });
        timeoutId = setTimeout(() => {
            timedOut = true;
            abortWithReason(controller, timeoutError(message));
        }, delay);
    }

    return {
        signal: controller.signal,
        didTimeOut: () => timedOut,
        dispose() {
            if (timeoutId !== null) clearTimeout(timeoutId);
            timeoutId = null;
            parentSignal?.removeEventListener("abort", abortFromParent);
        },
    };
}

function getHeaderEntries(headers) {
    if (!headers) return [];
    if (typeof headers.entries === "function") return [...headers.entries()];
    if (Array.isArray(headers)) return headers;
    return Object.entries(headers);
}

export function getCorsProxyStateKey(url, options = {}, baseUrl = globalThis.location?.href || "http://localhost/") {
    const target = new URL(url, baseUrl);
    const method = String(options.method || "GET").toUpperCase();
    const mode = String(options.mode || "cors");
    const credentials = String(options.credentials || "same-origin");
    const headerClass = getHeaderEntries(options.headers)
        .map(([name, value]) => {
            const normalizedName = String(name).toLowerCase();
            if (normalizedName !== "content-type") return normalizedName;
            return `${normalizedName}:${String(value).split(";", 1)[0].trim().toLowerCase()}`;
        })
        .sort()
        .join(",");
    return `${target.origin}|${method}|${mode}|${credentials}|${headerClass}`;
}

export async function clonedResponseIncludes(response, expected, maxBytes = 64 * 1024) {
    if (!response || typeof response.clone !== "function") return false;
    try {
        return (await readResponseText(response.clone(), maxBytes)).includes(expected);
    } catch {
        return false;
    }
}

export function getCorsFailureMessage(url, currentOrigin = globalThis.location?.origin || "") {
    const origin = String(currentOrigin || "").trim();
    const a1111Hint = origin && origin !== "null"
        ? ` or launch A1111 with --cors-allow-origins=${origin}`
        : "";
    return `Cannot reach ${url} (CORS). Enable enableCorsProxy in SillyTavern config.yaml${a1111Hint}`;
}

function isLoopbackUrl(url) {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    return !!ipv4 && ipv4.slice(1).map(Number).every(octet => octet <= 255) && Number(ipv4[1]) === 127;
}

export function assertSafeConfigurableEndpoint(value, label = "Provider endpoint", baseUrl = globalThis.location?.href || "http://localhost/") {
    const raw = String(value || "").trim();
    if (!raw) throw new Error(`${label} is required`);
    let endpoint;
    try {
        endpoint = new URL(raw, baseUrl);
    } catch {
        throw new Error(`${label} must be an HTTP or HTTPS URL`);
    }
    if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password) {
        throw new Error(`${label} must be an HTTP or HTTPS URL without embedded credentials`);
    }
    if (endpoint.protocol === "http:" && !isLoopbackUrl(endpoint)) {
        throw new Error(`${label} must use HTTPS unless it targets localhost`);
    }
    return value;
}
