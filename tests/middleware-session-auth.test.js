import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';

import { createTempDirectory, removeTempDirectory, resetServerModules, seedAccounts } from './util/middleware-harness.js';
import { MODULE_RELOAD_TIMEOUT_MS } from './util/module-reload-timeout.js';

jest.setTimeout(MODULE_RELOAD_TIMEOUT_MS);

const FIXED_TIME = Date.UTC(2026, 0, 15, 12, 0, 0);
const MINUTE_MS = 60 * 1000;
const USERNAME = 'test-user';
const PASSWORD = 'test-password';
const CONFIGURED_USER = {
    SILLYTAVERN_BASICAUTHUSER_USERNAME: USERNAME,
    SILLYTAVERN_BASICAUTHUSER_PASSWORD: PASSWORD,
};

async function loadSessionAuth(env = {}) {
    await resetServerModules(env);
    return import('../src/middleware/sessionAuth.js');
}

describe('session auth', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('sessions', () => {
        let sessionAuth;

        beforeAll(async () => {
            sessionAuth = await loadSessionAuth();
        });

        test('createSession returns a different URL-safe token for each call', () => {
            const first = sessionAuth.createSession('alice');
            const second = sessionAuth.createSession('alice');

            expect(first).toMatch(/^[A-Za-z0-9_-]{64}$/);
            expect(second).toMatch(/^[A-Za-z0-9_-]{64}$/);
            expect(first).not.toBe(second);
        });

        test('validateSession returns the username and an expiry 480 minutes ahead by default', () => {
            jest.spyOn(Date, 'now').mockReturnValue(FIXED_TIME);

            const token = sessionAuth.createSession('alice');

            expect(sessionAuth.validateSession(token)).toEqual({
                username: 'alice',
                expires: FIXED_TIME + 480 * MINUTE_MS,
            });
        });

        test('a session stays valid until its expiry time', () => {
            const now = jest.spyOn(Date, 'now').mockReturnValue(FIXED_TIME);
            const token = sessionAuth.createSession('alice');

            now.mockReturnValue(FIXED_TIME + 480 * MINUTE_MS);

            expect(sessionAuth.validateSession(token)).not.toBeNull();
        });

        test('an expired session is rejected and removed', () => {
            const now = jest.spyOn(Date, 'now').mockReturnValue(FIXED_TIME);
            const token = sessionAuth.createSession('alice');

            now.mockReturnValue(FIXED_TIME + 480 * MINUTE_MS + 1);
            expect(sessionAuth.validateSession(token)).toBeNull();

            now.mockReturnValue(FIXED_TIME);
            expect(sessionAuth.validateSession(token)).toBeNull();
        });

        test('an unknown token is rejected', () => {
            expect(sessionAuth.validateSession('unknown-token')).toBeNull();
        });

        test('destroySession ends only the given session', () => {
            const ended = sessionAuth.createSession('alice');
            const kept = sessionAuth.createSession('bob');

            sessionAuth.destroySession(ended);

            expect(sessionAuth.validateSession(ended)).toBeNull();
            expect(sessionAuth.validateSession(kept)?.username).toBe('bob');
        });

        test('destroySession accepts an unknown token', () => {
            expect(() => sessionAuth.destroySession('unknown-token')).not.toThrow();
        });
    });

    test('sessionAuth.durationMinutes sets the session length', async () => {
        const { createSession, validateSession } = await loadSessionAuth({ SILLYTAVERN_SESSIONAUTH_DURATIONMINUTES: '15' });
        const now = jest.spyOn(Date, 'now').mockReturnValue(FIXED_TIME);

        const token = createSession('alice');
        expect(validateSession(token)?.expires).toBe(FIXED_TIME + 15 * MINUTE_MS);

        now.mockReturnValue(FIXED_TIME + 15 * MINUTE_MS + 1);
        expect(validateSession(token)).toBeNull();
    });

    test.each([
        ['true', true],
        ['false', false],
    ])('isSessionAuthEnabled follows the variable value %s', async (value, expected) => {
        const { isSessionAuthEnabled } = await loadSessionAuth({ SILLYTAVERN_SESSIONAUTH_ENABLED: value });

        expect(isSessionAuthEnabled()).toBe(expected);
    });

    test('isSessionAuthEnabled is false in the shipped default config', async () => {
        const { isSessionAuthEnabled } = await loadSessionAuth();

        expect(isSessionAuthEnabled()).toBe(false);
    });

    describe('validateCredentials', () => {
        describe.each([
            ['perUserBasicAuth and accounts are off', {}],
            ['only perUserBasicAuth is on', { SILLYTAVERN_PERUSERBASICAUTH: 'true' }],
            ['only accounts are on', { SILLYTAVERN_ENABLEUSERACCOUNTS: 'true' }],
        ])('when %s', (_name, env) => {
            let validateCredentials;

            beforeAll(async () => {
                ({ validateCredentials } = await loadSessionAuth({ ...CONFIGURED_USER, ...env }));
            });

            test('accepts the configured credentials', async () => {
                await expect(validateCredentials(USERNAME, PASSWORD)).resolves.toBe(true);
            });

            test.each([
                ['a wrong password', USERNAME, 'wrong-password'],
                ['a wrong username', 'someone-else', PASSWORD],
                ['an empty password', USERNAME, ''],
            ])('rejects %s', async (_title, username, password) => {
                await expect(validateCredentials(username, password)).resolves.toBe(false);
            });
        });

        describe('when perUserBasicAuth and accounts are on', () => {
            let accountsRoot;
            let validateCredentials;

            beforeAll(async () => {
                accountsRoot = createTempDirectory('sillybunny-session-auth-');
                ({ validateCredentials } = await loadSessionAuth({
                    ...CONFIGURED_USER,
                    SILLYTAVERN_PERUSERBASICAUTH: 'true',
                    SILLYTAVERN_ENABLEUSERACCOUNTS: 'true',
                }));
                await seedAccounts(accountsRoot);
            });

            afterAll(() => {
                removeTempDirectory(accountsRoot);
            });

            test('accepts an account with its password', async () => {
                await expect(validateCredentials('alice', 'alice-pass')).resolves.toBe(true);
            });

            test.each([
                ['a wrong account password', 'alice', 'wrong-password'],
                ['an unknown handle', 'nobody', 'alice-pass'],
                ['a disabled account with its password', 'bob', 'bob-pass'],
                ['an account without a password', 'carol', ''],
                ['the configured single-user credentials', USERNAME, PASSWORD],
            ])('rejects %s', async (_title, username, password) => {
                await expect(validateCredentials(username, password)).resolves.toBe(false);
            });
        });
    });
});
