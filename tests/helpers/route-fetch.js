// Playwright disposes a route's API response and closes the request context when a test ends.
// A request still in flight then rejects with one of these messages, which is not a product failure.
const TEST_ENDED_MESSAGE = /has been disposed|context disposed|has been closed|Test ended|Test timeout/i;

function isTestEndedError(error) {
    return error instanceof Error && TEST_ENDED_MESSAGE.test(error.message);
}

/**
 * Fetches a route's real response and reads its body before the caller fulfills the route.
 * Returns `null` when the page, context or response was torn down first, so the handler must
 * return without fulfilling. Any other failure is rethrown so real errors stay visible.
 *
 * @param {import('@playwright/test').Route} route
 * @param {(response: import('@playwright/test').APIResponse) => Promise<unknown>} readBody
 * @param {Parameters<import('@playwright/test').Route['fetch']>[0]} [options]
 * @param {{ retryOnce?: boolean }} [behavior] `retryOnce` repeats a failed fetch one time, for a keep-alive socket the server just closed.
 * @returns {Promise<{ response: import('@playwright/test').APIResponse, body: unknown } | null>}
 */
export async function fetchBodyOrSkip(route, readBody, options, { retryOnce = false } = {}) {
    try {
        const response = retryOnce
            ? await route.fetch(options).catch(() => route.fetch(options))
            : await route.fetch(options);
        return { response, body: await readBody(response) };
    } catch (error) {
        if (isTestEndedError(error)) return null;
        throw error;
    }
}

/** Returns the parsed JSON of a route's real response, or `null` when the test ended first. */
export async function fetchJsonOrSkip(route, options, behavior) {
    const fetched = await fetchBodyOrSkip(route, response => response.json(), options, behavior);
    return fetched ? fetched.body : null;
}
