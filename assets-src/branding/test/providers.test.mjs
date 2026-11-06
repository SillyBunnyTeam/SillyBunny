import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sniffImage } from '../scripts/lib/images.mjs';
import { createProvider, describePlan } from '../scripts/lib/providers.mjs';

const KEY = 'sk-test-0123456789abcdefABCDEF';
const GEMINI_KEY = 'AIzaSyFAKE0123456789abcdefghijklmnopq';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');
const ref = (name) => ({ bytes: PNG, mime: 'image/png', filename: name });

/** Stub fetch that records each call and answers from a queue of responses or errors. */
function stubFetch(...replies) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), init });
        const reply = replies.length > 1 ? replies.shift() : replies[0];
        if (reply instanceof Error) {
            throw reply;
        }
        const { status = 200, json, text, bytes } = reply;
        return new Response(bytes ?? text ?? JSON.stringify(json), { status });
    };
    return { fetchImpl, calls };
}

const openai = (fetchImpl) => createProvider('openai', { apiKey: KEY, baseUrl: 'https://relay.example/v1/', fetchImpl });
const gemini = (fetchImpl) => createProvider('gemini', { apiKey: GEMINI_KEY, baseUrl: 'https://relay.example', fetchImpl });

test('openai without references posts JSON to /images/generations', () => {
    const plan = openai().plan({ model: 'gpt-image-2.5-sunburst-h', prompt: 'a cat', refs: [], size: '1536x1024', n: 3 });
    // The batch size never reaches the wire: every request asks for one image.
    assert.equal(plan.method, 'POST');
    assert.equal(plan.url, 'https://relay.example/v1/images/generations');
    assert.equal(plan.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(plan.kind, 'json');
    assert.deepEqual(plan.fields, { model: 'gpt-image-2.5-sunburst-h', prompt: 'a cat', n: 1, size: '1536x1024' });
});

test('openai with references posts multipart image[] parts to /images/edits', async () => {
    const { fetchImpl, calls } = stubFetch({ json: { data: [{ b64_json: PNG_B64 }] } });
    const result = await openai(fetchImpl).generate({
        model: 'gpt-image-2.5-sunburst-h', prompt: 'edit it', refs: [ref('a.png'), ref('b.png')], size: '1024x1536', n: 1,
        background: 'transparent', quality: 'high',
    });
    assert.equal(calls[0].url, 'https://relay.example/v1/images/edits');
    const form = calls[0].init.body;
    assert.ok(form instanceof FormData);
    assert.equal(form.getAll('image[]').length, 2);
    assert.equal(form.getAll('image[]')[0].name, 'a.png');
    assert.equal(form.get('prompt'), 'edit it');
    assert.equal(form.get('model'), 'gpt-image-2.5-sunburst-h');
    assert.equal(form.get('n'), '1');
    assert.equal(form.get('size'), '1024x1536');
    assert.equal(form.get('background'), 'transparent');
    assert.equal(form.get('quality'), 'high');
    assert.equal(calls[0].init.headers['content-type'], undefined);
    assert.equal(result.images.length, 1);
    assert.deepEqual(result.images[0].bytes, PNG);
});

test('openai accepts an image returned as base64, as a data URL, or as a URL', async () => {
    const replies = [
        [{ json: { data: [{ b64_json: PNG_B64 }] } }],
        [{ json: { data: [{ b64_json: `data:image/png;base64,${PNG_B64}` }] } }],
        [{ json: { data: [{ url: 'https://cdn.example/x.png' }] } }, { bytes: PNG }],
    ];
    for (const queue of replies) {
        const { fetchImpl, calls } = stubFetch(...queue);
        const result = await openai(fetchImpl).generate({ model: 'm', prompt: 'p', refs: [], size: '1024x1024', n: 1 });
        assert.equal(result.images.length, 1);
        assert.ok(result.images[0].bytes.equals(PNG));
        if (calls.length === 2) {
            assert.equal(calls[1].url, 'https://cdn.example/x.png');
            assert.equal(calls[1].init?.headers?.Authorization, undefined);
        }
    }
});

test('openai sends one request per image, each asking for n 1, and sums the usage', async () => {
    const { fetchImpl, calls } = stubFetch({ json: { data: [{ b64_json: PNG_B64 }], usage: { output_tokens: 1055 } } });
    const result = await openai(fetchImpl).generate({ model: 'm', prompt: 'p', refs: [], size: '1024x1024', n: 3 });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => JSON.parse(call.init.body).n), [1, 1, 1]);
    assert.equal(result.images.length, 3);
    assert.equal(result.usage.length, 3);
});

test('openai stops at the first failure and keeps the images already made', async () => {
    const ok = { json: { data: [{ b64_json: PNG_B64 }] } };
    const { fetchImpl, calls } = stubFetch(ok, { status: 429, text: 'quota' }, ok);
    const result = await openai(fetchImpl).generate({ model: 'm', prompt: 'p', refs: [], size: '1024x1024', n: 3 });
    assert.equal(calls.length, 2);
    assert.equal(result.images.length, 1);
    assert.match(result.error, /429/);
});

test('a response with no image counts as a failure and stops the batch', async () => {
    const { fetchImpl, calls } = stubFetch({ json: { data: [] } });
    const result = await openai(fetchImpl).generate({ model: 'm', prompt: 'p', refs: [], size: '1024x1024', n: 2 });
    assert.equal(calls.length, 1);
    assert.equal(result.images.length, 0);
    assert.match(result.error, /no images/);
});

test('a returned URL must be https', async () => {
    const { fetchImpl } = stubFetch({ json: { data: [{ url: 'http://cdn.example/x.png' }] } });
    const result = await openai(fetchImpl).generate({ model: 'm', prompt: 'p', refs: [], size: '1024x1024', n: 1 });
    assert.equal(result.images.length, 0);
    assert.match(result.error, /https/);
});

test('gemini posts generateContent with inline image parts, IMAGE modality and imageConfig', () => {
    const plan = gemini().plan({ model: 'gemini-nano-banana-2.1', prompt: 'draw', refs: [ref('a.png'), ref('b.png')], size: '2K', aspect: '2:3', n: 1 });
    assert.equal(plan.url, 'https://relay.example/v1beta/models/gemini-nano-banana-2.1:generateContent');
    assert.equal(plan.headers['x-goog-api-key'], GEMINI_KEY);
    assert.equal(plan.headers.Authorization, undefined);
    assert.equal(plan.kind, 'json');
    const [content] = plan.fields.contents;
    assert.equal(content.role, 'user');
    assert.deepEqual(content.parts[0], { text: 'draw' });
    assert.deepEqual(content.parts[1], { inlineData: { mimeType: 'image/png', data: PNG_B64 } });
    assert.equal(content.parts.length, 3);
    assert.deepEqual(plan.fields.generationConfig, {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '2:3', imageSize: '2K' },
    });
    assert.ok(!plan.url.includes(GEMINI_KEY));
});

test('gemini reads inlineData, inline_data and fileData URL parts', async () => {
    const { fetchImpl, calls } = stubFetch(
        { json: { candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] } },
        { json: { candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: PNG_B64 } }] } }] } },
        { json: { candidates: [{ content: { parts: [{ fileData: { fileUri: 'https://cdn.example/g.png' } }] } }] } },
        { bytes: PNG },
    );
    const result = await gemini(fetchImpl).generate({ model: 'm', prompt: 'p', refs: [], size: '1K', n: 3 });
    assert.equal(result.images.length, 3);
    assert.equal(calls.length, 4);
    assert.ok(result.images.every((image) => image.bytes.equals(PNG)));
});

test('gemini sends one request per image and keeps the images made before a failure', async () => {
    const ok = { json: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] } };
    const { fetchImpl, calls } = stubFetch(ok, { status: 429, text: 'quota' }, ok);
    const result = await gemini(fetchImpl).generate({ model: 'm', prompt: 'p', refs: [], size: '1K', n: 3 });
    assert.equal(calls.length, 2);
    assert.equal(result.images.length, 1);
    assert.match(result.error, /429/);
});

test('gemini explains a response without an image', async () => {
    const { fetchImpl } = stubFetch({ json: { candidates: [{ finishReason: 'IMAGE_SAFETY' }], promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } });
    const result = await gemini(fetchImpl).generate({ model: 'm', prompt: 'p', refs: [], size: '1K', n: 1 });
    assert.equal(result.images.length, 0);
    assert.match(result.error, /IMAGE_SAFETY|PROHIBITED_CONTENT/);
});

test('openai reports an HTTP failure as an error with no images', async () => {
    const { fetchImpl } = stubFetch({ status: 503, text: 'busy' });
    const result = await openai(fetchImpl).generate({ model: 'm', prompt: 'p', refs: [], size: '1024x1024', n: 1 });
    assert.equal(result.images.length, 0);
    assert.match(result.error, /503/);
});

test('error messages never contain the key, even when the relay echoes it', async () => {
    const echoes = [
        { status: 401, text: `bad token ${KEY}; Authorization: Bearer ${KEY}` },
        { status: 400, json: { error: { message: `invalid key=${KEY}` } } },
        new Error(`connect failed for ?key=${KEY}`),
    ];
    for (const echo of echoes) {
        const { fetchImpl } = stubFetch(echo);
        const result = await openai(fetchImpl).generate({ model: 'm', prompt: 'p', refs: [], size: '1024x1024', n: 1 });
        assert.equal(result.images.length, 0);
        assert.ok(result.error.length > 0);
        assert.ok(!result.error.includes(KEY), result.error);
    }
    const { fetchImpl } = stubFetch({ status: 403, text: `denied for ${GEMINI_KEY}` });
    const result = await gemini(fetchImpl).generate({ model: 'm', prompt: 'p', refs: [], size: '1K', n: 1 });
    assert.ok(!result.error.includes(GEMINI_KEY));
});

test('describePlan redacts credentials and elides image bytes', () => {
    for (const [provider, key] of [[openai(), KEY], [gemini(), GEMINI_KEY]]) {
        const plan = provider.plan({ model: 'm', prompt: 'p', refs: [ref('a.png')], size: provider.name === 'openai' ? '1024x1024' : '1K', n: 1 });
        const shown = JSON.stringify(describePlan(plan));
        assert.ok(!shown.includes(key), shown);
        assert.ok(!shown.includes(PNG_B64), shown);
        assert.match(shown, /REDACTED/);
    }
});

test('validation rejects sizes and reference counts the provider cannot take', () => {
    const base = { model: 'm', prompt: 'p', refs: [], n: 1 };
    assert.throws(() => openai().validate({ ...base, size: '1000x1000' }), /multiple of 16/);
    assert.throws(() => openai().validate({ ...base, size: '4096x4096' }), /3840/);
    assert.throws(() => openai().validate({ ...base, size: '1024x1024', n: 101 }), /1 to 100/);
    assert.throws(() => openai().validate({ ...base, size: '1024x1024', refs: Array(17).fill(ref('x.png')) }), /16/);
    assert.doesNotThrow(() => openai().validate({ ...base, size: '1024x1536', refs: Array(16).fill(ref('x.png')) }));
    assert.throws(() => gemini().validate({ ...base, size: '3K' }), /3K/);
    assert.throws(() => gemini().validate({ ...base, size: '1K', aspect: '7:5' }), /7:5/);
    assert.throws(() => gemini().validate({ ...base, size: '1K', refs: Array(15).fill(ref('x.png')) }), /14/);
    assert.throws(() => gemini().validate({ ...base, size: '1K', quality: 'high' }), /quality/);
});


const UPSTREAM_ERROR = { status: 400, json: { error: { message: 'Provider API error: User location is not supported for the API use.', type: 'upstream_error' } } };
const GEMINI_OK = { json: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: PNG_B64 } }] } }] } };

function retryingProvider(name, fetchImpl) {
    const events = [];
    const provider = createProvider(name, {
        apiKey: name === 'openai' ? KEY : GEMINI_KEY,
        baseUrl: 'https://relay.example/v1',
        fetchImpl,
        retryDelayMs: 7,
        sleep: async (ms) => events.push(`sleep ${ms}`),
        onRetry: (message) => events.push(message),
    });
    return { provider, events };
}

test('an upstream_error is retried once after the delay, for both providers', async () => {
    for (const [name, ok, size] of [['openai', { json: { data: [{ b64_json: PNG_B64 }] } }, '1024x1024'], ['gemini', GEMINI_OK, '1K']]) {
        const { fetchImpl, calls } = stubFetch(UPSTREAM_ERROR, ok);
        const { provider, events } = retryingProvider(name, fetchImpl);
        const result = await provider.generate({ model: 'm', prompt: 'p', refs: [], size, n: 1 });
        assert.equal(calls.length, 2, name);
        assert.equal(result.images.length, 1, name);
        assert.equal(result.error, undefined);
        assert.equal(events.length, 2);
        assert.match(events[0], /upstream_error \(HTTP 400\); retrying once in 7 ms/);
        assert.equal(events[1], 'sleep 7');
        assert.ok(!events.join().includes(KEY) && !events.join().includes(GEMINI_KEY));
    }
});

test('a second upstream_error is final: one retry only', async () => {
    const { fetchImpl, calls } = stubFetch(UPSTREAM_ERROR);
    const { provider } = retryingProvider('openai', fetchImpl);
    const result = await provider.generate({ model: 'm', prompt: 'p', refs: [], size: '1024x1024', n: 1 });
    assert.equal(calls.length, 2);
    assert.equal(result.images.length, 0);
    assert.match(result.error, /HTTP 400.*upstream_error/);
});

test('other failures are never retried: plain HTTP errors, other error types, and a thrown fetch', async () => {
    const cases = [
        { status: 500, text: 'oops' },
        { status: 400, json: { error: { type: 'invalid_request_error', message: 'bad' } } },
        new Error('The operation was aborted due to timeout'),
    ];
    for (const failure of cases) {
        const { fetchImpl, calls } = stubFetch(failure, { json: { data: [{ b64_json: PNG_B64 }] } });
        const { provider, events } = retryingProvider('openai', fetchImpl);
        const result = await provider.generate({ model: 'm', prompt: 'p', refs: [], size: '1024x1024', n: 1 });
        assert.equal(calls.length, 1);
        assert.equal(result.images.length, 0);
        assert.deepEqual(events, []);
    }
});

test('a 2xx reply is never retried, even when its body mentions upstream_error', async () => {
    const { fetchImpl, calls } = stubFetch({ status: 200, json: { error: { type: 'upstream_error' } } });
    const { provider } = retryingProvider('gemini', fetchImpl);
    const result = await provider.generate({ model: 'm', prompt: 'p', refs: [], size: '1K', n: 1 });
    assert.equal(calls.length, 1);
    assert.equal(result.images.length, 0);
});

test('retry notices never contain the key even if the relay echoes it', async () => {
    const echo = { status: 400, json: { error: { type: 'upstream_error', message: `bad ${KEY}` } } };
    const { fetchImpl } = stubFetch(echo);
    const { provider, events } = retryingProvider('openai', fetchImpl);
    const result = await provider.generate({ model: 'm', prompt: 'p', refs: [], size: '1024x1024', n: 1 });
    assert.ok(!events.join('\n').includes(KEY));
    assert.ok(!result.error.includes(KEY));
});

test('sniffImage recognises PNG, JPEG and WebP and rejects anything else', () => {
    assert.deepEqual(sniffImage(PNG), { mime: 'image/png', ext: 'png' });
    assert.deepEqual(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), { mime: 'image/jpeg', ext: 'jpg' });
    assert.deepEqual(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), { mime: 'image/webp', ext: 'webp' });
    assert.throws(() => sniffImage(Buffer.from('<html>error page</html>')), /not a PNG, JPEG or WebP/);
});
