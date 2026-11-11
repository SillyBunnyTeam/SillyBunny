import { SERVER_LIST_VARIABLE } from '../e2e-servers.js';
import { seedServer } from '../helpers/surfaces/fixtures.js';
import { selectSurfaces } from '../helpers/surfaces/index.js';
import { assertSeedableServer, SEED_FAILURES_VARIABLE } from '../helpers/surfaces/seed-guard.js';

/**
 * Seeds the fixtures that the selected surfaces need on every server of the run, once, before any test. The surfaces are
 * all of them unless `SURFACE_FAMILY` or `SURFACE_ID` is set. The servers are the ones that the config started
 * (`SILLYBUNNY_TEST_SERVERS`), or the base URL of the shard, which is the server that the test runner started for it.
 * A server that someone started by hand is seeded only with `SILLYBUNNY_AUDIT_SEED=1`.
 * A server that `seed-guard.js` refuses stops the run. A need that cannot be seeded is recorded in
 * `SILLYBUNNY_AUDIT_SEED_FAILURES` (read by the workers), so that the surfaces that use it fail with the reason, and the
 * other needs are still seeded.
 * @param {import('@playwright/test').FullConfig} config
 */
export default async function seedFixtures(config) {
    const needed = [...new Set(selectSurfaces().surfaces.flatMap(surface => surface.needs))];
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
