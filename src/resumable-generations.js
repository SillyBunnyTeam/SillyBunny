import { Buffer } from 'node:buffer';
import express from 'express';

/**
 * SillyBunny: generation replies that outlive the client connection.
 *
 * A generation request tagged with the X-Generation-Id header is registered here. Everything the
 * handler writes to the Express response is also kept in memory, and the disconnect handling in
 * util.js / request-cancellation.js stops treating a vanished client as a reason to abort the
 * upstream request. The page can pick the reply back up from any byte offset (POST /resume) or
 * cancel it for real (POST /cancel). Phones that freeze background tabs are why this exists.
 */

export const RESUMABLE_GENERATION_HEADER = 'x-generation-id';
const GENERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
/** A finished reply waits this long for the page to come back for it. */
const FINISHED_RETENTION_MS = 15 * 60 * 1000;
/** A reply still running after this long is cancelled, attached client or not. */
const MAX_LIFETIME_MS = 60 * 60 * 1000;
const MAX_GENERATIONS = 200;
/** One profile cannot hold more than this many replies, live or finished. */
const MAX_GENERATIONS_PER_PROFILE = 20;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/** Every buffered reply together stays under this; finished replies hand their bytes back first. */
const MAX_TOTAL_BUFFER_BYTES = 256 * 1024 * 1024;
/** A reply serves at most this many concurrent resume readers, queued or attached. */
const MAX_RESUME_CLIENTS = 8;
/** A resume reader that falls behind by more than this gets dropped instead of buffered into. */
const MAX_RESUME_BACKLOG_BYTES = 8 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60 * 1000;

/** @type {Map<string, ResumableGeneration>} */
const generations = new Map();
/** @type {ReturnType<typeof setInterval>|null} */
let sweepTimer = null;
/** Every byte currently mirrored into the registry, across all profiles. */
let totalBufferedBytes = 0;

/**
 * @param {unknown} chunk Anything a handler may pass to response.write()
 * @param {unknown} encoding Optional string encoding
 * @returns {Buffer|null}
 */
function toBuffer(chunk, encoding) {
    if (chunk === undefined || chunk === null) {
        return null;
    }
    if (Buffer.isBuffer(chunk)) {
        return chunk;
    }
    if (typeof chunk === 'string') {
        return Buffer.from(chunk, typeof encoding === 'string' ? /** @type {BufferEncoding} */ (encoding) : 'utf8');
    }
    if (ArrayBuffer.isView(chunk)) {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    return null;
}

/**
 * @param {() => void | Promise<void>} hook Cancel hook
 */
function runCancelHook(hook) {
    try {
        const result = hook();
        if (result && typeof result.catch === 'function') {
            result.catch(error => console.warn('Error cancelling resumable generation:', error));
        }
    } catch (error) {
        console.warn('Error cancelling resumable generation:', error);
    }
}

/**
 * @typedef {object} ResumableSubscriber
 * @property {(chunk: Buffer) => void} onChunk Called for every byte range, replayed or live
 * @property {() => void} onEnd Called once the reply is complete
 * @property {() => void} [onFail] Called if the reply can no longer be served
 */

export class ResumableGeneration {
    /**
     * @param {string} key Registry key
     */
    constructor(key) {
        this.key = key;
        this.createdAt = Date.now();
        /** @type {number|null} */
        this.finishedAt = null;
        /** @type {number|null} */
        this.statusCode = null;
        this.statusMessage = '';
        /** @type {string|null} */
        this.contentType = null;
        this.cancelled = false;
        this.overflowed = false;
        /** @type {Buffer[]} */
        this.chunks = [];
        this.size = 0;
        /** @type {Set<() => void | Promise<void>>} */
        this.cancelHooks = new Set();
        /** @type {Set<ResumableSubscriber>} */
        this.subscribers = new Set();
        /** @type {{ resolve: () => void }[]} */
        this.headerWaiters = [];
    }

    get done() {
        return this.finishedAt !== null;
    }

    get headersReady() {
        return this.statusCode !== null;
    }

    /**
     * Remembers the status and content type from the first write so a replay can reproduce them.
     * @param {import('express').Response} response Express response being written
     */
    captureHeaders(response) {
        if (this.headersReady) {
            return;
        }
        this.statusCode = Number(response?.statusCode) || 200;
        this.statusMessage = String(response?.statusMessage ?? '');
        const contentType = response?.getHeader?.('content-type');
        this.contentType = contentType ? String(contentType) : null;
        this.releaseHeaderWaiters();
    }

    releaseHeaderWaiters() {
        for (const waiter of this.headerWaiters.splice(0)) {
            waiter.resolve();
        }
    }

    /**
     * Waits for the handler to start answering, with a handle for giving up when the waiting
     * client disappears - otherwise an abandoned pre-header resume would hold its resources
     * until the generation finishes on its own.
     * @returns {{ promise: Promise<void>, cancel: () => void }}
     */
    waitForHeaders() {
        if (this.headersReady || this.done) {
            return { promise: Promise.resolve(), cancel: () => undefined };
        }
        let resolve;
        const promise = new Promise(settle => {
            resolve = settle;
        });
        const waiter = { resolve: () => resolve() };
        this.headerWaiters.push(waiter);
        return {
            promise,
            cancel: () => {
                const index = this.headerWaiters.indexOf(waiter);
                if (index !== -1) {
                    this.headerWaiters.splice(index, 1);
                    resolve();
                }
            },
        };
    }

    /**
     * Gives the buffered reply bytes back to the global budget. Safe to call twice.
     */
    freeBuffers() {
        totalBufferedBytes -= this.size;
        this.chunks = [];
        this.size = 0;
    }

    /**
     * @param {unknown} chunk Response bytes
     * @param {unknown} [encoding] String encoding
     */
    write(chunk, encoding) {
        if (this.done || this.overflowed) {
            return;
        }
        const buffer = toBuffer(chunk, encoding);
        if (!buffer?.length) {
            return;
        }
        if (this.size + buffer.length > MAX_BUFFER_BYTES ||
            (totalBufferedBytes + buffer.length > MAX_TOTAL_BUFFER_BYTES && !fitGlobalByteBudget(buffer.length))) {
            // ponytail: a text reply never gets here; if it does, forget it rather than eat the heap.
            this.overflowed = true;
            this.forceDiscard();
            return;
        }
        this.chunks.push(buffer);
        this.size += buffer.length;
        totalBufferedBytes += buffer.length;
        for (const subscriber of this.subscribers) {
            subscriber.onChunk(buffer);
        }
    }

    end() {
        if (this.done) {
            return;
        }
        this.finishedAt = Date.now();
        this.cancelHooks.clear();
        this.releaseHeaderWaiters();
        for (const subscriber of this.subscribers) {
            subscriber.onEnd();
        }
        this.subscribers.clear();
    }

    forceDiscard() {
        if (generations.get(this.key) === this) {
            generations.delete(this.key);
        }
        if (!this.done) {
            const subscribers = [...this.subscribers];
            this.subscribers.clear();
            for (const subscriber of subscribers) {
                subscriber.onFail?.();
            }
            this.cancel();
            this.end();
        } else {
            this.subscribers.clear();
        }
        this.freeBuffers();
    }

    /**
     * Registers work to run if the generation is cancelled.
     * @param {() => void | Promise<void>} hook Cancel hook
     * @returns {() => void} Unregister
     */
    onCancel(hook) {
        if (typeof hook !== 'function' || this.done) {
            return () => undefined;
        }
        if (this.cancelled) {
            runCancelHook(hook);
            return () => undefined;
        }
        this.cancelHooks.add(hook);
        return () => this.cancelHooks.delete(hook);
    }

    /**
     * Stops the upstream work. Safe to call more than once.
     * @returns {boolean} Whether there was anything left to cancel
     */
    cancel() {
        if (this.cancelled || this.done) {
            return false;
        }
        this.cancelled = true;
        const hooks = [...this.cancelHooks];
        this.cancelHooks.clear();
        for (const hook of hooks) {
            runCancelHook(hook);
        }
        return true;
    }

    /**
     * Replays everything from a byte offset, then forwards live chunks until the reply ends.
     * @param {number} offset Bytes the subscriber already has
     * @param {ResumableSubscriber} subscriber Sink
     * @returns {(() => void)|null} Unsubscribe, or null when too many readers are attached
     */
    subscribe(offset, subscriber) {
        if (this.subscribers.size >= MAX_RESUME_CLIENTS) {
            return null;
        }
        let skip = Math.max(0, Math.min(offset, this.size));
        for (const chunk of this.chunks) {
            if (skip >= chunk.length) {
                skip -= chunk.length;
                continue;
            }
            subscriber.onChunk(skip > 0 ? chunk.subarray(skip) : chunk);
            skip = 0;
        }
        if (this.done) {
            subscriber.onEnd();
            return () => undefined;
        }
        this.subscribers.add(subscriber);
        return () => this.subscribers.delete(subscriber);
    }
}

/**
 * Tries to absorb upcoming bytes by dropping finished replies, oldest first. Live generations are
 * never touched for the byte budget - losing a cached reply costs a resume, losing a live one
 * costs the model call.
 * @param {number} needed Bytes the caller wants to append
 * @returns {boolean} Whether the budget can take the bytes now
 */
function fitGlobalByteBudget(needed) {
    for (const generation of generations.values()) {
        if (totalBufferedBytes + needed <= MAX_TOTAL_BUFFER_BYTES) {
            return true;
        }
        if (generation.done) {
            generation.forceDiscard();
        }
    }
    return totalBufferedBytes + needed <= MAX_TOTAL_BUFFER_BYTES;
}

/**
 * @param {import('express').Request} request Express request
 * @returns {string} Profile handle the request is authenticated as
 */
function getProfileHandle(request) {
    return request?.user?.profile?.handle ?? '';
}

/**
 * @param {import('express').Request} request Express request
 * @param {string} id Client-chosen generation id
 * @returns {string}
 */
function getGenerationKey(request, id) {
    return `${getProfileHandle(request)}:${id}`;
}

/**
 * Makes room for a new registration. An over-cap profile gives up its own oldest entries,
 * finished ones first; globally only finished replies are fair game. Another profile's live
 * generation is never discarded to make room - that would let anyone cancel anyone else's
 * model call.
 * @param {string} handle Profile handle of the incoming registration
 * @returns {boolean} Whether a new registration fits the global cap
 */
function trimRegistry(handle) {
    const prefix = `${handle}:`;
    let owned = [...generations.entries()].filter(([key]) => key.startsWith(prefix));
    while (owned.length >= MAX_GENERATIONS_PER_PROFILE) {
        const victim = (owned.find(([, generation]) => generation.done) ?? owned[0])[1];
        victim.forceDiscard();
        owned = owned.filter(([, generation]) => generation !== victim);
    }
    while (generations.size >= MAX_GENERATIONS) {
        const oldestFinished = [...generations.values()].find(generation => generation.done);
        if (!oldestFinished) {
            return false;
        }
        oldestFinished.forceDiscard();
    }
    return true;
}

/**
 * @param {number} [now] Current time
 */
function sweepGenerations(now = Date.now()) {
    for (const generation of generations.values()) {
        const expired = generation.done
            ? now - generation.finishedAt > FINISHED_RETENTION_MS
            : now - generation.createdAt > MAX_LIFETIME_MS;
        if (expired) {
            generation.forceDiscard();
        }
    }
    if (generations.size === 0 && sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
}

/**
 * @param {string} handle Profile handle
 * @param {string} key Registry key
 * @returns {ResumableGeneration|null} The new generation, or null when the registry is full of
 * live replies and the request has to proceed without resume support
 */
function registerGeneration(handle, key) {
    // A flaky connection can make the browser replay a POST whose response never started. That
    // arrives as a second registration of the same id, and without this the superseded generation
    // would keep running upstream with nobody to read it - one client request, two model calls.
    const superseded = generations.get(key);
    if (superseded && !superseded.done) {
        console.info('Superseding an earlier resumable generation for the same id');
        superseded.cancel();
        superseded.end();
    }
    if (superseded) {
        superseded.freeBuffers();
        generations.delete(key);
    }

    if (!trimRegistry(handle)) {
        console.warn('Too many live resumable generations; serving this request without resume support');
        return null;
    }

    const generation = new ResumableGeneration(key);
    generations.set(key, generation);
    if (!sweepTimer) {
        sweepTimer = setInterval(sweepGenerations, SWEEP_INTERVAL_MS);
        sweepTimer.unref?.();
    }
    return generation;
}

/**
 * The generation registered for this request, if the client asked for a resumable one.
 * @param {import('express').Request|null|undefined} request Express request
 * @returns {ResumableGeneration|null}
 */
export function getResumableGeneration(request) {
    return request?.resumableGeneration ?? null;
}

/**
 * Mirrors every write to the generation, and keeps writes after the client is gone from throwing.
 * @param {import('express').Response} response Express response
 * @param {ResumableGeneration} generation Generation to mirror into
 */
function attachResponse(response, generation) {
    const write = response.write;
    const end = response.end;

    response.write = function (chunk, encoding, callback) {
        if (typeof encoding === 'function') {
            callback = encoding;
            encoding = undefined;
        }
        generation.captureHeaders(this);
        generation.write(chunk, encoding);
        if (this.writableEnded) {
            if (typeof callback === 'function') {
                callback();
            }
            return false;
        }
        try {
            return write.call(this, chunk, encoding, callback);
        } catch (error) {
            console.warn('Resumable generation client write failed:', error?.message ?? error);
            return false;
        }
    };

    response.end = function (chunk, encoding, callback) {
        if (typeof chunk === 'function') {
            callback = chunk;
            chunk = undefined;
            encoding = undefined;
        } else if (typeof encoding === 'function') {
            callback = encoding;
            encoding = undefined;
        }
        generation.captureHeaders(this);
        generation.write(chunk, encoding);
        if (this.writableEnded) {
            if (typeof callback === 'function') {
                callback();
            }
            return this;
        }
        generation.end();
        try {
            return end.call(this, chunk, encoding, callback);
        } catch (error) {
            console.warn('Resumable generation client end failed:', error?.message ?? error);
            return this;
        }
    };
}

/**
 * Registers a resumable generation when the request carries the X-Generation-Id header.
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @param {import('express').NextFunction} next Next middleware
 */
export function resumableGenerationMiddleware(request, response, next) {
    const id = String(request.get?.(RESUMABLE_GENERATION_HEADER) ?? '');
    if (!GENERATION_ID_PATTERN.test(id)) {
        return next();
    }
    const generation = registerGeneration(getProfileHandle(request), getGenerationKey(request, id));
    if (!generation) {
        return next();
    }
    request.resumableGeneration = generation;
    attachResponse(response, generation);
    return next();
}

/**
 * @param {import('express').Request} request Express request
 * @returns {ResumableGeneration|null}
 */
function findGeneration(request) {
    const id = String(request.body?.id ?? '');
    if (!GENERATION_ID_PATTERN.test(id)) {
        return null;
    }
    return generations.get(getGenerationKey(request, id)) ?? null;
}

export const router = express.Router();

router.post('/resume', async (request, response) => {
    const generation = findGeneration(request);
    if (!generation) {
        return response.sendStatus(404);
    }

    const offset = Number(request.body?.offset ?? 0);
    if (!Number.isInteger(offset) || offset < 0) {
        return response.sendStatus(400);
    }

    // Queued waiters become readers, so they count against the same limit; otherwise a full
    // queue would graduate into rejections after the headers finally arrive.
    if (!generation.headersReady && !generation.done &&
        generation.subscribers.size + generation.headerWaiters.length >= MAX_RESUME_CLIENTS) {
        return response.sendStatus(503);
    }

    const wait = generation.waitForHeaders();
    response.on('close', () => wait.cancel());
    await wait.promise;

    if (response.destroyed || response.writableEnded) {
        return;
    }
    if (!generation.headersReady) {
        return response.sendStatus(410);
    }
    if (offset > generation.size) {
        return response.sendStatus(416);
    }
    if (generation.subscribers.size >= MAX_RESUME_CLIENTS) {
        return response.sendStatus(429);
    }

    response.status(200);
    response.setHeader('Cache-Control', 'no-store, no-transform');
    response.setHeader('X-Generation-Status', String(generation.statusCode));
    const statusText = generation.statusMessage.replace(/[^\x20-\x7E]/g, '').slice(0, 200);
    if (statusText) {
        response.setHeader('X-Generation-Status-Text', statusText);
    }
    if (generation.contentType) {
        response.setHeader('Content-Type', generation.contentType);
    }
    response.flushHeaders();

    let unsubscribe = () => undefined;
    unsubscribe = generation.subscribe(offset, {
        onChunk: chunk => {
            if (response.writableEnded || response.destroyed) {
                return;
            }
            response.write(chunk);
            if (response.writableLength > MAX_RESUME_BACKLOG_BYTES) {
                // This reader stopped draining; drop it instead of buffering the reply into RAM.
                unsubscribe();
                response.destroy();
            }
        },
        onEnd: () => {
            if (!response.writableEnded) {
                response.end();
            }
        },
        onFail: () => response.destroy(),
    });
    response.on('close', unsubscribe);
});

router.post('/cancel', (request, response) => {
    const generation = findGeneration(request);
    if (!generation) {
        return response.sendStatus(404);
    }
    generation.cancel();
    return response.sendStatus(204);
});

export const testExports = {
    FINISHED_RETENTION_MS,
    MAX_LIFETIME_MS,
    MAX_GENERATIONS,
    MAX_GENERATIONS_PER_PROFILE,
    MAX_BUFFER_BYTES,
    MAX_TOTAL_BUFFER_BYTES,
    MAX_RESUME_CLIENTS,
    generations,
    sweepGenerations,
    get totalBufferedBytes() {
        return totalBufferedBytes;
    },
    /**
     * Test seam for simulating a loaded byte budget without allocating hundreds of megabytes.
     * @param {number} value Absolute byte total to pretend is currently buffered
     */
    setTotalBufferedBytes(value) {
        totalBufferedBytes = value;
    },
};
