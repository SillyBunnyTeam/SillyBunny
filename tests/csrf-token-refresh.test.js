import { describe, expect, jest, test } from '@jest/globals';

import { fetchWithCsrfRetry, isInvalidCsrfTokenResponse } from '../public/scripts/csrf-token-refresh.js';

function responseWith(status, body) {
    return new Response(body, { status });
}

describe('CSRF token refresh retry helper', () => {
    test('detects invalid CSRF token responses without consuming the original body', async () => {
        const response = responseWith(403, 'ForbiddenError: Invalid CSRF token. Please refresh the page and try again.');

        await expect(isInvalidCsrfTokenResponse(response)).resolves.toBe(true);
        await expect(response.text()).resolves.toContain('Invalid CSRF token');
    });

    test('refreshes and retries once for invalid CSRF token responses', async () => {
        let token = 'old-token';
        const fetchFn = jest.fn()
            .mockResolvedValueOnce(responseWith(403, 'ForbiddenError: Invalid CSRF token. Please refresh the page and try again.'))
            .mockResolvedValueOnce(responseWith(200, '{"ok":true}'));
        const refreshCsrfToken = jest.fn(async () => {
            token = 'new-token';
        });
        const buildInit = jest.fn(() => ({
            method: 'POST',
            headers: { 'X-CSRF-Token': token },
            body: '{}',
        }));

        const response = await fetchWithCsrfRetry('/api/test', buildInit, { refreshCsrfToken, fetchFn });

        expect(response.status).toBe(200);
        expect(refreshCsrfToken).toHaveBeenCalledTimes(1);
        expect(buildInit).toHaveBeenCalledTimes(2);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(fetchFn.mock.calls[0][1].headers['X-CSRF-Token']).toBe('old-token');
        expect(fetchFn.mock.calls[1][1].headers['X-CSRF-Token']).toBe('new-token');
    });

    test('does not retry ordinary forbidden responses', async () => {
        const fetchFn = jest.fn().mockResolvedValue(responseWith(403, 'Forbidden'));
        const refreshCsrfToken = jest.fn();
        const buildInit = jest.fn(() => ({ method: 'POST' }));

        const response = await fetchWithCsrfRetry('/api/test', buildInit, { refreshCsrfToken, fetchFn });

        expect(response.status).toBe(403);
        expect(refreshCsrfToken).not.toHaveBeenCalled();
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(buildInit).toHaveBeenCalledTimes(1);
    });

    test('does not loop after a refreshed token is still rejected', async () => {
        const fetchFn = jest.fn()
            .mockResolvedValueOnce(responseWith(403, 'ForbiddenError: Invalid CSRF token. Please refresh the page and try again.'))
            .mockResolvedValueOnce(responseWith(403, 'ForbiddenError: Invalid CSRF token. Please refresh the page and try again.'));
        const refreshCsrfToken = jest.fn(async () => {});
        const buildInit = jest.fn(() => ({ method: 'POST' }));

        const response = await fetchWithCsrfRetry('/api/test', buildInit, { refreshCsrfToken, fetchFn });

        expect(response.status).toBe(403);
        expect(refreshCsrfToken).toHaveBeenCalledTimes(1);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(buildInit).toHaveBeenCalledTimes(2);
    });
});
