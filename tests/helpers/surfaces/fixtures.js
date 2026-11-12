/**
 * Seeds the server side of the fixture data. The data and the steps are in the need modules of `needs/`; this file
 * runs them, in the order their `requires` give, against a throwaway server. Nothing reads the network.
 *
 * Seeding is idempotent: a need's `exists` is asked first, and `seed` runs only when the data is missing. It writes
 * only to a server that `seed-guard.js` accepts. The settings side (`applySettingsFixtures`) edits the `/api/settings/get` answer of a boot
 * instead, so it saves nothing.
 */

import { request as playwrightRequest } from '@playwright/test';
import { NEED_MODULES, needClosure } from './fixture-data.js';
import { assertSeedableServer } from './seed-guard.js';

export { applyAnswerFixtures, applySettingsFixtures, FIXTURES } from './fixture-data.js';

/**
 * @param {string} baseURL A loopback server that this run started (see `seed-guard.js`; any loopback server when
 * `SILLYBUNNY_AUDIT_SEED=1`); port 4444 is always refused.
 * @param {readonly string[]} needs The needs to seed, with the needs they require.
 * @returns {Promise<string[]>} A description of each thing that was created, for the log.
 */
export async function seedServer(baseURL, needs) {
    assertSeedableServer(baseURL, 'Surface audit fixtures');
    const order = needClosure(needs);
    const created = [];
    const client = await playwrightRequest.newContext({ baseURL });
    try {
        const { token } = await (await client.get('/csrf-token')).json();
        const headers = { 'X-CSRF-Token': token };
        const api = {
            baseURL,
            async post(path, options, { allow = [] } = {}) {
                const response = await client.post(path, { headers, ...options });
                if (!response.ok() && !allow.includes(response.status())) {
                    throw new Error(`Seeding ${path} on ${baseURL} failed with ${response.status()}: ${(await response.text()).slice(0, 300)}`);
                }
                return response;
            },
        };
        for (const id of order) {
            const module = NEED_MODULES[id];
            if (module.seed && !await module.exists(api)) {
                created.push(await module.seed(api));
            }
        }
    } finally {
        await client.dispose();
    }
    return created;
}
