import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import { Response as NodeFetchResponse } from 'node-fetch';

import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';

const textEvent = text => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\r\n\r\n`;

/** An upstream reply that sends one event and then loses its connection. */
function droppedUpstreamReply() {
    const body = new PassThrough();
    body.write(textEvent('Hello '));
    setTimeout(() => body.destroy(Object.assign(new Error('terminated'), { code: 'ECONNRESET' })), 20);
    return new NodeFetchResponse(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * Runs one streaming Gemini request through the real Chat Completions route, with an upstream that drops.
 * Each call loads the route anew, so that no request state carries over to the next one.
 * @param {string} model Gemini model name
 * @returns {Promise<string>} What the page receives
 */
async function streamDroppedReply(model) {
    jest.resetModules();
    const actualNodeFetch = await import('node-fetch');
    await jest.unstable_mockModule('node-fetch', () => ({ ...actualNodeFetch, default: jest.fn(async () => droppedUpstreamReply()) }));

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-gemini-drop-'));
    let server;
    try {
        fs.copyFileSync(new URL('../default/config.yaml', import.meta.url), path.join(tempRoot, 'config.yaml'));
        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(path.join(tempRoot, 'config.yaml'));
        const { router } = await import('../src/endpoints/backends/chat-completions.js');
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        new SecretManager({ root: tempRoot, backups: tempRoot }).writeSecret(SECRET_KEYS.MAKERSUITE, 'test-google-key');

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: { root: tempRoot, backups: tempRoot } };
            next();
        });
        app.use('/api/backends/chat-completions', router);
        await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });

        const payload = JSON.stringify({
            chat_completion_source: CHAT_COMPLETION_SOURCES.MAKERSUITE,
            model,
            stream: true,
            max_tokens: 64,
            messages: [{ role: 'user', content: 'Hi' }],
        });
        return await new Promise(resolve => {
            let text = '';
            const request = http.request(`http://127.0.0.1:${server.address().port}/api/backends/chat-completions/generate`, {
                method: 'POST',
                agent: false,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            }, res => {
                res.setEncoding('utf8');
                res.on('data', chunk => { text += chunk; });
                // A stream that ends with an error still hands over what arrived before it.
                res.on('error', () => resolve(text));
                res.on('close', () => resolve(text));
            });
            request.on('error', () => resolve(text));
            request.end(payload);
        });
    } finally {
        if (server) {
            await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

describe('a Gemini stream that drops before its finish', () => {
    test.each(['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-4-argon'])('%s ends with the cut-off marker that the page reads as a cut-off reply', async model => {
        const text = await streamDroppedReply(model);

        expect(text).toContain('Hello ');
        expect(text).toContain('"finishReason":"CONTINUATION"');
    });
});
