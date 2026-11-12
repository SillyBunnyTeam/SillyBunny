/**
 * @jest-environment jsdom
 */
import { describe, expect, jest, test } from '@jest/globals';

import { extractProviderMessage } from '../public/scripts/sillybunny-provider-message.js';
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => `${text}${part}${values[index] ?? ''}`, ''),
}));

const {
    REQUEST_ERROR_HINT_KINDS,
    createFailedResponseError,
    describeRequestError,
    getFailureStatus,
    getThrownResponseFailure,
    getRequestErrorHint,
    hintKindFor,
    showRequestError,
} = await import('../public/scripts/sillybunny-request-errors.js');

describe('extractProviderMessage', () => {
    test.each([
        ['an OpenAI style error object', '{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}', 'Incorrect API key provided'],
        ['an error that is a plain string', '{"error":"Provider unavailable"}', 'Provider unavailable'],
        ['a message field', '{"message":"Model is loading"}', 'Model is loading'],
        ['a FastAPI detail string', '{"detail":"Service temporarily unavailable"}', 'Service temporarily unavailable'],
        ['a nested detail error', { detail: { error: { message: 'Quota exceeded' } } }, 'Quota exceeded'],
        ['a list of errors, as Gemini sends them', '[{"error":{"message":"API key not valid"}}]', 'API key not valid'],
        ['the upstream body wrapped by the text completion route', { error: true, status: 401, response: '{"error":{"message":"Bad key"}}' }, 'Bad key'],
        ['a wrapped plain text body', { error: true, status: 500, response: 'upstream connect error' }, 'upstream connect error'],
        ['plain text', '  upstream   connect error\n', 'upstream connect error'],
        ['a message inside a body that starts with a bracket', '{"error":{"message":"[400 Bad Request] API key not valid"}}', '[400 Bad Request] API key not valid'],
        ['a string error that starts with a bracket', { error: '[429] Too Many Requests' }, '[429] Too Many Requests'],
        ['a wrapped body that starts with a bracket', { error: true, status: 429, response: '[429] Too Many Requests' }, '[429] Too Many Requests'],
    ])('reads %s', (_name, body, expected) => {
        expect(extractProviderMessage(body)).toBe(expected);
    });

    test.each([
        ['an empty body', ''],
        ['nothing', undefined],
        ['an error flag without text', { error: true }],
        ['a web page', '<html><body><h1>502 Bad Gateway</h1></body></html>'],
        ['a doctype page', '<!DOCTYPE html><html></html>'],
        ['JSON that cannot be parsed', '{"error": '],
        ['a whole body that starts with a bracket and is not JSON', '[429] Too Many Requests'],
        ['a body without any known field', '{"id":"x","choices":[]}'],
    ])('returns nothing for %s', (_name, body) => {
        expect(extractProviderMessage(body)).toBe('');
    });

    test('does not read the generated text of a successful payload as an error', () => {
        expect(extractProviderMessage({ response: 'Once upon a time', done: false })).toBe('');
    });

    test('cuts long plain text', () => {
        expect(extractProviderMessage('x'.repeat(1000))).toHaveLength(300);
    });

    test('stops at deeply nested bodies', () => {
        expect(extractProviderMessage({ error: { error: { error: { error: { error: { message: 'deep' } } } } } })).toBe('');
    });
});

describe('hintKindFor', () => {
    test.each([
        [401, REQUEST_ERROR_HINT_KINDS.key],
        [403, REQUEST_ERROR_HINT_KINDS.key],
        [404, REQUEST_ERROR_HINT_KINDS.model],
        [429, REQUEST_ERROR_HINT_KINDS.rate],
        [500, REQUEST_ERROR_HINT_KINDS.down],
        [503, REQUEST_ERROR_HINT_KINDS.down],
        [400, ''],
        [200, ''],
        [0, ''],
    ])('status %i', (status, kind) => {
        expect(hintKindFor(status)).toBe(kind);
    });
});

describe('getRequestErrorHint', () => {
    test.each([
        ['key', 'The provider didn\'t accept your API key. Check it in Backend ▸ Connections.'],
        ['model', 'The provider couldn\'t find the selected model or address. Check both in Backend ▸ Connections.'],
        ['rate', 'The provider is limiting your requests, or your credits ran out. Wait a moment and try again, or check your account with the provider.'],
        ['down', 'The provider couldn\'t be reached or is having problems. Try again in a few minutes.'],
    ])('says what to do about a %s failure', (kind, text) => {
        expect(getRequestErrorHint(kind)).toBe(text);
    });

    test('has nothing to say about an unknown kind', () => {
        expect(getRequestErrorHint('')).toBe('');
        expect(getRequestErrorHint('other')).toBe('');
    });
});

describe('describeRequestError', () => {
    test('prefers the provider message over the HTTP reason', () => {
        expect(describeRequestError({ status: 401, statusText: 'Unauthorized', body: '{"error":{"message":"Bad key"}}' }))
            .toEqual({ message: 'Bad key', hintKind: REQUEST_ERROR_HINT_KINDS.key });
    });

    test('falls back to the HTTP reason, then to the status number', () => {
        expect(describeRequestError({ status: 404, statusText: 'Not Found', body: '' }).message).toBe('Not Found');
        expect(describeRequestError({ status: 404 }).message).toBe('Unknown error (404)');
        expect(describeRequestError({}).message).toBe('Unknown error');
    });

    test('lets a message extracted by the caller win', () => {
        expect(describeRequestError({ status: 400, message: 'Own text', body: '{"message":"Other"}' }).message).toBe('Own text');
    });
});

describe('createFailedResponseError', () => {
    test('carries the provider message', () => {
        expect(createFailedResponseError({ status: 429, body: '{"error":{"message":"Slow down"}}' }).message).toBe('Slow down');
    });

    test('keeps the status wording when the provider said nothing', () => {
        expect(createFailedResponseError({ status: 502, body: '<html></html>' }).message).toBe('Got response status 502');
    });
});

describe('getFailureStatus', () => {
    const fakeResponse = (status, upstream) => ({ status, headers: new Headers(upstream ? { 'X-Upstream-Status': upstream } : {}) });

    test('reads the original status of a provider 401 that the server turned into 400', () => {
        expect(getFailureStatus(fakeResponse(400, '401'))).toBe(401);
    });

    test('uses the response status otherwise', () => {
        expect(getFailureStatus(fakeResponse(429))).toBe(429);
        expect(getFailureStatus(fakeResponse(400, 'nope'))).toBe(400);
    });
});

describe('getThrownResponseFailure', () => {
    test('accepts the error body the text completion route throws', () => {
        const body = { error: true, status: 401, response: 'Bad key' };
        expect(getThrownResponseFailure(body)).toEqual({ status: 401, body });
    });

    test('keeps an error body that has no text, so the status hint still shows', () => {
        const body = { error: true, status: 403, response: '<html></html>' };
        expect(getThrownResponseFailure(body)).toEqual({ status: 403, body });
    });

    test('treats a network failure code as a provider that could not be reached', () => {
        const body = { error: true, status: 'ECONNREFUSED', response: 'fetch failed' };
        expect(getThrownResponseFailure(body)).toEqual({ status: 503, body });
    });

    test('ignores real errors and bodies with nothing to say', () => {
        expect(getThrownResponseFailure(new Error('x'))).toBeNull();
        expect(getThrownResponseFailure('x')).toBeNull();
        expect(getThrownResponseFailure(null)).toBeNull();
        expect(getThrownResponseFailure({ choices: [] })).toBeNull();
    });
});

describe('showRequestError', () => {
    test('shows a plain string when no hint fits', () => {
        const toast = { error: jest.fn() };
        showRequestError({ title: 'Chat Completion API', status: 400, body: '{"error":{"message":"Too many tokens"}}', toast });
        expect(toast.error).toHaveBeenCalledWith('Too many tokens', 'Chat Completion API', {});
    });

    test('shows the message and the hint as DOM, never as markup', () => {
        const toast = { error: jest.fn() };
        showRequestError({ title: 'Chat Completion API', status: 401, body: '{"error":{"message":"<b>Bad</b> key"}}', toast });

        const [content, title, options] = toast.error.mock.calls[0];
        expect(title).toBe('Chat Completion API');
        expect(options.escapeHtml).toBe(false);
        expect(content.children).toHaveLength(2);
        expect(content.children[0].textContent).toBe('<b>Bad</b> key');
        expect(content.children[0].querySelector('b')).toBeNull();
        expect(content.children[1].dataset.sbRequestErrorHint).toBe(REQUEST_ERROR_HINT_KINDS.key);
        expect(content.children[1].hasAttribute('data-sb-copy-placeholder')).toBe(false);
        expect(content.children[1].textContent).toBe(getRequestErrorHint(REQUEST_ERROR_HINT_KINDS.key));
    });

    test('passes extra toast options through', () => {
        const toast = { error: jest.fn() };
        showRequestError({ title: 'T', status: 500, message: 'x', toastOptions: { timeOut: 10000 }, toast });
        expect(toast.error.mock.calls[0][2]).toEqual({ timeOut: 10000, escapeHtml: false });
    });
});
