import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit, request as playwrightRequest } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { fetchRestartCacheClearCookies } from './helpers/restart-cache-clear-seed.js';
import {
    DEFAULT_USER_HANDLE,
    SERVER_LIST_VARIABLE,
    STORAGE_DIRECTORY,
    getWorkerAccountHandle,
    getWorkerStorageStatePath,
    isAccountIsolationEnabled,
    isFirstRunOver,
    waitUntilFirstRunIsOver,
} from './e2e-servers.js';

const LAUNCHERS = { chromium, firefox, webkit };
const PRIMED_SUBDIRECTORIES = ['InChatAgents', 'InChatAgentGroups'];
const currentFile = fileURLToPath(import.meta.url);
const repositoryDirectory = path.resolve(path.dirname(currentFile), '..');

/**
 * Resolves the Playwright browser launcher for priming.
 * @param {string} browserName
 */
export function resolvePrimeBrowser(browserName = 'chromium') {
    const launcher = LAUNCHERS[browserName];
    if (!launcher) {
        throw new Error(`Unsupported prime browser "${browserName}". Expected one of: ${Object.keys(LAUNCHERS).join(', ')}.`);
    }
    return launcher;
}

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
 * Boots the app once on each server to complete first-run setup using the requested browser engine, and when
 * managing isolated test servers, seeds per-worker admin accounts and writes worker storage states.
 * @param {{ url: string, dataRoot: string }[]} servers
 * @param {string} [browserName]
 * @param {{ workerCount?: number, isolateAccounts?: boolean, writeStorageState?: boolean }} [options]
 */
export async function primeServerList(servers, browserName = 'chromium', options = {}) {
    const {
        workerCount = 1,
        isolateAccounts = false,
        writeStorageState = false,
    } = options;
    const targets = writeStorageState
        ? servers
        : servers.filter(({ dataRoot }) => !isFirstRunOver(dataRoot));
    if (!targets.length) {
        return;
    }

    const browser = await resolvePrimeBrowser(browserName).launch();
    try {
        await Promise.all(targets.map(async (server, serverIndex) => {
            const { url, dataRoot } = server;
            const cacheClearCookies = await fetchRestartCacheClearCookies(url);
            let adminSession = null;
            try {
                if (isolateAccounts) {
                    adminSession = await loginAccount(url, DEFAULT_USER_HANDLE);
                }

                if (!isFirstRunOver(dataRoot)) {
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
                }

                if (!writeStorageState) {
                    return;
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

/**
 * Playwright `globalSetup` entry point for managed test servers.
 * @param {import('@playwright/test').FullConfig} [config]
 */
export default async function primeServers(config) {
    const servers = JSON.parse(process.env[SERVER_LIST_VARIABLE]);
    const browserName = config?.projects?.[0]?.use?.browserName || 'chromium';
    const workerCount = Math.max(1, Number(config?.workers) || 1);
    const isolateAccounts = isAccountIsolationEnabled(process.env, true);
    await primeServerList(servers, browserName, {
        workerCount,
        isolateAccounts,
        writeStorageState: true,
    });
}

/**
 * Parses CLI options for standalone priming in CI (`node tests/e2e-servers-prime.js --browser=webkit`).
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parsePrimeCliArgs(argv, env = process.env) {
    let browserName = 'chromium';
    let url = env.SILLYBUNNY_TEST_BASE_URL || env.ST_BASE_URL || env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4444';
    let dataRoot = path.join(repositoryDirectory, 'data');

    for (const arg of argv) {
        if (arg.startsWith('--browser=')) {
            browserName = arg.slice('--browser='.length);
        } else if (arg.startsWith('--url=')) {
            url = arg.slice('--url='.length);
        } else if (arg.startsWith('--data-root=')) {
            dataRoot = path.resolve(arg.slice('--data-root='.length));
        } else {
            throw new Error(`Unknown argument "${arg}".`);
        }
    }

    resolvePrimeBrowser(browserName);
    return { browserName, url, dataRoot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
    const { browserName, url, dataRoot } = parsePrimeCliArgs(process.argv.slice(2));
    await primeServerList([{ url, dataRoot }], browserName);
}
