import http from 'node:http';
import process from 'node:process';

import express from 'express';

import { observeRequestCancellation } from '../src/request-cancellation.js';

const RUNTIME_LABEL = process.versions?.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`;
const ABORT_TIMEOUT_MS = 2000;

function waitForAbort(signal) {
    if (signal.aborted) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Server-side upstream request was not aborted within ${ABORT_TIMEOUT_MS}ms`));
        }, ABORT_TIMEOUT_MS);
        timeout.unref?.();

        signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            resolve();
        }, { once: true });
    });
}

function waitForRequestStarted() {
    let resolveStarted;
    const promise = new Promise(resolve => {
        resolveStarted = resolve;
    });

    return { promise, resolveStarted };
}

async function listen(server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Unable to resolve test server address');
    }

    return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
    await new Promise(resolve => server.close(resolve));
}

async function main() {
    const app = express();
    const started = waitForRequestStarted();
    let upstreamAbortPromise = null;

    app.use(express.json());
    app.post('/generate', async (request, response) => {
        const controller = new AbortController();
        observeRequestCancellation(request, response, {
            controller,
            pollConnection: Boolean(process.versions?.bun),
            pollIntervalMs: 50,
        });

        upstreamAbortPromise = waitForAbort(controller.signal);
        started.resolveStarted();

        try {
            await upstreamAbortPromise;
            if (!response.writableEnded) {
                response.status(499).end();
            }
        } catch (error) {
            if (!response.writableEnded) {
                response.status(500).send(error.message);
            }
        }
    });

    const server = http.createServer(app);
    const baseUrl = await listen(server);
    const clientController = new AbortController();
    const clientRequest = fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'slow generation' }),
        signal: clientController.signal,
    }).catch(error => error);

    try {
        await started.promise;
        clientController.abort();
        await upstreamAbortPromise;
        await clientRequest;
        console.info(`[request-cancellation] PASS under ${RUNTIME_LABEL}`);
    } finally {
        await close(server);
    }
}

main().catch(error => {
    console.error(`[request-cancellation] FAIL under ${RUNTIME_LABEL}:`, error);
    process.exitCode = 1;
});
