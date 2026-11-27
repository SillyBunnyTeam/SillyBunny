import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { setConfigFilePath } from '../src/util.js';

const TOKEN_LIFETIME_S = 3600;
// The Gemini long decode documentation sets 20 minutes as the limit of a streaming request, and every hop of a long decode reply is one such request.
const LONGEST_HOP_S = 20 * 60;

let tempDir;
let getVertexAIAuth;
let clearVertexAIAuthCache;

beforeAll(async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-vertex-cache-'));
    fs.copyFileSync(new URL('../default/config.yaml', import.meta.url), path.join(tempDir, 'config.yaml'));
    setConfigFilePath(path.join(tempDir, 'config.yaml'));
    const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
    ({ getVertexAIAuth, clearVertexAIAuthCache } = await import('../src/endpoints/google.js'));
    new SecretManager({ root: tempDir, backups: tempDir }).writeSecret(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, JSON.stringify({
        client_email: 'svc@proj-1.iam.gserviceaccount.com',
        private_key: pem,
        project_id: 'proj-alpha',
    }));
});

afterAll(() => {
    clearVertexAIAuthCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
    clearVertexAIAuthCache();
});

function createAuthClock() {
    let nowMs = 1_000_000;
    let minted = 0;
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({
        access_token: `token-${++minted}`,
        expires_in: TOKEN_LIFETIME_S,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const request = {
        body: { vertexai_auth_mode: 'full' },
        user: { directories: { root: tempDir, backups: tempDir } },
    };
    return {
        fetchImpl,
        advance: seconds => { nowMs += seconds * 1000; },
        auth: () => getVertexAIAuth(request, { fetchImpl, now: () => nowMs }),
    };
}

describe('Vertex AI token cache', () => {
    test('hands out a cached token while it still outlasts a full hop of a long decode reply', async () => {
        const clock = createAuthClock();
        const first = await clock.auth();

        clock.advance(TOKEN_LIFETIME_S - LONGEST_HOP_S - 5 * 60);
        const later = await clock.auth();

        expect(later.authHeader).toBe(first.authHeader);
        expect(clock.fetchImpl).toHaveBeenCalledTimes(1);
    });

    test('mints a new token instead of handing out one that has less than a full hop of life left', async () => {
        const clock = createAuthClock();
        const first = await clock.auth();

        clock.advance(TOKEN_LIFETIME_S - LONGEST_HOP_S + 1);
        const later = await clock.auth();

        expect(first.authHeader).toBe('Bearer token-1');
        expect(later.authHeader).toBe('Bearer token-2');
        expect(clock.fetchImpl).toHaveBeenCalledTimes(2);
    });

    test('a freshly minted token is cached for most of its lifetime', async () => {
        const clock = createAuthClock();
        await clock.auth();
        clock.advance(TOKEN_LIFETIME_S - LONGEST_HOP_S + 1);
        await clock.auth();

        clock.advance(LONGEST_HOP_S - 1);
        const stillValid = await clock.auth();

        expect(stillValid.authHeader).toBe('Bearer token-2');
        expect(clock.fetchImpl).toHaveBeenCalledTimes(2);
    });
});
