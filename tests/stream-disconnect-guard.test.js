import { describe, expect, test } from '@jest/globals';
import { isBenignStreamAbort } from '../src/stream-disconnect-guard.js';

describe('isBenignStreamAbort', () => {
    test('matches expected request cancellation errors', () => {
        expect(isBenignStreamAbort(Object.assign(new Error('Client disconnected'), { name: 'AbortError' }))).toBe(true);
    });

    test('matches stream disconnect errors only with disconnected stream context', () => {
        const error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

        expect(isBenignStreamAbort(error)).toBe(false);
        expect(isBenignStreamAbort(error, { response: { destroyed: true } })).toBe(true);
        expect(isBenignStreamAbort(error, { request: { socket: { destroyed: true } } })).toBe(true);
    });

    test('rejects unrelated errors', () => {
        expect(isBenignStreamAbort(new Error('boom'))).toBe(false);
        expect(isBenignStreamAbort(new Error('database transaction aborted while writing user data'))).toBe(false);
    });
});
