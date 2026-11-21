import path from 'node:path';

import express from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';

import { retryAfter } from '../express-common.js';
import { serverDirectory } from '../server-directory.js';
import { ManagedContentError, createManagedContent } from '../sillybunny-managed-content.js';
import { setPermissionsSync } from '../util.js';
import { invalidateThumbnail } from './thumbnails.js';

const MAX_FILENAME_LENGTH = 255;
const RATE_LIMIT = Object.freeze({ points: 20, durationSeconds: 60 });

/** What the client is told for each refusal of the service. Anything not listed here is a server fault. */
const STATUS_BY_CODE = Object.freeze({
    unknown_item: 404,
    already_current: 409,
    not_applicable: 409,
    unsafe_target: 409,
    bundled_missing: 500,
    backup_failed: 500,
    write_failed: 500,
});

const LINE_SEPARATORS = /[\u0085\u2028\u2029]/g;

/**
 * Text from a request or an error, in quotes and on one line. JSON escapes the line breaks and the control characters;
 * these three separators it leaves as they are.
 * @param {unknown} value
 * @returns {string}
 */
const quoteForLog = value => JSON.stringify(String(value)).replace(LINE_SEPARATORS, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** @param {unknown} error Whatever was thrown, which need not be an error. */
const describeFailure = error => error?.cause?.message ?? error?.message ?? String(error);

/**
 * @typedef {object} ManagedContentService
 * @property {() => string} stateSignature
 * @property {() => object[]} status
 * @property {(filename: string) => { backup: string | null }} apply
 * @property {(filename: string) => { backup: string | null }} restore
 */

/**
 * A request body is `{ filename }` and nothing else. The name is only ever looked up in the manifest, so it is not
 * checked beyond being a string of a sane length.
 * @param {unknown} body
 * @returns {string | null}
 */
function parseFilename(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    const keys = Object.keys(body);
    const { filename } = body;
    if (keys.length !== 1 || keys[0] !== 'filename' || typeof filename !== 'string') {
        return null;
    }
    return filename.length > 0 && filename.length <= MAX_FILENAME_LENGTH ? filename : null;
}

/**
 * @param {object} [options]
 * @param {string} [options.bundledDirectory] Where the manifest and the bundled files are.
 * @param {(context: { bundledDirectory: string, directories: object }) => ManagedContentService} [options.createService]
 *   Makes the service of one user; tests replace it.
 * @param {{ points: number, durationSeconds: number }} [options.rateLimit] Changes per user, apply and restore together.
 * @returns {import('express').Router}
 */
export function createManagedContentRouter({
    bundledDirectory = path.join(serverDirectory, 'default/content'),
    createService = ({ bundledDirectory, directories }) => createManagedContent({
        bundledDirectory,
        directories,
        setPermissions: setPermissionsSync,
        invalidateThumbnail: filename => invalidateThumbnail(directories, 'avatar', filename),
    }),
    rateLimit = RATE_LIMIT,
} = {}) {
    const limiter = new RateLimiterMemory({ points: rateLimit.points, duration: rateLimit.durationSeconds });
    /** @type {Map<string, { signature: string, items: object[] }>} The last status of each user. */
    const statusByUser = new Map();
    const router = express.Router();

    const serviceOf = request => createService({ bundledDirectory, directories: request.user.directories });

    router.get('/status', (request, response) => {
        try {
            const { handle } = request.user.profile;
            const service = serviceOf(request);
            const signature = service.stateSignature();
            const remembered = statusByUser.get(handle);
            if (remembered?.signature === signature) {
                return response.send({ items: remembered.items });
            }
            const items = service.status();
            statusByUser.set(handle, { signature, items });
            return response.send({ items });
        } catch (error) {
            console.warn('Managed content status failed: %s', quoteForLog(describeFailure(error)));
            return response.status(500).send({ error: 'status_failed' });
        }
    });

    for (const action of ['apply', 'restore']) {
        router.post(`/${action}`, async (request, response) => {
            const filename = parseFilename(request.body);
            if (filename === null) {
                return response.status(400).send({ error: 'invalid_request' });
            }
            try {
                await limiter.consume(request.user.profile.handle);
            } catch (rateLimitError) {
                retryAfter(response, rateLimitError);
                return response.status(429).send({ error: 'rate_limit_exceeded' });
            }

            // A change may have written part of what it set out to, so what is remembered is dropped either way.
            statusByUser.delete(request.user.profile.handle);
            try {
                return response.send(serviceOf(request)[action](filename));
            } catch (error) {
                // The response carries a code only. The format string of the log is constant, since a name is user input.
                // A change that was not needed is what a second click on the same button causes, so it is no warning.
                const level = error instanceof ManagedContentError && error.code === 'already_current' ? 'info' : 'warn';
                console[level]('Managed content %s could not be %s:', quoteForLog(filename), action === 'apply' ? 'updated' : 'restored', quoteForLog(describeFailure(error)));
                if (error instanceof ManagedContentError && Object.hasOwn(STATUS_BY_CODE, error.code)) {
                    return response.status(STATUS_BY_CODE[error.code]).send({ error: error.code });
                }
                return response.status(500).send({ error: `${action}_failed` });
            }
        });
    }

    return router;
}

export const router = createManagedContentRouter();
