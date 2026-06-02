import { pollSocketConnection } from './connection-state-checker.js';

export const REQUEST_CANCELLATION_ABORT_REASON = 'Client disconnected';
const DEFAULT_ABORT_HOOK_TIMEOUT_MS = 5000;
const DEFAULT_CONNECTION_POLL_INTERVAL_MS = 150;

function matchesCancellationError(value) {
    if (!value) {
        return false;
    }

    if (value === REQUEST_CANCELLATION_ABORT_REASON) {
        return true;
    }

    const name = String(value?.name ?? '');
    const type = String(value?.type ?? '');
    const code = String(value?.code ?? '');
    const message = String(value?.message ?? value).toLowerCase();

    return name === 'AbortError' ||
        type === 'aborted' ||
        code === 'ABORT_ERR' ||
        message.includes('client disconnected') ||
        message.includes('operation was aborted') ||
        message.includes('aborted');
}

/**
 * Detects request cancellation errors across runtimes and fetch implementations.
 * Bun can reject fetch with the raw abort reason, while Node/node-fetch usually
 * rejects with an AbortError-shaped object.
 * @param {any} error Error-like value from fetch, streams, or abort hooks.
 * @returns {boolean} Whether this value is an expected client disconnect.
 */
export function isRequestCancellationError(error) {
    return [
        error,
        error?.cause,
        error?.reason,
    ].some(matchesCancellationError);
}

function removeEventListener(target, event, handler) {
    if (typeof target?.removeEventListener === 'function') {
        target.removeEventListener(event, handler);
        return;
    }

    if (typeof target?.removeListener === 'function') {
        target.removeListener(event, handler);
        return;
    }

    if (typeof target?.off === 'function') {
        target.off(event, handler);
    }
}

function once(target, event, handler) {
    if (typeof target?.addEventListener === 'function') {
        target.addEventListener(event, handler, { once: true });
        return () => removeEventListener(target, event, handler);
    }

    if (typeof target?.once !== 'function') {
        return () => undefined;
    }

    target.once(event, handler);
    return () => removeEventListener(target, event, handler);
}

function normalizePositiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function runAbortHook(onAbort, context, timeoutMs) {
    if (typeof onAbort !== 'function') {
        return;
    }

    try {
        const result = onAbort(context);
        if (!result || typeof result.then !== 'function') {
            return;
        }

        let settled = false;
        const timeout = normalizePositiveNumber(timeoutMs, DEFAULT_ABORT_HOOK_TIMEOUT_MS);
        const timer = setTimeout(() => {
            if (!settled) {
                console.warn(`Request cancellation hook timed out after ${timeout}ms from ${context.source}`);
            }
        }, timeout);
        timer.unref?.();

        result.then(
            () => {
                settled = true;
                clearTimeout(timer);
            },
            error => {
                settled = true;
                clearTimeout(timer);
                console.warn('Error handling request cancellation:', error);
            },
        );
    } catch (error) {
        console.warn('Error handling request cancellation:', error);
    }
}

function isRequestAborted(request) {
    return Boolean(
        request?.aborted
        || request?.readableAborted
        || (request?.destroyed && request?.complete !== true),
    );
}

/**
 * Observes client disconnect signals for an HTTP request and aborts upstream work once.
 * @param {import('express').Request} request Express request.
 * @param {import('express').Response|null} response Express response.
 * @param {object} options Cancellation options.
 * @param {AbortController} [options.controller] Upstream abort controller.
 * @param {({request: import('express').Request, response: import('express').Response|null, signal: AbortSignal, source: string}) => void | Promise<void>} [options.onAbort] Provider-specific abort hook.
 * @param {number} [options.abortHookTimeoutMs] Timeout for async abort hook diagnostics.
 * @param {boolean} [options.pollConnection] Whether to poll the socket as a disconnect fallback.
 * @param {number} [options.pollIntervalMs] Socket polling interval.
 * @param {(socket: import('node:net').Socket, intervalMs: number, onDisconnect: () => void) => () => void} [options.startConnectionPolling] Polling starter.
 * @param {any} [options.reason] Abort reason.
 * @returns {{controller: AbortController, signal: AbortSignal, abort: (source?: string) => void, cleanup: () => void, isAborted: boolean}}
 */
export function observeRequestCancellation(request, response = null, {
    abortHookTimeoutMs = DEFAULT_ABORT_HOOK_TIMEOUT_MS,
    controller = new AbortController(),
    onAbort = null,
    pollConnection = false,
    pollIntervalMs = DEFAULT_CONNECTION_POLL_INTERVAL_MS,
    reason = REQUEST_CANCELLATION_ABORT_REASON,
    startConnectionPolling = pollSocketConnection,
} = {}) {
    const cleanupCallbacks = [];
    let cancelled = false;
    let cleanedUp = false;

    function cleanup() {
        if (cleanedUp) {
            return;
        }

        cleanedUp = true;
        for (const removeListener of cleanupCallbacks.splice(0)) {
            removeListener();
        }
    }

    function abort(source = 'manual') {
        if (cancelled || controller.signal.aborted) {
            return;
        }

        cancelled = true;
        controller.abort(reason);
        runAbortHook(onAbort, {
            request,
            response,
            signal: controller.signal,
            source,
        }, abortHookTimeoutMs);
        cleanup();
    }

    function handleRequestClose() {
        if (isRequestAborted(request)) {
            abort('request-close');
        }
    }

    function handleResponseClose() {
        if (response?.writableEnded) {
            cleanup();
            return;
        }

        abort('response-close');
    }

    cleanupCallbacks.push(
        once(request, 'aborted', () => abort('request-aborted')),
        once(request, 'close', handleRequestClose),
        once(response, 'close', handleResponseClose),
        once(response, 'finish', cleanup),
        once(request?.socket, 'close', () => abort('socket-close')),
        once(controller.signal, 'abort', cleanup),
    );

    if (pollConnection && request?.socket && typeof startConnectionPolling === 'function') {
        cleanupCallbacks.push(startConnectionPolling(
            request.socket,
            normalizePositiveNumber(pollIntervalMs, DEFAULT_CONNECTION_POLL_INTERVAL_MS),
            () => abort('socket-poll'),
        ));
    }

    return {
        controller,
        signal: controller.signal,
        abort,
        cleanup,
        get isAborted() {
            return cancelled || controller.signal.aborted;
        },
    };
}
