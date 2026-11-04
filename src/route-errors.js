import { stripVTControlCharacters } from 'node:util';

import Layer from 'express/lib/router/layer.js';

import { isBenignStreamAbort } from './stream-disconnect-guard.js';

const errorsAnsweredWithMessage = new WeakSet();

/**
 * Sends a rejected promise from a route handler or middleware to the error handlers, as Express 5 does.
 * Express 4 ignores the promise that a handler returns, so the request gets no answer and the rejection
 * is unhandled.
 *
 * This replaces two methods of the Layer prototype. Every app, router and route made from this copy of
 * Express shares that prototype, including those made before the call. A router made from another copy
 * of Express is not covered.
 */
export function forwardAsyncRouteErrors() {
    Layer.prototype.handle_request = function handleRequest(request, response, next) {
        const handler = this.handle;
        if (handler.length > 3) {
            return next();
        }

        try {
            forwardRejection(handler(request, response, next), next);
        } catch (error) {
            next(error);
        }
    };

    Layer.prototype.handle_error = function handleError(error, request, response, next) {
        const handler = this.handle;
        if (handler.length !== 4) {
            return next(error);
        }

        try {
            forwardRejection(handler(error, request, response, next), next);
        } catch (thrownError) {
            next(thrownError);
        }
    };
}

function forwardRejection(result, next) {
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        // next() with a falsy value goes on to the next route instead of the error handlers.
        result.then(undefined, reason => next(reason || new Error('Rejected promise')));
    }
}

/**
 * Makes handleRouteError answer this error object with its own message as plain text, without color
 * codes, instead of the status text. Only for an error whose message is written for the client.
 * @param {Error} error The error object that a middleware passes to next()
 */
export function answerWithErrorMessage(error) {
    errorsAnsweredWithMessage.add(error);
}

/**
 * Answers a request whose route failed. An error that carries a 4xx or 5xx status, such as a body that is
 * not valid JSON or a request without a valid CSRF token, keeps that status; any other error gets 500.
 * The answer holds only the status text, so no stack trace or error message reaches the client, except
 * for an error passed to answerWithErrorMessage().
 * A response that has already started is not answered again. An unfinished one is cut off, so that the
 * client does not wait for the rest.
 *
 * Express calls a middleware with four parameters only for errors, so `next` stays in the signature
 * although it is not used.
 */
export function handleRouteError(error, request, response, next) {
    if (isBenignStreamAbort(error)) {
        console.warn('Ignored streaming disconnect error:', error?.message ?? error);
    } else {
        console.error(error instanceof Error ? error.stack || String(error) : error);
    }

    if (response.headersSent) {
        if (!response.writableEnded) {
            request.socket?.destroy();
        }
        return;
    }

    const status = getErrorStatus(error);
    if (errorsAnsweredWithMessage.has(error)) {
        response.status(status).type('text/plain').send(stripVTControlCharacters(String(error.message)));
        return;
    }

    response.sendStatus(status);
}

function getErrorStatus(error) {
    for (const status of [error?.status, error?.statusCode]) {
        if (Number.isInteger(status) && status >= 400 && status <= 599) {
            return status;
        }
    }

    return 500;
}
