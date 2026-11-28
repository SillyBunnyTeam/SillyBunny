import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SERVER_LIST_VARIABLE } from '../e2e-servers.js';

/*
 * After a server start, the first load of every browser clears the caches twice and reloads each time
 * (public/scripts/sillybunny-restart-cache-clear.js). A Playwright context starts without cookies, so every test
 * meets those reloads.
 *
 * Chromium resolves `goto()` after the last reload. Gecko resolves `goto({ waitUntil: 'domcontentloaded' })` on the
 * first document, which the first reload then replaces, so the next call into the page fails with "Execution context
 * was destroyed". A context that already holds the cookies of a finished clear loads once.
 *
 * `globalSetup` writes those cookies as a storage state that `restartCacheClearStatePath()` locates, for a config to
 * pass as `use.storageState`. The cookie names and the number of passes are read from the page script the server
 * serves, so they cannot drift from what the browser runs. The value format is checked against the server: the setup
 * fails when the seeded cookies still make it ask for a clear.
 */

const PAGE_SCRIPT_PATH = '/scripts/sillybunny-restart-cache-clear.js';

/**
 * Where the seeded storage state of a server is written. It is rewritten on every run.
 * @param {string} baseURL
 * @returns {string}
 */
export function restartCacheClearStatePath(baseURL) {
    const { hostname, port } = new URL(baseURL);
    return path.join(os.tmpdir(), `sillybunny-restart-cache-clear-${hostname}-${port || 'default'}.json`);
}

/**
 * Reads the cookie names and the pass count from the source of the page script.
 * @param {string} source
 * @returns {{ bootCookie: string, progressCookie: string, passes: number }}
 */
export function parseRestartCacheClear(source) {
    const read = (name, pattern) => {
        const match = source.match(pattern);
        if (!match) {
            throw new Error(`${PAGE_SCRIPT_PATH} has no \`var ${name} = ...;\` line, so the restart cache clear cannot be seeded. Update parseRestartCacheClear().`);
        }
        return match[1];
    };
    return {
        bootCookie: read('BOOT_COOKIE', /var BOOT_COOKIE = '([^']+)';/),
        progressCookie: read('PROGRESS_COOKIE', /var PROGRESS_COOKIE = '([^']+)';/),
        passes: Number(read('PASSES', /var PASSES = (\d+);/)),
    };
}

/**
 * The cookies of a browser that has finished every pass for one server start. The progress value is
 * `<boot id>.<passes>`, URI-encoded, as the page script writes it.
 * @param {{ bootCookie: string, progressCookie: string, passes: number }} names
 * @param {{ bootId: string, hostname: string }} server
 * @returns {import('@playwright/test').Cookie[]}
 */
export function buildClearedCookies({ bootCookie, progressCookie, passes }, { bootId, hostname }) {
    const cookie = (name, value) => ({ name, value, domain: hostname, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' });
    return [
        cookie(bootCookie, bootId),
        cookie(progressCookie, encodeURIComponent(`${bootId}.${passes}`)),
    ];
}

/**
 * Fetches the restart-cache-clear cookies for a server start and verifies that sending them stops the clear.
 * Returns an empty list when the server does not ask for a cache clear.
 * @param {string} baseURL
 * @returns {Promise<import('@playwright/test').Cookie[]>}
 */
export async function fetchRestartCacheClearCookies(baseURL) {
    // Do not follow a redirect to /login: restartCacheClear runs on `/` before the login redirect.
    const index = await fetch(`${baseURL}/`, { redirect: 'manual' });
    const setCookies = index.headers.getSetCookie();

    const script = await fetch(new URL(PAGE_SCRIPT_PATH, baseURL));
    if (!script.ok) {
        throw new Error(`GET ${PAGE_SCRIPT_PATH} answered ${script.status}.`);
    }
    const names = parseRestartCacheClear(await script.text());
    const bootLine = setCookies.find(line => line.startsWith(`${names.bootCookie}=`));
    if (!bootLine) {
        return [];
    }

    const cookies = buildClearedCookies(names, {
        bootId: decodeURIComponent(bootLine.split(';')[0].slice(names.bootCookie.length + 1)),
        hostname: new URL(baseURL).hostname,
    });
    const seeded = await fetch(`${baseURL}/`, {
        redirect: 'manual',
        headers: { cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') },
    });
    if (seeded.headers.has('clear-site-data')) {
        throw new Error('The server still asks for a cache clear after the cookies were seeded, so the cookie format no longer matches restartCacheClear.js.');
    }
    return cookies;
}

/**
 * Writes the cleared restart-cache-clear storage state for one server URL.
 * A server that does not ask for a clear gets an empty state.
 * @param {string} baseURL
 * @returns {Promise<string>} Path to the written storage state file
 */
export async function seedRestartCacheClearForUrl(baseURL) {
    const statePath = restartCacheClearStatePath(baseURL);
    const cookies = await fetchRestartCacheClearCookies(baseURL);
    fs.writeFileSync(statePath, JSON.stringify({ cookies, origins: [] }));
    return statePath;
}

/**
 * Playwright `globalSetup`: writes the storage state of a browser whose restart cache clear is done.
 * Seeds every server in `SILLYBUNNY_TEST_SERVER_LIST` when set, otherwise the project's base URL.
 * @param {import('@playwright/test').FullConfig} config
 */
export default async function seedRestartCacheClear(config) {
    const serverList = process.env[SERVER_LIST_VARIABLE];
    if (serverList) {
        const servers = JSON.parse(serverList);
        await Promise.all(servers.map(({ url }) => seedRestartCacheClearForUrl(url)));
        return;
    }
    return seedRestartCacheClearForUrl(config.projects[0].use.baseURL);
}
