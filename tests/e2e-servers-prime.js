import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { SERVER_LIST_VARIABLE, isFirstRunOver, waitUntilFirstRunIsOver } from './e2e-servers.js';
import { seedRestartCacheClearForUrl } from './helpers/restart-cache-clear-seed.js';

const LAUNCHERS = { chromium, firefox, webkit };
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
 * Boots the app once on each server that still has a pending first run, using the requested browser engine.
 * The first boot on a fresh data root completes the Welcome persona flow and clears the first-run flag on disk.
 * @param {{ url: string, dataRoot: string }[]} servers
 * @param {string} [browserName]
 */
export async function primeServerList(servers, browserName = 'chromium') {
    const pending = servers.filter(({ dataRoot }) => !isFirstRunOver(dataRoot));
    if (!pending.length) {
        return;
    }

    const browser = await resolvePrimeBrowser(browserName).launch();
    try {
        await Promise.all(pending.map(async ({ url, dataRoot }) => {
            const storageState = browserName === 'firefox' ? await seedRestartCacheClearForUrl(url) : undefined;
            const context = await browser.newContext({ baseURL: url, ...(storageState && { storageState }) });
            // All servers do their first boot at the same time, which can take longer than the default 30 s.
            context.setDefaultTimeout(180_000);
            try {
                await testSetup.awaitST({ page: await context.newPage() });
                // The app saves the end of the first run after a delay. A page that closes before that save leaves
                // the first run open, and each later boot shows the first-run prompt.
                await waitUntilFirstRunIsOver(dataRoot);
            } finally {
                await context.close();
            }
        }));
    } finally {
        await browser.close();
    }
}

/**
 * Playwright `globalSetup` entry point for `SILLYBUNNY_TEST_SERVERS`.
 * @param {import('@playwright/test').FullConfig} [config]
 */
export default async function primeServers(config) {
    const servers = JSON.parse(process.env[SERVER_LIST_VARIABLE]);
    const browserName = config?.projects?.[0]?.use?.browserName || 'chromium';
    await primeServerList(servers, browserName);
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
