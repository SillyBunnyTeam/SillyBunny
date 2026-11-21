import { SERVER_LIST_VARIABLE } from '../e2e-servers.js';
import { NEED_MODULES } from '../helpers/surfaces/fixture-data.js';
import { seedServer } from '../helpers/surfaces/fixtures.js';
import { assertSeedableServer, SEED_FAILURES_VARIABLE } from '../helpers/surfaces/seed-guard.js';

/**
 * Seeds every fixture need on every server of the run, once, before any test. A run that `SURFACE_FAMILY` or `SURFACE_ID`
 * narrows seeds the same data as a full run, because lists, pickers and the page behind a dialog show whatever the server
 * holds, and a capture must not depend on which surfaces ran. The servers are the ones that the config started
 * (`SILLYBUNNY_TEST_SERVERS`), or the base URL of the shard, which is the server that the test runner started for it.
 * A server that someone started by hand is seeded only with `SILLYBUNNY_AUDIT_SEED=1`.
 * A server that `seed-guard.js` refuses stops the run. A need that cannot be seeded is recorded in
 * `SILLYBUNNY_AUDIT_SEED_FAILURES` (read by the workers), so that the surfaces that use it fail with the reason, and the
 * other needs are still seeded.
 * @param {import('@playwright/test').FullConfig} config
 */
export default async function seedFixtures(config) {
    const needed = Object.keys(NEED_MODULES);
    const servers = process.env[SERVER_LIST_VARIABLE]
        ? JSON.parse(process.env[SERVER_LIST_VARIABLE]).map(({ url }) => url)
        : [config.projects[0]?.use.baseURL ?? process.env.SILLYBUNNY_TEST_BASE_URL ?? 'http://127.0.0.1:4444'];
    for (const url of servers) {
        assertSeedableServer(url, 'Surface audit fixtures');
    }
    const failures = {};
    await Promise.all(servers.map(async url => {
        const created = [];
        failures[new URL(url).origin] = {};
        for (const need of needed) {
            try {
                created.push(...await seedServer(url, [need]));
            } catch (error) {
                failures[new URL(url).origin][need] = error.message;
                console.warn(`audit fixtures: could not seed "${need}" on ${url}: ${error.message}`);
            }
        }
        console.log(`audit fixtures on ${url}: ${created.length ? created.join(', ') : 'already seeded'}`);
    }));
    process.env[SEED_FAILURES_VARIABLE] = JSON.stringify(failures);
}
