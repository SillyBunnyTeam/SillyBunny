/* global globalThis */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Buffer } from 'node:buffer';
import path from 'node:path';

import {
    PASSED_BODY,
    callMiddleware,
    closeApps,
    createTempDirectory,
    removeTempDirectory,
    resetServerModules,
    seedAccounts,
    startApp,
    writeErrorPage,
} from './util/middleware-harness.js';

const USERNAME = 'test-user';
const PASSWORD = 'pa:ss:word';
const UNAUTHORIZED_PAGE = '<h1>unauthorized</h1>';
const NO_RATE_LIMIT = { SILLYTAVERN_RATELIMITING_BASICAUTHMAXATTEMPTS: '0' };
const LIMIT_OF_ONE = { SILLYTAVERN_RATELIMITING_BASICAUTHMAXATTEMPTS: '1' };
const LIMIT_OF_TWO = { SILLYTAVERN_RATELIMITING_BASICAUTHMAXATTEMPTS: '2' };
const SESSION_AUTH_ON = { SILLYTAVERN_SESSIONAUTH_ENABLED: 'true' };
const ACCOUNTS_ON = { SILLYTAVERN_ENABLEUSERACCOUNTS: 'true' };
const PER_USER_ON = { SILLYTAVERN_PERUSERBASICAUTH: 'true' };

const PASSED = { status: 200, challenge: null, body: PASSED_BODY };
const UNAUTHORIZED = {
    status: 401,
    challenge: 'Basic realm="SillyBunny", charset="UTF-8"',
    body: UNAUTHORIZED_PAGE,
};

function basicHeader(username, password) {
    return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

const RIGHT_CREDENTIALS = basicHeader(USERNAME, PASSWORD);
const WRONG_CREDENTIALS = basicHeader(USERNAME, 'wrong-password');

async function loadBasicAuth(env = {}) {
    await resetServerModules({
        SILLYTAVERN_BASICAUTHUSER_USERNAME: USERNAME,
        SILLYTAVERN_BASICAUTHUSER_PASSWORD: PASSWORD,
        ...env,
    });
    const { default: basicAuthMiddleware } = await import('../src/middleware/basicAuth.js');
    return basicAuthMiddleware;
}

async function outcome(response) {
    return {
        status: response.status,
        challenge: response.headers.get('www-authenticate'),
        body: await response.text(),
    };
}

function sendAuthorization(app, authorization, extraHeaders = {}) {
    return fetch(app.url, { headers: { ...extraHeaders, Authorization: authorization } });
}

async function sendAuthorizationOutcome(app, authorization) {
    return outcome(await sendAuthorization(app, authorization));
}

function fromAddress(remoteAddress, authorization) {
    return {
        socket: { remoteAddress },
        headers: { authorization },
        method: 'GET',
        originalUrl: '/',
    };
}

describe('basic auth middleware', () => {
    let dataRoot;
    let consoleError;

    beforeAll(() => {
        dataRoot = createTempDirectory('sillybunny-basic-auth-');
        writeErrorPage(dataRoot, 'unauthorized.html', UNAUTHORIZED_PAGE);
    });

    beforeEach(() => {
        globalThis.DATA_ROOT = dataRoot;
        consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    afterAll(async () => {
        await closeApps();
        removeTempDirectory(dataRoot);
    });

    describe('with one configured user', () => {
        let app;

        beforeAll(async () => {
            app = await startApp(await loadBasicAuth(NO_RATE_LIMIT));
        });

        test('answers 401 without an Authorization header and forbids caching', async () => {
            const response = await fetch(app.url);

            expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate, private');
            expect(response.headers.get('pragma')).toBe('no-cache');
            expect(response.headers.get('expires')).toBe('0');
            expect(response.headers.get('vary')).toBe('Authorization, Cookie');
            expect(await outcome(response)).toEqual(UNAUTHORIZED);
        });

        test('lets through the configured credentials', async () => {
            expect(await sendAuthorizationOutcome(app, RIGHT_CREDENTIALS)).toEqual(PASSED);
        });

        test('requires the whole password when the password contains colons', async () => {
            const firstPart = PASSWORD.split(':')[0];

            expect(await sendAuthorizationOutcome(app, basicHeader(USERNAME, PASSWORD))).toEqual(PASSED);
            expect(await sendAuthorizationOutcome(app, basicHeader(USERNAME, firstPart))).toEqual(UNAUTHORIZED);
        });

        test.each([
            ['a wrong password', WRONG_CREDENTIALS],
            ['a wrong username', basicHeader('someone-else', PASSWORD)],
            ['an empty username and password', basicHeader('', '')],
            ['Base64 credentials without a colon', `Basic ${Buffer.from(USERNAME).toString('base64')}`],
            ['malformed Base64', 'Basic %%%not-base64%%%'],
            ['the Basic scheme without credentials', 'Basic'],
            ['the right credentials under another scheme', `Negotiate ${RIGHT_CREDENTIALS.split(' ')[1]}`],
            ['a Bearer token', 'Bearer some-token'],
        ])('answers 401 to %s', async (_name, authorization) => {
            expect(await sendAuthorizationOutcome(app, authorization)).toEqual(UNAUTHORIZED);
        });
    });

    test('decodes credentials as UTF-8', async () => {
        const password = 'pässwörd';
        const app = await startApp(await loadBasicAuth({ SILLYTAVERN_BASICAUTHUSER_PASSWORD: password }));

        expect(await sendAuthorizationOutcome(app, basicHeader(USERNAME, password))).toEqual(PASSED);
    });

    test('answers 401 with an empty body when the error page does not exist', async () => {
        globalThis.DATA_ROOT = path.join(dataRoot, 'no-such-folder');
        const app = await startApp(await loadBasicAuth());

        const result = await outcome(await fetch(app.url));

        expect(result).toEqual({ ...UNAUTHORIZED, body: '' });
    });

    describe('cookie session', () => {
        const withSession = (request, _response, next) => {
            const handle = request.get('x-test-session-handle');
            request.session = handle ? { handle } : {};
            next();
        };

        function sendSession(app, handle) {
            return fetch(app.url, { headers: { 'x-test-session-handle': handle } });
        }

        test('lets through a session with a handle when accounts are on', async () => {
            const app = await startApp(withSession, await loadBasicAuth(ACCOUNTS_ON));

            expect(await outcome(await sendSession(app, 'alice'))).toEqual(PASSED);
        });

        test('asks for credentials when a session has no handle and accounts are on', async () => {
            const app = await startApp(withSession, await loadBasicAuth(ACCOUNTS_ON));

            expect(await outcome(await fetch(app.url))).toEqual(UNAUTHORIZED);
        });

        test('ignores a session handle when accounts are off', async () => {
            const app = await startApp(withSession, await loadBasicAuth());

            expect(await outcome(await sendSession(app, 'alice'))).toEqual(UNAUTHORIZED);
        });
    });

    describe('rate limit', () => {
        async function failTimes(app, count) {
            const statuses = [];
            for (let attempt = 0; attempt < count; attempt++) {
                statuses.push((await sendAuthorization(app, WRONG_CREDENTIALS)).status);
            }
            return statuses;
        }

        test.each([
            ['the shipped limit of 5', {}, 5],
            ['a configured limit of 2', LIMIT_OF_TWO, 2],
        ])('answers 429 with Retry-After after %s failures', async (_name, env, limit) => {
            const app = await startApp(await loadBasicAuth(env));

            expect(await failTimes(app, limit)).toEqual(Array(limit).fill(401));

            const limited = await sendAuthorization(app, WRONG_CREDENTIALS);

            expect(limited.status).toBe(429);
            const retryAfter = Number(limited.headers.get('retry-after'));
            expect(retryAfter).toBeGreaterThan(0);
            expect(retryAfter).toBeLessThanOrEqual(60);
            expect(consoleError.mock.calls[0][0]).toBe('Basic auth failed: Rate limited from');
        });

        test('answers 429 to the right credentials after the limit is passed', async () => {
            const app = await startApp(await loadBasicAuth(LIMIT_OF_TWO));
            await failTimes(app, 3);

            const response = await sendAuthorization(app, RIGHT_CREDENTIALS);

            expect(response.status).toBe(429);
            expect(response.headers.get('retry-after')).not.toBeNull();
        });

        test('accepts the right credentials on the attempt after the last allowed failure', async () => {
            const app = await startApp(await loadBasicAuth(LIMIT_OF_TWO));
            await failTimes(app, 2);

            expect(await sendAuthorizationOutcome(app, RIGHT_CREDENTIALS)).toEqual(PASSED);
        });

        test('a successful sign-in clears the failure count', async () => {
            const app = await startApp(await loadBasicAuth(LIMIT_OF_TWO));
            await failTimes(app, 2);
            await sendAuthorization(app, RIGHT_CREDENTIALS);

            expect(await failTimes(app, 3)).toEqual([401, 401, 429]);
        });

        test('counts failures for each client address separately', async () => {
            const middleware = await loadBasicAuth(LIMIT_OF_ONE);
            const fail = address => callMiddleware(middleware, fromAddress(address, WRONG_CREDENTIALS));

            expect((await fail('192.0.2.1')).status).toBe(401);
            expect((await fail('192.0.2.1')).status).toBe(429);
            expect((await fail('192.0.2.2')).status).toBe(401);
        });

        test('forwarded headers do not change the address that is counted', async () => {
            const app = await startApp(await loadBasicAuth(LIMIT_OF_ONE));
            const fail = forwarded => sendAuthorization(app, WRONG_CREDENTIALS, {
                'X-Forwarded-For': forwarded,
                'X-Real-IP': forwarded,
            });

            expect((await fail('192.0.2.1')).status).toBe(401);
            expect((await fail('192.0.2.2')).status).toBe(429);
        });

        test('requests without Basic credentials do not count as failures', async () => {
            const app = await startApp(await loadBasicAuth(LIMIT_OF_ONE));

            for (let attempt = 0; attempt < 3; attempt++) {
                expect(await outcome(await fetch(app.url))).toEqual(UNAUTHORIZED);
                expect(await sendAuthorizationOutcome(app, 'Bearer some-token')).toEqual(UNAUTHORIZED);
            }

            expect(await sendAuthorizationOutcome(app, RIGHT_CREDENTIALS)).toEqual(PASSED);
        });

        test('a limit of 0 turns the rate limit off', async () => {
            const app = await startApp(await loadBasicAuth(NO_RATE_LIMIT));

            expect(await failTimes(app, 8)).toEqual(Array(8).fill(401));
        });

        test('accepts attempts again 60 seconds after the first failure', async () => {
            const middleware = await loadBasicAuth(LIMIT_OF_ONE);
            const attempt = authorization => callMiddleware(middleware, fromAddress('192.0.2.1', authorization));
            jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });

            await attempt(WRONG_CREDENTIALS);
            expect((await attempt(WRONG_CREDENTIALS)).status).toBe(429);

            jest.advanceTimersByTime(59_000);
            expect((await attempt(RIGHT_CREDENTIALS)).status).toBe(429);

            jest.advanceTimersByTime(1_000);
            expect((await attempt(RIGHT_CREDENTIALS)).passed).toBe(true);
        });
    });

    describe('session Bearer token', () => {
        describe('with session auth on', () => {
            let app;
            let sessionAuth;

            beforeAll(async () => {
                app = await startApp(await loadBasicAuth({ ...SESSION_AUTH_ON, ...NO_RATE_LIMIT }));
                sessionAuth = await import('../src/middleware/sessionAuth.js');
            });

            test('lets through a valid token without credentials', async () => {
                const token = sessionAuth.createSession('alice');

                expect(await sendAuthorizationOutcome(app, `Bearer ${token}`)).toEqual(PASSED);
            });

            test('answers 401 to an unknown token', async () => {
                expect(await sendAuthorizationOutcome(app, 'Bearer unknown-token')).toEqual(UNAUTHORIZED);
            });

            test('answers 401 to the Bearer scheme without a token', async () => {
                expect(await sendAuthorizationOutcome(app, 'Bearer')).toEqual(UNAUTHORIZED);
            });

            test('answers 401 to a valid token under the Basic scheme', async () => {
                const token = sessionAuth.createSession('alice');

                expect(await sendAuthorizationOutcome(app, `Basic ${token}`)).toEqual(UNAUTHORIZED);
            });

            test('answers 401 to a destroyed token', async () => {
                const token = sessionAuth.createSession('alice');
                sessionAuth.destroySession(token);

                expect(await sendAuthorizationOutcome(app, `Bearer ${token}`)).toEqual(UNAUTHORIZED);
            });

            test('answers 401 to an expired token', async () => {
                const token = sessionAuth.createSession('alice');
                const { expires } = sessionAuth.validateSession(token);
                jest.spyOn(Date, 'now').mockReturnValue(expires + 1);

                expect(await sendAuthorizationOutcome(app, `Bearer ${token}`)).toEqual(UNAUTHORIZED);
            });

            test('still accepts Basic credentials', async () => {
                expect(await sendAuthorizationOutcome(app, RIGHT_CREDENTIALS)).toEqual(PASSED);
            });
        });

        test('answers 401 to a valid token with session auth off', async () => {
            const app = await startApp(await loadBasicAuth(NO_RATE_LIMIT));
            const { createSession } = await import('../src/middleware/sessionAuth.js');

            expect(await sendAuthorizationOutcome(app, `Bearer ${createSession('alice')}`)).toEqual(UNAUTHORIZED);
        });
    });

    describe('per-user mode', () => {
        const PER_USER_MODE = { ...ACCOUNTS_ON, ...PER_USER_ON };
        let accountsRoot;

        beforeAll(() => {
            accountsRoot = createTempDirectory('sillybunny-basic-auth-accounts-');
        });

        afterAll(() => {
            removeTempDirectory(accountsRoot);
        });

        describe('with accounts', () => {
            let app;

            beforeAll(async () => {
                app = await startApp(await loadBasicAuth({ ...PER_USER_MODE, ...NO_RATE_LIMIT }));
                await seedAccounts(accountsRoot);
            });

            test('lets through an account with its password', async () => {
                expect(await sendAuthorizationOutcome(app, basicHeader('alice', 'alice-pass'))).toEqual(PASSED);
            });

            test.each([
                ['a wrong account password', 'alice', 'wrong-password'],
                ['an unknown handle', 'nobody', 'alice-pass'],
                ['a disabled account with its password', 'bob', 'bob-pass'],
                ['an account without a password', 'carol', ''],
                ['the configured single-user credentials', USERNAME, PASSWORD],
            ])('answers 401 to %s', async (_name, username, password) => {
                expect(await sendAuthorizationOutcome(app, basicHeader(username, password))).toEqual(UNAUTHORIZED);
            });

            test('answers 500 and stops the request when an account record cannot be checked', async () => {
                const result = await sendAuthorizationOutcome(app, basicHeader('dave', 'any-password'));

                expect(result.status).toBe(500);
                expect(result.body).not.toBe(PASSED_BODY);
                expect(consoleError.mock.calls[0][0]).toBe('Basic auth error:');
            });
        });

        test('counts account failures and clears them on a successful sign-in', async () => {
            const app = await startApp(await loadBasicAuth({ ...PER_USER_MODE, ...LIMIT_OF_ONE }));
            await seedAccounts(accountsRoot);
            const fail = () => sendAuthorization(app, basicHeader('alice', 'wrong-password'));

            expect((await fail()).status).toBe(401);
            expect(await sendAuthorizationOutcome(app, basicHeader('alice', 'alice-pass'))).toEqual(PASSED);
            expect((await fail()).status).toBe(401);
            expect((await fail()).status).toBe(429);
        });

        test.each([
            ['perUserBasicAuth is on and accounts are off', PER_USER_ON],
            ['accounts are on and perUserBasicAuth is off', ACCOUNTS_ON],
        ])('uses the configured credentials when %s', async (_name, env) => {
            const app = await startApp(await loadBasicAuth({ ...env, ...NO_RATE_LIMIT }));
            await seedAccounts(accountsRoot);

            expect(await sendAuthorizationOutcome(app, RIGHT_CREDENTIALS)).toEqual(PASSED);
            expect(await sendAuthorizationOutcome(app, basicHeader('alice', 'alice-pass'))).toEqual(UNAUTHORIZED);
        });
    });
});
