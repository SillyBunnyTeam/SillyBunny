import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
    DEFAULT_USER_HANDLE,
    SERVER_LIST_VARIABLE,
    WORKER_HANDLE_VARIABLE,
    getServerUrl,
    getWorkerAccountHandle,
    isAccountIsolationEnabled,
    isFirstRunOver,
} from './e2e-servers.js';

const servers = process.env[SERVER_LIST_VARIABLE] ? JSON.parse(process.env[SERVER_LIST_VARIABLE]) : null;
const baseUrlAtLoad = process.env.SILLYBUNNY_TEST_BASE_URL;
const workerHandleAtLoad = process.env[WORKER_HANDLE_VARIABLE];
const accountIsolation = Boolean(servers) && isAccountIsolationEnabled(process.env, true);

/**
 * Mutates an account-scoped setting on the server through the real CSRF-protected endpoints and reads it back.
 * @param {import('@playwright/test').APIRequestContext} request
 * @param {string} key
 * @param {string} value
 */
async function saveAndVerifyAccountMarker(request, key, value) {
    const csrfResponse = await request.get('/csrf-token');
    expect(csrfResponse.ok()).toBe(true);
    const { token } = await csrfResponse.json();
    const headers = { 'X-CSRF-Token': token };

    const getBefore = await request.post('/api/settings/get', { headers, data: {} });
    expect(getBefore.ok()).toBe(true);
    const current = JSON.parse((await getBefore.json()).settings);

    const updated = {
        ...current,
        accountStorage: {
            ...current.accountStorage,
            [key]: value,
        },
    };
    const saveResponse = await request.post('/api/settings/save', { headers, data: updated });
    expect(saveResponse.ok()).toBe(true);

    // Give concurrent workers a window to race on settings saves if isolation were broken.
    await new Promise(resolve => setTimeout(resolve, 150));

    const getAfter = await request.post('/api/settings/get', { headers, data: {} });
    expect(getAfter.ok()).toBe(true);
    const reloaded = JSON.parse((await getAfter.json()).settings);
    expect(reloaded.accountStorage?.[key]).toBe(value);
}

function readOtherWorkerMarkers(dataRoot, ownHandle, markerKey) {
    const markers = [];
    for (const entry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('worker-') || entry.name === ownHandle) {
            continue;
        }
        const otherSettingsPath = path.join(dataRoot, entry.name, 'settings.json');
        if (!fs.existsSync(otherSettingsPath)) {
            continue;
        }
        const otherSettings = JSON.parse(fs.readFileSync(otherSettingsPath, 'utf8'));
        markers.push(otherSettings.accountStorage?.[markerKey]);
    }
    return markers;
}

const expectedConfigPattern = accountIsolation ? /enableUserAccounts:\s*true/ : /port:\s*4444/;

function getExpectedHandle(parallelIndex) {
    return accountIsolation ? getWorkerAccountHandle(parallelIndex) : DEFAULT_USER_HANDLE;
}

test.describe('managed e2e server and worker isolation', () => {
    // eslint-disable-next-line playwright/no-skipped-test -- A run against an external base URL does not start managed servers.
    test.skip(!servers, 'runs only when the Playwright config manages the test servers');

    // If a Playwright update stops importing the config in each worker, every worker would use the same server.
    test('a worker uses a free ephemeral port for its parallel index and retains traces on failure', async ({ page, baseURL }, testInfo) => {
        const expected = getServerUrl(servers, testInfo.parallelIndex);
        expect(baseURL).toBe(expected);
        expect(baseUrlAtLoad).toBe(expected);
        expect(new URL(baseURL).port).not.toBe('4444');
        expect(testInfo.project.use.trace).toBe('retain-on-failure');

        const response = await page.goto('/');
        expect(new URL(response.url()).origin).toBe(expected);
        expect(new URL(response.url()).pathname).not.toBe('/login');
    });

    // During the first run, the app stops its boot at the first-run prompt until a test answers it.
    test('the first run of the worker account is over before tests use it', async ({ baseURL }, testInfo) => {
        const { dataRoot } = servers.find(server => server.url === baseURL);
        expect(isFirstRunOver(dataRoot, getExpectedHandle(testInfo.parallelIndex))).toBe(true);
    });

    // A server without its own config file uses the one in the repository root, which holds the settings of the
    // developer's own server, and it writes one there when the file is absent.
    test('a managed server keeps its config file inside its throwaway data root', async ({ baseURL }) => {
        const { dataRoot } = servers.find(server => server.url === baseURL);
        const configPath = path.join(dataRoot, 'config.yaml');
        expect(fs.existsSync(configPath)).toBe(true);
        expect(fs.readFileSync(configPath, 'utf8')).toMatch(expectedConfigPattern);
    });

    for (const slot of ['slot-a', 'slot-b']) {
        test(`parallel worker account isolation keeps settings changes separate (${slot})`, async ({ request, baseURL }, testInfo) => {
            // eslint-disable-next-line playwright/no-skipped-test -- Account isolation can be turned off with SILLYBUNNY_TEST_ISOLATE_ACCOUNTS=0.
            test.skip(!accountIsolation, 'runs when per-worker account isolation is enabled');

            const expectedHandle = getWorkerAccountHandle(testInfo.parallelIndex);
            expect(workerHandleAtLoad).toBe(expectedHandle);

            const meResponse = await request.get('/api/users/me');
            expect(meResponse.ok()).toBe(true);
            const me = await meResponse.json();
            expect(me.handle).toBe(expectedHandle);
            expect(me.admin).toBe(true);

            const markerKey = 'e2e_worker_isolation_slot';
            const markerValue = `${slot}-${expectedHandle}-${Date.now()}`;
            await saveAndVerifyAccountMarker(request, markerKey, markerValue);

            const { dataRoot } = servers.find(server => server.url === baseURL);
            const ownSettings = JSON.parse(fs.readFileSync(path.join(dataRoot, expectedHandle, 'settings.json'), 'utf8'));
            expect(ownSettings.accountStorage?.[markerKey]).toBe(markerValue);

            const defaultSettings = JSON.parse(fs.readFileSync(path.join(dataRoot, DEFAULT_USER_HANDLE, 'settings.json'), 'utf8'));
            expect(defaultSettings.accountStorage?.[markerKey]).toBeUndefined();

            // Other worker accounts in the same scratch data root must never receive this worker's write.
            expect(readOtherWorkerMarkers(dataRoot, expectedHandle, markerKey)).not.toContain(markerValue);
        });
    }
});
