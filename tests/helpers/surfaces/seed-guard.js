/**
 * The check that stands before every write of fixture data to a server. Seeding creates characters, chats, lorebooks and
 * settings entries, so it must reach only a server that was started for this run, or one that the person running the
 * audit named on purpose. A run starts its servers in one of two ways: the config starts them itself
 * (`SILLYBUNNY_TEST_SERVERS`, which lists them in `SILLYBUNNY_TEST_SERVER_LIST`), or the test runner starts one per shard
 * and gives the shard its address in `E2E_BASE_URL`, on a port from its own range. Both are accepted. No Playwright import, so Jest can load it.
 */

import { SERVER_LIST_VARIABLE } from '../../e2e-servers.js';

/** Set to `1` to allow seeding a loopback server that the config did not start, such as one started by hand on a throwaway data root. */
export const SEED_OVERRIDE_VARIABLE = 'SILLYBUNNY_AUDIT_SEED';

/** The address that the test runner gives a shard, for the throwaway server that it started for that shard. */
export const RUNNER_URL_VARIABLE = 'E2E_BASE_URL';

/** The ports that the test runner picks for the servers that it starts (the first free port from 5101 up to 5999). */
export const RUNNER_PORT_RANGE = Object.freeze({ first: 5101, last: 5999 });

/** The port of the maintainer's own server, which is never seeded. */
export const MAINTAINER_PORT = '4444';

/** Where the global setup leaves the needs that it could not seed, as JSON: `{ [origin]: { [need]: message } }`. Workers inherit it. */
export const SEED_FAILURES_VARIABLE = 'SILLYBUNNY_AUDIT_SEED_FAILURES';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The needs among `needs` that the global setup could not seed on the server at `baseURL`, with the reason of each.
 * @param {string} baseURL
 * @param {readonly string[]} needs
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string>}
 */
export function seedFailuresOf(baseURL, needs, env = process.env) {
    const failures = env[SEED_FAILURES_VARIABLE] ? JSON.parse(env[SEED_FAILURES_VARIABLE])[new URL(baseURL).origin] ?? {} : {};
    return Object.fromEntries(needs.filter(need => failures[need]).map(need => [need, failures[need]]));
}

/**
 * Throws unless `baseURL` may be seeded: a loopback host, not port 4444, and one of the servers that the run started (the
 * list in `SILLYBUNNY_TEST_SERVER_LIST`, or the shard's `E2E_BASE_URL`), or a run with `SILLYBUNNY_AUDIT_SEED=1` for a
 * server that someone started by hand.
 * @param {string} baseURL
 * @param {string} area Names the caller in the message.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function assertSeedableServer(baseURL, area, env = process.env) {
    let url;
    try {
        url = new URL(baseURL);
    } catch {
        throw new Error(`${area}: "${baseURL}" is not a URL.`);
    }
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
        throw new Error(`${area} writes data, so it only seeds a loopback server, not ${url.host}.`);
    }
    if (url.port === MAINTAINER_PORT) {
        throw new Error(`${area} writes data and never seeds port ${MAINTAINER_PORT}, the maintainer's server.`);
    }
    if (env[SEED_OVERRIDE_VARIABLE] === '1') {
        return;
    }
    const listed = env[SERVER_LIST_VARIABLE] ? JSON.parse(env[SERVER_LIST_VARIABLE]).map(server => new URL(server.url)) : [];
    const isStarted = server => server.port === url.port && LOOPBACK_HOSTS.has(server.hostname);
    // A shell can keep an old `E2E_BASE_URL`, so the runner's address authorises a server only on a port that the runner chooses.
    const port = Number(url.port);
    const runnerStarted = env[RUNNER_URL_VARIABLE] && isStarted(new URL(env[RUNNER_URL_VARIABLE]))
        && port >= RUNNER_PORT_RANGE.first && port <= RUNNER_PORT_RANGE.last;
    if (!listed.some(isStarted) && !runnerStarted) {
        throw new Error(
            `${area} seeds only the servers that this run started (${SERVER_LIST_VARIABLE}, or ${RUNNER_URL_VARIABLE} on ports ${RUNNER_PORT_RANGE.first} to ${RUNNER_PORT_RANGE.last}), and ${url.origin} is not one of them. `
            + `To seed a throwaway server that you started yourself, set ${SEED_OVERRIDE_VARIABLE}=1.`,
        );
    }
}
