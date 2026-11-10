import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cookieSession from 'cookie-session';
import express from 'express';
import multer from 'multer';
import storage from 'node-persist';

import { DEFAULT_USER, UPLOADS_DIRECTORY } from '../../src/constants.js';
import multerMonkeyPatch from '../../src/middleware/multerMonkeyPatch.js';
import { createUploadStorage } from '../../src/middleware/uploadStorage.js';
import { keyToEnv, setConfigFilePath } from '../../src/util.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const CLIENT_ADDRESS_HEADER = 'x-test-client-address';

export const ADMIN = Object.freeze({ handle: 'admin-user', name: 'Admin User', password: 'admin-secret', admin: true, enabled: true, created: 1000 });
export const MEMBER = Object.freeze({ handle: 'member-user', name: 'Member User', password: 'member-secret', admin: false, enabled: true, created: 2000 });
export const OPEN_MEMBER = Object.freeze({ handle: 'open-user', name: 'Open User', password: '', admin: false, enabled: true, created: 3000 });
export const DISABLED_MEMBER = Object.freeze({ handle: 'disabled-user', name: 'Disabled User', password: '', admin: false, enabled: false, created: 4000 });

/**
 * Reads a response as its status and its parsed body.
 * @param {Response} response Response to read
 * @returns {Promise<{status: number, body: any}>} Status, and the body as JSON when it parses, as text when it does not
 */
export async function readReply(response) {
    const text = await response.text();
    try {
        return { status: response.status, body: JSON.parse(text) };
    } catch {
        return { status: response.status, body: text };
    }
}

/**
 * Finds the newest recovery or reset code in the silenced console output.
 * The routes only print these codes, so the console is the single way to read them.
 * @returns {string} Six-digit code
 */
export function lastLoggedCode() {
    const line = console.log.mock.calls
        .map(([message]) => String(message ?? '').replace(/\u001b\[[0-9;]*m/g, ''))
        .filter(message => message.includes('code is: '))
        .at(-1);
    return line.match(/code is: (\d{6})/)[1];
}

class AccountClient {
    cookies = new Map();

    constructor(baseUrl, cookieName, address) {
        this.baseUrl = baseUrl;
        this.cookieName = cookieName;
        this.address = address;
    }

    get hasSession() {
        return this.cookies.has(this.cookieName);
    }

    async request(method, route, { headers = {}, body } = {}) {
        const cookieHeader = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
        const response = await fetch(this.baseUrl + route, {
            method,
            headers: {
                ...headers,
                ...(this.address ? { [CLIENT_ADDRESS_HEADER]: this.address } : {}),
                ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            },
            body,
        });
        for (const cookie of response.headers.getSetCookie()) {
            const [name, value] = cookie.split(';')[0].split(/=(.*)/s);
            if (value) {
                this.cookies.set(name, value);
            } else {
                this.cookies.delete(name);
            }
        }
        return response;
    }

    get(route) {
        return this.request('GET', route);
    }

    post(route, body = {}) {
        return this.request('POST', route, {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    upload(route, fileName, content) {
        const form = new FormData();
        form.append('avatar', new Blob([content]), fileName);
        return this.request('POST', route, { body: form });
    }

    login(handle, password) {
        return this.post('/api/users/login', { handle, password });
    }

    /**
     * Replaces the session data and keeps the old signature, which then does not match.
     * @param {object} session Session data
     */
    useTamperedSession(session) {
        this.cookies.set(this.cookieName, Buffer.from(JSON.stringify(session)).toString('base64'));
    }
}

/**
 * Starts the account routers on port 0 over a temporary data root.
 * The routers read config when imported, so call this once per test file, before any other import of them.
 * The middleware order matches the real server, so the login check protects the private and admin routers only.
 * @param {object} [options] Options
 * @param {Record<string, string|number|boolean>} [options.config] Config keys to set through the environment
 * @returns {Promise<object>} Server handle
 */
export async function startAccountServer({ config = {} } = {}) {
    const originalWorkingDirectory = process.cwd();
    const originalDataRoot = global.DATA_ROOT;
    const dataRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-accounts-'));

    for (const [key, value] of Object.entries({ enableUserAccounts: true, ...config })) {
        process.env[keyToEnv(key)] = String(value);
    }
    // ensurePublicDirectoriesExist creates relative folders, so the working directory must not be the checkout.
    process.chdir(dataRoot);
    global.DATA_ROOT = dataRoot;
    setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

    for (const method of ['debug', 'info', 'warn', 'error', 'log']) {
        jest.spyOn(console, method).mockImplementation(() => {});
    }

    const users = await import('../../src/users.js');
    const { router: publicRouter } = await import('../../src/endpoints/users-public.js');
    const { router: privateRouter } = await import('../../src/endpoints/users-private.js');
    const { router: adminRouter } = await import('../../src/endpoints/users-admin.js');

    await users.initUserStorage(dataRoot);

    const cookieName = users.getCookieSessionName();
    const cookieSecret = users.getCookieSecret(dataRoot);

    const app = express();
    // The limiters count per socket address, so this lets one test file act as several clients.
    app.use((request, _response, next) => {
        const address = request.headers[CLIENT_ADDRESS_HEADER];
        if (address) {
            Object.defineProperty(request.socket, 'remoteAddress', { configurable: true, value: address });
        }
        next();
    });
    app.use(express.json({ limit: '500mb' }));
    app.use(express.urlencoded({ extended: true, limit: '500mb' }));
    app.use(cookieSession({
        name: cookieName,
        sameSite: 'lax',
        httpOnly: true,
        maxAge: users.getSessionCookieAge(),
        secret: cookieSecret,
    }));
    app.use(users.setUserDataMiddleware);
    app.use('/api/users', publicRouter);
    app.use(users.requireLoginMiddleware);
    app.use(multer({
        storage: createUploadStorage(path.join(dataRoot, UPLOADS_DIRECTORY)),
        limits: { fieldSize: 500 * 1024 * 1024 },
    }).single('avatar'));
    app.use(multerMonkeyPatch);
    app.use('/api/users', privateRouter);
    app.use('/api/users', adminRouter);

    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const records = [ADMIN, MEMBER, OPEN_MEMBER, DISABLED_MEMBER].map(({ password, ...account }) => {
        const salt = password ? `fixed-salt-${account.handle}` : '';
        return { ...account, salt, password: password ? users.getPasswordHash(password, salt) : '' };
    });
    records.push({ ...DEFAULT_USER });

    let storageSpies = [];

    return {
        dataRoot,
        users,

        client: address => new AccountClient(baseUrl, cookieName, address),

        /**
         * Logs a new client in.
         * @param {{handle: string, password?: string}} account Account to log in with
         * @param {string} [address] Client address that the server sees
         * @returns {Promise<AccountClient>} Client with a session
         */
        async loginAs({ handle, password }, address) {
            const client = this.client(address);
            const response = await client.login(handle, password || undefined);
            if (response.status !== 200) {
                throw new Error(`Login as ${handle} answered ${response.status}`);
            }
            return client;
        },

        account: handle => storage.getItem(users.toKey(handle)),

        userRoot: handle => users.getUserDirectories(handle).root,

        /**
         * Restores the seed accounts and removes their data folders.
         * Also clears console output and any storage failure that a test set up.
         */
        async reset() {
            for (const spy of storageSpies) {
                spy.mockRestore();
            }
            storageSpies = [];
            await storage.clear();
            for (const record of records) {
                await storage.setItem(users.toKey(record.handle), { ...record });
                fs.rmSync(users.getUserDirectories(record.handle).root, { recursive: true, force: true, maxRetries: 5 });
            }
            console.log.mockClear();
        },

        /**
         * Makes the next call of a storage method reject. The next reset() removes the failure.
         * @param {string} method Storage method name
         */
        failStorageOnce(method) {
            storageSpies.push(jest.spyOn(storage, method).mockRejectedValueOnce(new Error('storage failure')));
        },

        async close() {
            server.closeAllConnections();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            storage.stopWriteQueueInterval();
            jest.restoreAllMocks();
            process.chdir(originalWorkingDirectory);
            global.DATA_ROOT = originalDataRoot;
            fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5 });
        },
    };
}
