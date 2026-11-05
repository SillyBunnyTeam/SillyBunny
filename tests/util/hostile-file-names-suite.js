import { afterAll, beforeAll, jest } from '@jest/globals';

import { prepareEnvironment, startHarness } from './hostile-file-names-harness.js';
import { ROUTE_TABLE } from './hostile-file-names-routes.js';

const SETUP_TIMEOUT_MS = 120_000;

// A failed write retries with sleeps on Windows, so one row can take seconds for each input.
export const ROW_TIMEOUT_MS = 180_000;

/**
 * Starts one harness for the enclosing describe block and selects the table rows of the given mounts.
 * @param {Record<string, () => Promise<{ router: import('express').Router }>>} routerLoaders Router imports by mount path
 * @returns {{ rows: object[], getHarness: () => object }} The rows, and an accessor for the harness that is valid inside tests
 */
export function useRouteTable(routerLoaders) {
    let environment;
    let harness;

    beforeAll(async () => {
        for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
            jest.spyOn(console, method).mockImplementation(() => {});
        }
        environment = prepareEnvironment();
        const routers = {};
        for (const [mount, loadRouter] of Object.entries(routerLoaders)) {
            routers[mount] = (await loadRouter()).router;
        }
        harness = await startHarness(environment, routers);
    }, SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await harness?.close();
        environment?.restore();
        jest.restoreAllMocks();
    });

    return {
        rows: ROUTE_TABLE.filter(row => row.mount in routerLoaders),
        getHarness: () => harness,
    };
}
