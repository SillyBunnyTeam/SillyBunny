import { describe, expect, test } from '@jest/globals';

import { shouldCompressResponse } from '../src/middleware/response-compression.js';

function createResponse(headers = {}) {
    const normalizedHeaders = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    return {
        getHeader(name) {
            return normalizedHeaders.get(String(name).toLowerCase());
        },
    };
}

describe('response compression middleware', () => {
    test('skips server-sent event streams', () => {
        expect(shouldCompressResponse({}, createResponse({
            'Content-Type': 'text/event-stream; charset=utf-8',
        }))).toBe(false);
    });

    test('honors no-transform cache directives', () => {
        expect(shouldCompressResponse({}, createResponse({
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-transform',
        }))).toBe(false);
    });

    test('keeps default compression behavior for regular JSON responses', () => {
        expect(shouldCompressResponse({}, createResponse({
            'Content-Type': 'application/json',
        }))).toBe(true);
    });
});
