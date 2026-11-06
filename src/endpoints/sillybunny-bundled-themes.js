import { createHash } from 'node:crypto';

import express from 'express';
import fetch from 'node-fetch';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import sanitize from 'sanitize-filename';

import { BUNDLED_THEMES, assertValidAllowlist } from '../sillybunny-bundled-themes.js';
import { retryAfter } from '../express-common.js';
import { publishNewFile } from '../sillybunny-publish-file.js';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_THEME_BYTES = 512 * 1024;
const MAX_THEME_NAME_LENGTH = 200;
const RATE_LIMIT = Object.freeze({ points: 10, durationSeconds: 60 });

/**
 * A failure the client is told about by a short code. Nothing from the request or the upstream goes into the
 * response; the `cause` is for the server log.
 */
class InstallError extends Error {
    /**
     * @param {number} status
     * @param {string} code
     * @param {object} [details] Extra fields of the response body.
     * @param {unknown} [cause] What went wrong underneath, for the log.
     */
    constructor(status, code, details = {}, cause = undefined) {
        super(code, { cause });
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

const upstreamFailed = cause => new InstallError(502, 'upstream_failed', {}, cause);
const tooLarge = () => new InstallError(502, 'too_large');
const invalidTheme = () => new InstallError(502, 'invalid_theme');

/**
 * Runs a task that must end before the deadline, even when the task ignores its abort signal. The signal is aborted
 * when the task ends, whichever way, so a request that is not finished does not stay open.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} task
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
async function withDeadline(task, timeoutMs) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new InstallError(504, 'timeout'));
            controller.abort();
        }, timeoutMs);
    });
    try {
        return await Promise.race([task(controller.signal), deadline]);
    } finally {
        clearTimeout(timer);
        // Closes the connection of a body that was not read to its end. Bun does not close it when a stream is cancelled.
        controller.abort();
    }
}

/**
 * Reads a body, and stops as soon as it is larger than the cap. Leaving the loop closes the stream, so an endless
 * body is not read on. The body is a Node stream from `node-fetch` and an async iterable in any case.
 * @param {import('node-fetch').Response} response
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readCapped(response, maxBytes) {
    const announced = Number(response.headers.get('content-length'));
    if (Number.isFinite(announced) && announced > maxBytes) {
        discardBody(response);
        throw tooLarge();
    }
    if (!response.body) {
        throw upstreamFailed();
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > maxBytes) {
            throw tooLarge();
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/** @param {import('node-fetch').Response} response */
function discardBody(response) {
    const { body } = response;
    if (typeof body?.destroy === 'function') {
        body.destroy();
    } else {
        void body?.cancel?.().catch(() => {});
    }
}

/**
 * Fetches the pinned file and returns its bytes once their SHA-256 is the expected one. Nothing reads the bytes
 * before that check.
 * @param {{ url: string, sha256: string }} source
 * @param {{ fetchImpl: typeof fetch, timeoutMs: number, maxBytes: number }} limits
 * @returns {Promise<Buffer>}
 */
async function fetchVerified(source, { fetchImpl, timeoutMs, maxBytes }) {
    const bytes = await withDeadline(async (signal) => {
        let response;
        try {
            // A redirect would leave the pinned address, so it is an error.
            response = await fetchImpl(source.url, { signal, redirect: 'error', headers: { Accept: 'application/json, text/plain' } });
        } catch (error) {
            throw signal.aborted ? new InstallError(504, 'timeout') : upstreamFailed(error);
        }
        if (!response.ok) {
            discardBody(response);
            throw upstreamFailed(new Error(`The upstream answered ${response.status}.`));
        }
        return readCapped(response, maxBytes);
    }, timeoutMs).catch((error) => {
        throw error instanceof InstallError ? error : upstreamFailed(error);
    });

    // The expected hash is public, so there is no secret for a timing difference to give away.
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
        throw new InstallError(502, 'hash_mismatch');
    }
    return bytes;
}

/**
 * Parses and checks a theme the way the Themes route needs it: a flat object of plain values with a name that makes
 * a file name. Anything else is not a theme.
 * @param {Buffer} bytes
 * @returns {{ name: string, theme: Record<string, string | number | boolean | null>, fileName: string }}
 */
function parseTheme(bytes) {
    let theme;
    try {
        theme = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        throw invalidTheme();
    }
    if (theme === null || typeof theme !== 'object' || Array.isArray(theme)) {
        throw invalidTheme();
    }
    const { name } = theme;
    if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_THEME_NAME_LENGTH || sanitize(name).trim() === '') {
        throw invalidTheme();
    }
    const isPlain = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
    if (Object.hasOwn(theme, '__proto__') || !Object.values(theme).every(isPlain)) {
        throw invalidTheme();
    }
    return { name, theme, fileName: sanitize(`${name}.json`) };
}

/**
 * @param {object} [options]
 * @param {Record<string, { url: string, sha256: string }>} [options.allowlist] The only things that can be fetched.
 * @param {typeof fetch} [options.fetchImpl] `fetch` of `node-fetch`, so the request proxy of the user applies.
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {{ points: number, durationSeconds: number }} [options.rateLimit] Installs per user.
 * @returns {import('express').Router}
 */
export function createBundledThemesRouter({
    allowlist = BUNDLED_THEMES,
    fetchImpl = fetch,
    timeoutMs = FETCH_TIMEOUT_MS,
    maxBytes = MAX_THEME_BYTES,
    rateLimit = RATE_LIMIT,
} = {}) {
    assertValidAllowlist(allowlist);
    const limiter = new RateLimiterMemory({ points: rateLimit.points, duration: rateLimit.durationSeconds });
    const router = express.Router();

    router.post('/install-bundled', async (request, response) => {
        const id = request.body?.id;
        try {
            if (typeof id !== 'string' || id === '') {
                throw new InstallError(400, 'invalid_request');
            }
            if (!Object.hasOwn(allowlist, id)) {
                throw new InstallError(404, 'unknown_theme');
            }

            try {
                await limiter.consume(request.user.profile.handle);
            } catch (rateLimitError) {
                retryAfter(response, rateLimitError);
                throw new InstallError(429, 'rate_limit_exceeded');
            }

            const bytes = await fetchVerified(allowlist[id], { fetchImpl, timeoutMs, maxBytes });
            const { name, theme, fileName } = parseTheme(bytes);
            const created = publishNewFile(request.user.directories.themes, fileName, JSON.stringify(theme, null, 4));
            if (!created) {
                throw new InstallError(409, 'already_installed', { name });
            }
            return response.status(201).send({ name, theme });
        } catch (error) {
            // The response stays generic; the log says what the fetch or the disk reported.
            if (error instanceof InstallError) {
                if (error.cause) {
                    console.warn(`Bundled theme "${id}" could not be fetched:`, error.cause.message ?? error.cause);
                }
                return response.status(error.status).send({ error: error.code, ...error.details });
            }
            console.warn(`Installing the bundled theme "${id}" failed:`, error.message);
            return response.status(500).send({ error: 'install_failed' });
        }
    });

    return router;
}

export const router = createBundledThemesRouter();
