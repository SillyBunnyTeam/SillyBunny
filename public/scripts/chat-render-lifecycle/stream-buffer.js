import { createFrameWriteScheduler } from './scheduler.js';

function assertStreamBufferOptions({ applyWrite, scheduler }) {
    if (typeof applyWrite !== 'function') {
        throw new TypeError('createStreamWriteBuffer requires applyWrite to be a function.');
    }

    if (!scheduler || typeof scheduler.request !== 'function' || typeof scheduler.cancel !== 'function') {
        throw new TypeError('createStreamWriteBuffer requires scheduler.request and scheduler.cancel.');
    }
}

function normalizeWriteOptions({ isFinal = false, ...restOptions } = {}) {
    return {
        ...restOptions,
        isFinal: Boolean(isFinal),
    };
}

/**
 * Coalesces already-decided streaming visible writes through one scheduler lane.
 * Provider state, token events, and persistence stay with the caller.
 * @param {object} options Options.
 * @param {{request: (callback: () => void) => void, cancel: () => void}} [options.scheduler] Write scheduler.
 * @param {(messageId: number|string, write: object, options: object) => void} options.applyWrite Visible write applier.
 * @returns {{queue: (messageId: number|string, write: object, options?: object) => number, flush: () => number, clear: () => void, size: () => number}}
 */
export function createStreamWriteBuffer({
    scheduler = createFrameWriteScheduler(),
    applyWrite,
} = {}) {
    assertStreamBufferOptions({ applyWrite, scheduler });

    const pendingWrites = new Map();
    let hasScheduledFlush = false;

    const flush = () => {
        hasScheduledFlush = false;
        const writes = [...pendingWrites.entries()];
        pendingWrites.clear();

        for (const [messageId, { write, options }] of writes) {
            try {
                applyWrite(messageId, write, options);
            } catch (error) {
                // Scheduled formatting failures must still abort their owning generation.
                if (options.isFinal || typeof options.onError !== 'function') {
                    throw error;
                }
                options.onError(error);
            }
        }

        return writes.length;
    };

    const scheduleFlush = () => {
        if (hasScheduledFlush) {
            return;
        }

        hasScheduledFlush = true;
        scheduler.request(flush);
    };

    const queue = (messageId, write, options = {}) => {
        const normalizedOptions = normalizeWriteOptions(options);

        pendingWrites.set(messageId, {
            write,
            options: normalizedOptions,
        });

        if (normalizedOptions.isFinal) {
            scheduler.cancel();
            flush();
            return pendingWrites.size;
        }

        scheduleFlush();
        return pendingWrites.size;
    };

    const clear = () => {
        pendingWrites.clear();
        hasScheduledFlush = false;
        scheduler.cancel();
    };

    const size = () => pendingWrites.size;

    return {
        queue,
        flush,
        clear,
        size,
    };
}
