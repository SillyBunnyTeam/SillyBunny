import fs from 'node:fs';
import path from 'node:path';
import { chromium, request as playwrightRequest } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { fetchRestartCacheClearCookies } from './helpers/restart-cache-clear-seed.js';
import {
    DEFAULT_USER_HANDLE,
    SERVER_LIST_VARIABLE,
    STORAGE_DIRECTORY,
    getWorkerAccountHandle,
    getWorkerStorageStatePath,
    isAccountIsolationEnabled,
    waitUntilFirstRunIsOver,
} from './e2e-servers.js';

const PRIMED_SUBDIRECTORIES = ['InChatAgents', 'InChatAgentGroups'];

/**
 * Merges two cookie lists, keeping the first occurrence of each cookie name.
 * @param {import('@playwright/test').Cookie[]} primary
 * @param {import('@playwright/test').Cookie[]} secondary
 * @returns {import('@playwright/test').Cookie[]}
 */
function mergeCookies(primary, secondary) {
    const seen = new Set(primary.map(cookie => cookie.name));
    return [...primary, ...secondary.filter(cookie => !seen.has(cookie.name))];
}

/**
 * Signs into a passwordless account on a managed server and returns its API client, fresh CSRF token, and cookies.
 * @param {string} baseURL
 * @param {string} handle
 */
async function loginAccount(baseURL, handle) {
    const client = await playwrightRequest.newContext({ baseURL });
    try {
        const csrfResponse = await client.get('/csrf-token');
        if (!csrfResponse.ok()) {
            throw new Error(`GET /csrf-token on ${baseURL} answered ${csrfResponse.status()}.`);
        }
        const { token } = await csrfResponse.json();
        const loginResponse = await client.post('/api/users/login', {
            headers: { 'X-CSRF-Token': token },
            data: { handle, password: '' },
        });
        if (!loginResponse.ok()) {
            throw new Error(`Could not sign in as "${handle}" on ${baseURL} (${loginResponse.status()}): ${await loginResponse.text()}`);
        }
        const authedCsrf = await client.get('/csrf-token');
        if (!authedCsrf.ok()) {
            throw new Error(`GET /csrf-token after login on ${baseURL} answered ${authedCsrf.status()}.`);
        }
        const { token: authedToken } = await authedCsrf.json();
        const { cookies } = await client.storageState();
        return { client, token: authedToken, cookies };
    } catch (error) {
        await client.dispose();
        throw error;
    }
}

/**
 * Copies the primed first-run settings and bundled agent definitions from default-user into a worker account.
 * Per-account secrets, stats and backups stay untouched so each worker keeps its own CSRF secret and clean state.
 * @param {string} dataRoot
 * @param {string} handle
 */
function copyPrimedUserFiles(dataRoot, handle) {
    const sourceRoot = path.join(dataRoot, DEFAULT_USER_HANDLE);
    const targetRoot = path.join(dataRoot, handle);
    fs.copyFileSync(path.join(sourceRoot, 'settings.json'), path.join(targetRoot, 'settings.json'));
    for (const subdirectory of PRIMED_SUBDIRECTORIES) {
        const sourceDir = path.join(sourceRoot, subdirectory);
        if (fs.existsSync(sourceDir)) {
            fs.cpSync(sourceDir, path.join(targetRoot, subdirectory), { recursive: true, force: true });
        }
    }
}

/**
 * Boots the app once on each managed server to complete first-run setup, seeds one admin account per parallel
 * worker when account isolation is enabled, and writes each worker's storage state (session + restart-cache-clear
 * cookies, with empty localStorage).
 * @param {import('@playwright/test').FullConfig} [config]
 */
export default async function primeServers(config) {
    const servers = JSON.parse(process.env[SERVER_LIST_VARIABLE]);
    const workerCount = Math.max(1, Number(config?.workers) || 1);
    const isolateAccounts = isAccountIsolationEnabled(process.env, true);
    const browser = await chromium.launch();
    try {
        await Promise.all(servers.map(async (server, serverIndex) => {
            const { url, dataRoot } = server;
            const cacheClearCookies = await fetchRestartCacheClearCookies(url);
            let adminSession = null;
            try {
                if (isolateAccounts) {
                    adminSession = await loginAccount(url, DEFAULT_USER_HANDLE);
                }

                const primeCookies = mergeCookies(adminSession?.cookies ?? [], cacheClearCookies);
                const context = await browser.newContext({
                    baseURL: url,
                    storageState: { cookies: primeCookies, origins: [] },
                });
                try {
                    // All servers do their first boot at the same time, which can take longer than the default 30 s.
                    context.setDefaultTimeout(180_000);
                    await testSetup.awaitST({ page: await context.newPage() });
                    // The app saves the end of the first run after a delay. A page that closes before that save leaves
                    // the first run open, and each later boot shows the first-run prompt.
                    await waitUntilFirstRunIsOver(dataRoot);
                } finally {
                    await context.close();
                }

                fs.mkdirSync(path.join(dataRoot, STORAGE_DIRECTORY), { recursive: true });
                if (!isolateAccounts) {
                    const statePath = getWorkerStorageStatePath(server, 0, { isolateAccounts: false });
                    fs.writeFileSync(statePath, JSON.stringify({ cookies: cacheClearCookies, origins: [] }));
                    return;
                }

                // Create and sign in worker accounts sequentially per server so node-persist, content.log and loginLimiter do not race.
                for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
                    if (workerIndex % servers.length !== serverIndex) {
                        continue;
                    }
                    const handle = getWorkerAccountHandle(workerIndex);
                    const createResponse = await adminSession.client.post('/api/users/create', {
                        headers: { 'X-CSRF-Token': adminSession.token },
                        data: { handle, name: `Worker ${workerIndex}`, password: '', admin: true },
                    });
                    if (!createResponse.ok() && createResponse.status() !== 409) {
                        throw new Error(`Could not create test account "${handle}" on ${url} (${createResponse.status()}): ${await createResponse.text()}`);
                    }
                    copyPrimedUserFiles(dataRoot, handle);
                    const workerSession = await loginAccount(url, handle);
                    await workerSession.client.dispose();
                    const statePath = getWorkerStorageStatePath(server, workerIndex, { isolateAccounts: true });
                    fs.writeFileSync(statePath, JSON.stringify({
                        cookies: mergeCookies(workerSession.cookies, cacheClearCookies),
                        origins: [],
                    }));
                }
            } finally {
                await adminSession?.client.dispose();
            }
        }));
    } finally {
        await browser.close();
    }
}
