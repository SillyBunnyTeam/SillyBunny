const INVALID_CSRF_TOKEN_TEXT = 'Invalid CSRF token';

/**
 * Checks whether a response is the server's stale-CSRF rejection.
 * @param {Response} response Fetch response to inspect
 * @returns {Promise<boolean>} True when the response is an invalid-CSRF 403.
 */
export async function isInvalidCsrfTokenResponse(response) {
    if (response?.status !== 403 || typeof response.clone !== 'function') {
        return false;
    }

    try {
        const text = await response.clone().text();
        return text.includes(INVALID_CSRF_TOKEN_TEXT);
    } catch {
        return false;
    }
}

/**
 * Fetches once, refreshes a stale CSRF token, then retries the request once.
 * @param {string|URL|Request} resource Fetch resource
 * @param {() => RequestInit|Promise<RequestInit>} buildInit Builds fresh request init for each attempt
 * @param {object} options Retry options
 * @param {() => Promise<unknown>} options.refreshCsrfToken Function that refreshes the CSRF token
 * @param {typeof fetch} [options.fetchFn=fetch] Fetch implementation
 * @returns {Promise<Response>} Fetch response
 */
export async function fetchWithCsrfRetry(resource, buildInit, { refreshCsrfToken, fetchFn = fetch } = {}) {
    const response = await fetchFn(resource, await buildInit());

    if (!await isInvalidCsrfTokenResponse(response) || typeof refreshCsrfToken !== 'function') {
        return response;
    }

    await refreshCsrfToken();
    return fetchFn(resource, await buildInit());
}
