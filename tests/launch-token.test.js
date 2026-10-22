/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
/* eslint jest/expect-expect: ["warn", { "assertFunctionNames": ["expect", "expectForbidden"] }] */
/* eslint playwright/expect-expect: ["warn", { "assertFunctionNames": ["expectForbidden"] }] */
import http from 'node:http';

import { afterEach, describe, expect, test } from '@jest/globals';
import cookieSession from 'cookie-session';
import express from 'express';

import createLaunchTokenMiddleware, {
    createHandoffCode,
    HANDOFF_MAX_AGE_MS,
    HANDOFF_NONCE_LIMIT,
    HANDOFF_PAGE,
    HANDOFF_PATH,
    HEALTH_PATH,
    LAUNCH_COOKIE_NAME,
} from '../src/middleware/launchToken.js';

const originalToken = process.env.SILLYBUNNY_LAUNCH_TOKEN;
const token = 'test-launch-token';
const servers = new Set();
const now = 1_700_000_000_000;

async function serve(options = {}, configure = () => {}) {
    const app = express();
    const middleware = createLaunchTokenMiddleware(options);
    if (middleware) {
        app.use(middleware);
    }
    configure(app);
    app.use((req, res) => res.status(200).send('ok'));

    const server = http.createServer(app);
    servers.add(server);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
}

function request(baseUrl, path = '/', { cookie, method = 'GET' } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(new URL(path, baseUrl), {
            method,
            headers: cookie === undefined ? {} : { Cookie: cookie },
            agent: false,
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

function expectForbidden(response) {
    expect(response.status).toBe(403);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).toBe('lorum ipsum');
}

afterEach(async () => {
    for (const server of servers) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    servers.clear();
    if (originalToken === undefined) {
        delete process.env.SILLYBUNNY_LAUNCH_TOKEN;
    } else {
        process.env.SILLYBUNNY_LAUNCH_TOKEN = originalToken;
    }
});

describe('launch-token activation', () => {
    test('adds no middleware when the environment variable is unset', () => {
        delete process.env.SILLYBUNNY_LAUNCH_TOKEN;

        expect(createLaunchTokenMiddleware()).toBeNull();
    });

    test('adds no middleware when the environment variable is empty', () => {
        process.env.SILLYBUNNY_LAUNCH_TOKEN = '';

        expect(createLaunchTokenMiddleware()).toBeNull();
    });

    test('captures the environment only when the middleware is created', async () => {
        process.env.SILLYBUNNY_LAUNCH_TOKEN = token;
        const baseUrl = await serve();
        process.env.SILLYBUNNY_LAUNCH_TOKEN = 'changed-token';

        expect((await request(baseUrl, '/', { cookie: `sillybunny_launch=${token}` })).status).toBe(200);
        expectForbidden(await request(baseUrl, '/', { cookie: 'sillybunny_launch=changed-token' }));
    });

    test('an explicit empty token leaves the entire app unchanged', async () => {
        process.env.SILLYBUNNY_LAUNCH_TOKEN = token;
        const baseUrl = await serve({ token: '' });

        expect((await request(baseUrl)).status).toBe(200);
        expect((await request(baseUrl, '/__sillybunny/health')).body).toBe('ok');
        expect((await request(baseUrl, '/__sillybunny/handoff?c=invalid')).body).toBe('ok');
    });
});

describe('launch-token cookies', () => {
    test.each([
        ['missing cookie', undefined],
        ['wrong cookie', 'sillybunny_launch=xxxxxxxxxxxxxxxxx'],
        ['short cookie', 'sillybunny_launch=short'],
        ['long cookie', `sillybunny_launch=${token}extra`],
        ['empty cookie', 'sillybunny_launch='],
        ['unrelated cookie', `other=${token}`],
        ['cookie name prefix', `sillybunny_launch_extra=${token}`],
        ['different name case', `Sillybunny_launch=${token}`],
        ['malformed cookie', 'sillybunny_launch'],
        ['UTF-8 length mismatch', 'sillybunny_launch=test-launch-tokeñ'],
    ])('rejects a %s with the same minimal response', async (label, cookie) => {
        const baseUrl = await serve({ token });

        expectForbidden(await request(baseUrl, '/', { cookie }));
    });

    test.each([
        `sillybunny_launch=${token}`,
        `other=one; sillybunny_launch=${token}; session=two`,
        `sillybunny_launch=wrong; sillybunny_launch=${token}`,
        `sillybunny_launch=${token}; sillybunny_launch=wrong`,
        `malformed; other=one=two; sillybunny_launch=${token}`,
        `other=one;  sillybunny_launch=${token} ; session=two`,
    ])('accepts the matching cookie in %s', async (cookie) => {
        const baseUrl = await serve({ token });
        const response = await request(baseUrl, '/', { cookie });

        expect(response.status).toBe(200);
        expect(response.body).toBe('ok');
        expect(response.headers['set-cookie']).toBeUndefined();
    });

    test('compares the complete cookie value, including equals signs', async () => {
        const baseUrl = await serve({ token: 'token=with=equals' });

        expect((await request(baseUrl, '/', { cookie: 'sillybunny_launch=token=with=equals' })).status).toBe(200);
        expectForbidden(await request(baseUrl, '/', { cookie: 'sillybunny_launch=token' }));
    });
});

describe('launch-token health probe', () => {
    test('answers GET directly without creating or clearing cookies', async () => {
        const baseUrl = await serve({ token }, (app) => {
            app.use((req, res) => res.status(500).end());
        });
        const response = await request(baseUrl, '/__sillybunny/health?probe=1', { cookie: `sillybunny_launch=${token}` });

        expect(response.status).toBe(204);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(response.body).toBe('');
    });

    test.each([undefined, 'sillybunny_launch=wrong'])('rejects an unauthenticated probe (%s)', async (cookie) => {
        const baseUrl = await serve({ token });

        expectForbidden(await request(baseUrl, '/__sillybunny/health', { cookie }));
    });

    test('does not expose the health response on another method or path', async () => {
        const baseUrl = await serve({ token });
        const cookie = `sillybunny_launch=${token}`;

        expect((await request(baseUrl, '/__sillybunny/health', { cookie, method: 'POST' })).body).toBe('ok');
        expect((await request(baseUrl, '/__sillybunny/health/extra', { cookie })).body).toBe('ok');
    });
});

describe('launch-token handoff format', () => {
    test('exports the Android protocol constants', () => {
        expect(LAUNCH_COOKIE_NAME).toBe('sillybunny_launch');
        expect(HEALTH_PATH).toBe('/__sillybunny/health');
        expect(HANDOFF_PATH).toBe('/__sillybunny/handoff');
        expect(HANDOFF_MAX_AGE_MS).toBe(60_000);
        expect(HANDOFF_NONCE_LIMIT).toBe(1024);
    });

    test('matches an independently generated UTF-8 key and big-endian expiry vector', () => {
        const code = createHandoffCode('test-λ-launch-token', {
            nonce: Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'),
            expiry: 1_700_000_030_000,
        });

        expect(code).toBe('AAECAwQFBgcICQoLDA0ODwAAAYvP5d0wZ7msFJBzor7W0VeY7t_wPsF0ybUo0ZMo51gTh-dMbYI');
    });

    test('generates a fresh 16-byte nonce when omitted', () => {
        const first = createHandoffCode(token, { expiry: now + 30_000 });
        const second = createHandoffCode(token, { expiry: now + 30_000 });

        expect(first).toMatch(/^[A-Za-z0-9_-]{75}$/);
        expect(Buffer.from(first, 'base64url')).toHaveLength(56);
        expect(first).not.toBe(second);
    });

    test.each([Buffer.alloc(15), Buffer.alloc(17)])('rejects a nonce of the wrong size (%#)', (nonce) => {
        expect(() => createHandoffCode(token, { nonce, expiry: now + 30_000 })).toThrow(RangeError);
    });

    test('encodes an unsigned 64-bit expiry without rounding', () => {
        const code = createHandoffCode(token, { expiry: 0xffffffffffffffffn });

        expect(Buffer.from(code, 'base64url').subarray(16, 24).toString('hex')).toBe('ffffffffffffffff');
    });
});

describe('launch-token browser handoff', () => {
    test('sets only the session launch cookie and moves to / without needing a cookie', async () => {
        const baseUrl = await serve({ token, now: () => now });
        const code = createHandoffCode(token, { expiry: now + 30_000 });
        const response = await request(baseUrl, `/__sillybunny/handoff?c=${code}`);

        // Not a redirect: Chrome drops the SameSite=Strict cookie on the redirect of a navigation another app started.
        expect(response.status).toBe(200);
        expect(response.headers.location).toBeUndefined();
        expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['set-cookie']).toEqual([
            `sillybunny_launch=${token}; Path=/; HttpOnly; SameSite=Strict`,
        ]);
        expect(response.body).toBe(HANDOFF_PAGE);
        expect(response.body).toContain('<meta http-equiv="refresh" content="0;url=/">');
        expect(response.body).not.toContain(token);
        expect(code).not.toContain(token);
        const cookie = response.headers['set-cookie'][0].split(';')[0];
        expect((await request(baseUrl, '/', { cookie })).status).toBe(200);
    });

    test.each([
        ['expired', now - 1],
        ['expiring now', now],
        ['more than 60 seconds ahead', now + 60_001],
        ['outside the safe integer range', 0xffffffffffffffffn],
    ])('rejects a code %s', async (label, expiry) => {
        const baseUrl = await serve({ token, now: () => now });
        const code = createHandoffCode(token, { expiry });

        expectForbidden(await request(baseUrl, `/__sillybunny/handoff?c=${code}`));
    });

    test.each([1, 60_000])('accepts an expiry %d milliseconds ahead', async (age) => {
        const baseUrl = await serve({ token, now: () => now });
        const code = createHandoffCode(token, { expiry: now + age });

        expect((await request(baseUrl, `/__sillybunny/handoff?c=${code}`)).status).toBe(200);
    });

    test('rejects a tampered MAC without consuming the nonce', async () => {
        const baseUrl = await serve({ token, now: () => now });
        const code = createHandoffCode(token, { expiry: now + 30_000 });
        const bytes = Buffer.from(code, 'base64url');
        bytes[24] ^= 1;

        expectForbidden(await request(baseUrl, `/__sillybunny/handoff?c=${bytes.toString('base64url')}`));
        expect((await request(baseUrl, `/__sillybunny/handoff?c=${code}`)).status).toBe(200);
    });

    test('rejects a code signed by another launch token', async () => {
        const baseUrl = await serve({ token, now: () => now });
        const code = createHandoffCode('another-launch-token', { expiry: now + 30_000 });

        expectForbidden(await request(baseUrl, `/__sillybunny/handoff?c=${code}`));
    });

    test.each([
        ['missing', () => ''],
        ['truncated', code => code.slice(0, -1)],
        ['oversized', code => `${code}AAAA`],
        ['padded', code => `${code}=`],
        ['non-base64url', code => `+${code.slice(1)}`],
        ['whitespace', code => ` ${code.slice(1)}`],
        ['noncanonical trailing bits', (code) => {
            const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
            return code.slice(0, -1) + alphabet[alphabet.indexOf(code.at(-1)) + 1];
        }],
    ])('rejects a %s code', async (label, change) => {
        const baseUrl = await serve({ token, now: () => now });
        const code = createHandoffCode(token, { expiry: now + 30_000 });

        expectForbidden(await request(baseUrl, `/__sillybunny/handoff?c=${encodeURIComponent(change(code))}`));
    });

    test('rejects a missing code even when a launch cookie is valid', async () => {
        const baseUrl = await serve({ token, now: () => now });

        expectForbidden(await request(baseUrl, '/__sillybunny/handoff', { cookie: `sillybunny_launch=${token}` }));
    });

    test('permits only GET to use the unauthenticated handoff route', async () => {
        const baseUrl = await serve({ token, now: () => now });
        const code = createHandoffCode(token, { expiry: now + 30_000 });

        expectForbidden(await request(baseUrl, `/__sillybunny/handoff?c=${code}`, { method: 'POST' }));
        expectForbidden(await request(baseUrl, `/__sillybunny/handoff/extra?c=${code}`));
    });

    test('rejects a replay, including another valid code using the same nonce', async () => {
        const baseUrl = await serve({ token, now: () => now });
        const nonce = Buffer.alloc(16, 1);
        const code = createHandoffCode(token, { nonce, expiry: now + 30_000 });
        const replacement = createHandoffCode(token, { nonce, expiry: now + 40_000 });

        expect((await request(baseUrl, `/__sillybunny/handoff?c=${code}`)).status).toBe(200);
        expectForbidden(await request(baseUrl, `/__sillybunny/handoff?c=${code}`));
        expectForbidden(await request(baseUrl, `/__sillybunny/handoff?c=${replacement}`));
    });

    test('forgets a used nonce at expiry, permitting a newly signed code for it', async () => {
        let currentTime = now;
        const baseUrl = await serve({ token, now: () => currentTime });
        const nonce = Buffer.alloc(16, 2);
        const code = createHandoffCode(token, { nonce, expiry: now + 1 });

        expect((await request(baseUrl, `/__sillybunny/handoff?c=${code}`)).status).toBe(200);
        currentTime += 1;
        expectForbidden(await request(baseUrl, '/__sillybunny/handoff?c=malformed'));
        const replacement = createHandoffCode(token, { nonce, expiry: currentTime + 30_000 });
        expect((await request(baseUrl, `/__sillybunny/handoff?c=${replacement}`)).status).toBe(200);
        expectForbidden(await request(baseUrl, `/__sillybunny/handoff?c=${code}`));
    });

    test('caps replay memory without evicting unexpired nonces and recovers after expiry', () => {
        let currentTime = now;
        const middleware = createLaunchTokenMiddleware({ token, now: () => currentTime });
        const submit = (code) => {
            const response = { setHeader() {}, end() {} };
            middleware({ method: 'GET', url: `/__sillybunny/handoff?c=${code}`, headers: {} }, response, () => {});
            return response;
        };
        const codes = Array.from({ length: HANDOFF_NONCE_LIMIT }, (_, index) => {
            const nonce = Buffer.alloc(16);
            nonce.writeUInt32BE(index);
            return createHandoffCode(token, { nonce, expiry: now + 1 });
        });
        for (const code of codes) {
            expect(submit(code).statusCode).toBe(200);
        }
        const extra = createHandoffCode(token, { expiry: now + 30_000 });
        expect(submit(extra).statusCode).toBe(403);
        expect(submit(codes[0]).statusCode).toBe(403);

        currentTime += 1;
        expect(submit(extra).statusCode).toBe(200);
    });
});

describe('launch-token account session compatibility', () => {
    test('a launch cookie and signed cookie-session retain login data across requests', async () => {
        const baseUrl = await serve({ token }, (app) => {
            app.use(cookieSession({ name: 'session', secret: 'test-session-signing-key', httpOnly: true }));
            app.post('/login', (req, res) => {
                req.session.handle = 'default-user';
                res.status(204).end();
            });
            app.get('/account', (req, res) => res.json({ handle: req.session.handle ?? null }));
        });
        const cookie = `sillybunny_launch=${token}`;
        const login = await request(baseUrl, '/login', { cookie, method: 'POST' });
        expect(login.status).toBe(204);
        expect(login.headers['set-cookie']).toHaveLength(2);
        const sessionCookies = login.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
        const account = await request(baseUrl, '/account', { cookie: `${cookie}; ${sessionCookies}` });

        expect(account.status).toBe(200);
        expect(JSON.parse(account.body)).toEqual({ handle: 'default-user' });
        expect(account.headers['set-cookie']).toBeUndefined();
        expectForbidden(await request(baseUrl, '/account', { cookie: sessionCookies }));
    });
});
