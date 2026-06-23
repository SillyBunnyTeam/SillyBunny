import { describe, expect, test } from '@jest/globals';
import { isBenignStreamAbort } from '../src/stream-disconnect-guard.js';

describe('isBenignStreamAbort', () => {
    test('matches expected stream disconnect errors', () => {
        expect(isBenignStreamAbort(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true);
        expect(isBenignStreamAbort(Object.assign(new Error('Client disconnected'), { name: 'AbortError' }))).toBe(true);
    });

    test('rejects unrelated errors', () => {
        expect(isBenignStreamAbort(new Error('boom'))).toBe(false);
    });
});
