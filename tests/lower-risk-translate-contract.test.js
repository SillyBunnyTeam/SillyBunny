import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    STANDARD_UPSTREAM_ERRORS,
    createFakeUpstreamServer,
    createLoopbackNetworkGuard,
    htmlErrorReply,
    initContractConfig,
    jsonReply,
    startContractApp,
    textReply,
} from './util/lower-risk-contract-harness.js';

const { default: actualNodeFetch } = await import('node-fetch');

let fakeServer = null;
let app = null;

const networkGuard = createLoopbackNetworkGuard({
    getFakeServer: () => fakeServer,
    getAllowedPorts: () => [app?.port],
    actualNodeFetch,
});

await jest.unstable_mockModule('node-fetch', () => ({
    default: networkGuard.guardedNodeFetch,
}));

const contractConfig = await initContractConfig('sillybunny-translate-cfg-');

const { router: translateRouter } = await import('../src/endpoints/translate.js');
const { SECRET_KEYS } = await import('../src/endpoints/secrets.js');

const DEFAULT_TRANSLATE_SECRETS = {
    [SECRET_KEYS.LIBRE]: 'test-libre-key',
    [SECRET_KEYS.LIBRE_URL]: 'https://libre.example/translate',
    [SECRET_KEYS.LINGVA_URL]: 'https://lingva.example/api/v1',
    [SECRET_KEYS.DEEPL]: 'test-deepl-key',
    [SECRET_KEYS.ONERING_URL]: 'https://onering.example/translate',
    [SECRET_KEYS.DEEPLX_URL]: 'https://deeplx.example/translate',
};

function googleBatchTranslateReply(translatedText, detectedSource = 'en') {
    const inner = JSON.stringify([
        null,
        [
            [
                [translatedText, null, null, null, null, [[translatedText]]],
                null,
                null,
                detectedSource,
            ],
        ],
        detectedSource,
    ]);
    const outer = JSON.stringify([['wrb.fr', 'MkEWBc', inner, null, null, null, '0']]);
    return textReply(`)]}'\n\n${outer}`, 200, 'application/json; charset=utf-8');
}

function bingConfigPageHtml() {
    const now = Date.now();
    return textReply(
        `<html><body><script>IG:"TEST_IG_VALUE"</script><div data-iid="translator.5023"></div><script>var params_AbusePreventionHelper = [${now}, "test-bing-token", 3600000];</script></body></html>`,
        200,
        'text/html; charset=utf-8',
    );
}

function bingTranslateReply(translatedText, toLang = 'fr') {
    return jsonReply([
        {
            detectedLanguage: { language: 'en', score: 1.0 },
            translations: [{ text: translatedText, to: toLang }],
        },
    ]);
}

describe('Translation endpoint contract matrix', () => {
    beforeAll(async () => {
        fakeServer = await createFakeUpstreamServer();
        app = await startContractApp({
            routes: [['/api/translate', translateRouter]],
            tempPrefix: 'sillybunny-translate-contract-',
            secrets: DEFAULT_TRANSLATE_SECRETS,
            skipConfigInit: true,
        });
    });

    beforeEach(() => {
        fakeServer.reset();
        networkGuard.setBlockExternal(false);
        app.resetUser(DEFAULT_TRANSLATE_SECRETS);
    });

    afterAll(async () => {
        networkGuard.restore();
        await app?.close();
        await fakeServer?.close();
        contractConfig.cleanup();
    });

    describe('LibreTranslate (/api/translate/libre)', () => {
        test.each([
            ['fr', 'fr'],
            ['zh-CN', 'zh'],
            ['zh-TW', 'zt'],
            ['pt-BR', 'pt'],
            ['pt-PT', 'pt'],
        ])('normalizes lang %s -> %s and returns translated text', async (inputLang, expectedTarget) => {
            fakeServer.enqueue(jsonReply({ translatedText: `translated-${expectedTarget}` }));

            const res = await app.postJson('/api/translate/libre', { text: 'Hello world', lang: inputLang });

            expect(res.status).toBe(200);
            expect(res.text).toBe(`translated-${expectedTarget}`);
            expect(fakeServer.requests).toHaveLength(1);
            const [req] = fakeServer.requests;
            expect(req.method).toBe('POST');
            expect(req.originalUrl).toBe('https://libre.example/translate');
            expect(req.json).toEqual({
                q: 'Hello world',
                source: 'auto',
                target: expectedTarget,
                format: 'text',
                api_key: 'test-libre-key',
            });
        });

        test('returns 400 when LibreTranslate URL secret, text, or lang is missing', async () => {
            app.clearSecrets();
            expect((await app.postJson('/api/translate/libre', { text: 'Hi', lang: 'fr' })).status).toBe(400);

            app.seedSecrets(DEFAULT_TRANSLATE_SECRETS);
            expect((await app.postJson('/api/translate/libre', { lang: 'fr' })).status).toBe(400);
            expect((await app.postJson('/api/translate/libre', { text: 'Hi' })).status).toBe(400);
            expect(fakeServer.requests).toHaveLength(0);
        });

        test.each(STANDARD_UPSTREAM_ERRORS)('returns 500 on upstream %s', async (_label, errorReply) => {
            fakeServer.enqueue(errorReply);
            const res = await app.postJson('/api/translate/libre', { text: 'Hi', lang: 'fr' });
            expect(res.status).toBe(500);
        });
    });

    describe('Google Translate (/api/translate/google)', () => {
        test.each([
            ['fr', 'fr'],
            ['pt-BR', 'pt'],
        ])('sends batchexecute request for %s -> %s and returns UTF-8 plain text', async (inputLang, expectedTo) => {
            fakeServer.enqueue(googleBatchTranslateReply(`google-${expectedTo}`));

            const res = await app.postJson('/api/translate/google', { text: 'Good morning', lang: inputLang });

            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('text/plain');
            expect(res.text).toBe(`google-${expectedTo}`);
            expect(fakeServer.requests).toHaveLength(1);
            const [req] = fakeServer.requests;
            expect(req.method).toBe('POST');
            expect(req.originalHost).toBe('translate.google.com');
            expect(req.pathname).toBe('/_/TranslateWebserverUi/data/batchexecute');
            expect(req.query.rpcids).toBe('MkEWBc');
            expect(req.form['f.req']).toContain(expectedTo);
            expect(req.form['f.req']).toContain('Good morning');
        });

        test('returns 400 when text or lang is missing', async () => {
            expect((await app.postJson('/api/translate/google', { lang: 'fr' })).status).toBe(400);
            expect((await app.postJson('/api/translate/google', { text: 'Hi' })).status).toBe(400);
            expect(fakeServer.requests).toHaveLength(0);
        });

        test.each(STANDARD_UPSTREAM_ERRORS)('returns 500 on upstream %s', async (_label, errorReply) => {
            fakeServer.setHandler(() => errorReply);
            const res = await app.postJson('/api/translate/google', { text: 'Hi', lang: 'fr' });
            expect(res.status).toBe(500);
        });
    });

    describe('Yandex Translate (/api/translate/yandex)', () => {
        test.each([
            ['es', 'es'],
            ['pt-PT', 'pt'],
            ['zh-CN', 'zh'],
            ['zh-TW', 'zh'],
        ])('posts urlencoded chunks for %s -> %s and joins reply text', async (inputLang, expectedLang) => {
            fakeServer.enqueue(jsonReply({ text: ['Part one', 'Part two'] }));

            const res = await app.postJson('/api/translate/yandex', {
                chunks: ['Hello ', 'world'],
                lang: inputLang,
            });

            expect(res.status).toBe(200);
            expect(res.text).toBe('Part one,Part two');
            expect(fakeServer.requests).toHaveLength(1);
            const [req] = fakeServer.requests;
            expect(req.method).toBe('POST');
            expect(req.originalHost).toBe('translate.yandex.net');
            expect(req.pathname).toBe('/api/v1/tr.json/translate');
            expect(req.query.srv).toBe('android');
            expect(req.query.format).toBe('text');
            expect(req.query.ucid).toMatch(/^[0-9a-f]{32}$/i);
            expect(req.form).toEqual({ text: ['Hello ', 'world'], lang: expectedLang });
        });

        test('returns 400 when chunks or lang is missing', async () => {
            expect((await app.postJson('/api/translate/yandex', { lang: 'es' })).status).toBe(400);
            expect((await app.postJson('/api/translate/yandex', { chunks: ['Hi'] })).status).toBe(400);
            expect(fakeServer.requests).toHaveLength(0);
        });

        test.each(STANDARD_UPSTREAM_ERRORS)('returns 500 on upstream %s', async (_label, errorReply) => {
            fakeServer.enqueue(errorReply);
            const res = await app.postJson('/api/translate/yandex', { chunks: ['Hi'], lang: 'es' });
            expect(res.status).toBe(500);
        });
    });

    describe('Lingva Translate (/api/translate/lingva)', () => {
        test.each([
            ['de', 'de'],
            ['zh-CN', 'zh'],
            ['zh-TW', 'zh'],
            ['pt-BR', 'pt'],
            ['pt-PT', 'pt'],
        ])('requests GET /auto/<lang>/<encodedText> for %s -> %s', async (inputLang, expectedLang) => {
            fakeServer.enqueue(jsonReply({ translation: `lingva-${expectedLang}` }));

            const res = await app.postJson('/api/translate/lingva', { text: 'Hello world?', lang: inputLang });

            expect(res.status).toBe(200);
            expect(res.text).toBe(`lingva-${expectedLang}`);
            expect(fakeServer.requests).toHaveLength(1);
            const [req] = fakeServer.requests;
            expect(req.method).toBe('GET');
            expect(req.originalUrl).toBe(`https://lingva.example/api/v1/auto/${expectedLang}/Hello%20world%3F`);
        });

        test('falls back to default lingva.ml URL when LINGVA_URL secret is not set', async () => {
            app.clearSecrets();
            fakeServer.enqueue(jsonReply({ translation: 'Salut' }));

            const res = await app.postJson('/api/translate/lingva', { text: 'Hi', lang: 'fr' });

            expect(res.status).toBe(200);
            expect(res.text).toBe('Salut');
            expect(fakeServer.requests[0].originalUrl).toBe('https://lingva.ml/api/v1/auto/fr/Hi');
        });

        test('returns 400 when text or lang is missing', async () => {
            expect((await app.postJson('/api/translate/lingva', { lang: 'de' })).status).toBe(400);
            expect((await app.postJson('/api/translate/lingva', { text: 'Hi' })).status).toBe(400);
            expect(fakeServer.requests).toHaveLength(0);
        });

        test.each(STANDARD_UPSTREAM_ERRORS)('returns 500 on upstream %s', async (_label, errorReply) => {
            fakeServer.enqueue(errorReply);
            const res = await app.postJson('/api/translate/lingva', { text: 'Hi', lang: 'de' });
            expect(res.status).toBe(500);
        });
    });

    describe('DeepL (/api/translate/deepl)', () => {
        test.each([
            ['free default with formality', { text: 'Hello', lang: 'de' }, 'https://api-free.deepl.com/v2/translate', { text: 'Hello', target_lang: 'de', formality: 'default' }],
            ['pro endpoint', { text: 'Hello', lang: 'fr', endpoint: 'pro' }, 'https://api.deepl.com/v2/translate', { text: 'Hello', target_lang: 'fr', formality: 'default' }],
            ['zh-CN mapped to ZH without formality', { text: 'Hello', lang: 'zh-CN' }, 'https://api-free.deepl.com/v2/translate', { text: 'Hello', target_lang: 'ZH' }],
            ['zh-TW mapped to ZH without formality', { text: 'Hello', lang: 'zh-TW' }, 'https://api-free.deepl.com/v2/translate', { text: 'Hello', target_lang: 'ZH' }],
            ['en omits formality', { text: 'Hallo', lang: 'en' }, 'https://api-free.deepl.com/v2/translate', { text: 'Hallo', target_lang: 'en' }],
        ])('sends DeepL request (%s) and extracts translations[0].text', async (_label, payload, expectedUrl, expectedForm) => {
            fakeServer.enqueue(jsonReply({ translations: [{ text: 'Translated!' }] }));

            const res = await app.postJson('/api/translate/deepl', payload);

            expect(res.status).toBe(200);
            expect(res.text).toBe('Translated!');
            expect(fakeServer.requests).toHaveLength(1);
            const [req] = fakeServer.requests;
            expect(req.method).toBe('POST');
            expect(req.originalUrl).toBe(expectedUrl);
            expect(req.headers.authorization).toBe('DeepL-Auth-Key test-deepl-key');
            expect(req.form).toEqual(expectedForm);
        });

        test('returns 400 when DeepL key, text, or lang is missing', async () => {
            app.clearSecrets();
            expect((await app.postJson('/api/translate/deepl', { text: 'Hi', lang: 'de' })).status).toBe(400);

            app.seedSecrets(DEFAULT_TRANSLATE_SECRETS);
            expect((await app.postJson('/api/translate/deepl', { lang: 'de' })).status).toBe(400);
            expect((await app.postJson('/api/translate/deepl', { text: 'Hi' })).status).toBe(400);
            expect(fakeServer.requests).toHaveLength(0);
        });

        test.each(STANDARD_UPSTREAM_ERRORS)('returns 500 on upstream %s', async (_label, errorReply) => {
            fakeServer.enqueue(errorReply);
            const res = await app.postJson('/api/translate/deepl', { text: 'Hi', lang: 'de' });
            expect(res.status).toBe(500);
        });
    });

    describe('OneRingTranslator (/api/translate/onering)', () => {
        test('sends GET with query params and returns data.result', async () => {
            fakeServer.enqueue(jsonReply({ result: 'Ciao mondo' }));

            const res = await app.postJson('/api/translate/onering', {
                text: 'Hello world',
                from_lang: 'en',
                to_lang: 'it',
            });

            expect(res.status).toBe(200);
            expect(res.text).toBe('Ciao mondo');
            expect(fakeServer.requests).toHaveLength(1);
            const [req] = fakeServer.requests;
            expect(req.method).toBe('GET');
            expect(req.originalHost).toBe('onering.example');
            expect(req.pathname).toBe('/translate');
            expect(req.query).toEqual({ text: 'Hello world', from_lang: 'en', to_lang: 'it' });
        });

        test('falls back to default 127.0.0.1:4990 URL when ONERING_URL secret is unset', async () => {
            app.clearSecrets();
            fakeServer.enqueue(jsonReply({ result: 'Hola' }));

            const res = await app.postJson('/api/translate/onering', {
                text: 'Hi',
                from_lang: 'en',
                to_lang: 'es',
            });

            expect(res.status).toBe(200);
            expect(res.text).toBe('Hola');
            expect(fakeServer.requests[0].originalHost).toBe('127.0.0.1:4990');
        });

        test('returns 400 when text, from_lang, or to_lang is missing', async () => {
            expect((await app.postJson('/api/translate/onering', { from_lang: 'en', to_lang: 'it' })).status).toBe(400);
            expect((await app.postJson('/api/translate/onering', { text: 'Hi', to_lang: 'it' })).status).toBe(400);
            expect((await app.postJson('/api/translate/onering', { text: 'Hi', from_lang: 'en' })).status).toBe(400);
            expect(fakeServer.requests).toHaveLength(0);
        });

        test.each(STANDARD_UPSTREAM_ERRORS)('returns 500 on upstream %s', async (_label, errorReply) => {
            fakeServer.enqueue(errorReply);
            const res = await app.postJson('/api/translate/onering', { text: 'Hi', from_lang: 'en', to_lang: 'it' });
            expect(res.status).toBe(500);
        });
    });

    describe('DeepLX (/api/translate/deeplx)', () => {
        test.each([
            ['ja', 'ja'],
            ['zh-CN', 'ZH'],
            ['zh-TW', 'ZH'],
        ])('posts JSON payload for %s -> %s and returns data field', async (inputLang, expectedLang) => {
            fakeServer.enqueue(jsonReply({ data: `deeplx-${expectedLang}` }));

            const res = await app.postJson('/api/translate/deeplx', { text: 'Hello', lang: inputLang });

            expect(res.status).toBe(200);
            expect(res.text).toBe(`deeplx-${expectedLang}`);
            expect(fakeServer.requests).toHaveLength(1);
            const [req] = fakeServer.requests;
            expect(req.method).toBe('POST');
            expect(req.originalUrl).toBe('https://deeplx.example/translate');
            expect(req.json).toEqual({
                text: 'Hello',
                source_lang: 'auto',
                target_lang: expectedLang,
            });
        });

        test('falls back to default 127.0.0.1:1188 URL when DEEPLX_URL secret is unset', async () => {
            app.clearSecrets();
            fakeServer.enqueue(jsonReply({ data: 'Bonjour' }));

            const res = await app.postJson('/api/translate/deeplx', { text: 'Hi', lang: 'fr' });

            expect(res.status).toBe(200);
            expect(res.text).toBe('Bonjour');
            expect(fakeServer.requests[0].originalUrl).toBe('http://127.0.0.1:1188/translate');
        });

        test('returns 400 when text or lang is missing', async () => {
            expect((await app.postJson('/api/translate/deeplx', { lang: 'ja' })).status).toBe(400);
            expect((await app.postJson('/api/translate/deeplx', { text: 'Hi' })).status).toBe(400);
            expect(fakeServer.requests).toHaveLength(0);
        });

        test.each(STANDARD_UPSTREAM_ERRORS)('returns 500 on upstream %s', async (_label, errorReply) => {
            fakeServer.enqueue(errorReply);
            const res = await app.postJson('/api/translate/deeplx', { text: 'Hi', lang: 'ja' });
            expect(res.status).toBe(500);
        });
    });

    describe('Bing Translate (/api/translate/bing)', () => {
        test.each([
            ['fr', 'fr'],
            ['zh-CN', 'zh-Hans'],
            ['zh-TW', 'zh-Hant'],
            ['pt-BR', 'pt'],
        ])('normalizes lang %s -> %s and translates via loopback-intercepted HTTPS', async (inputLang, expectedTo) => {
            fakeServer.setHandler((req) => {
                if (req.method === 'GET' && req.pathname === '/translator') {
                    return bingConfigPageHtml();
                }
                if (req.method === 'POST' && req.pathname === '/ttranslatev3') {
                    return bingTranslateReply(`bing-${expectedTo}`, expectedTo);
                }
                return htmlErrorReply(404, 'not found');
            });

            const res = await app.postJson('/api/translate/bing', { text: 'Hello', lang: inputLang });

            expect(res.status).toBe(200);
            expect(res.text).toBe(`bing-${expectedTo}`);
            const translateCall = fakeServer.requests.find(r => r.pathname === '/ttranslatev3');
            expect(translateCall).toBeDefined();
            expect(translateCall.originalHost).toBe('bing.com');
            expect(translateCall.form.to).toBe(expectedTo);
            expect(translateCall.form.text).toBe('Hello');
        });

        test('returns 400 when text or lang is missing', async () => {
            expect((await app.postJson('/api/translate/bing', { lang: 'fr' })).status).toBe(400);
            expect((await app.postJson('/api/translate/bing', { text: 'Hi' })).status).toBe(400);
            expect(fakeServer.requests).toHaveLength(0);
        });

        test.each(STANDARD_UPSTREAM_ERRORS)('returns 500 on upstream %s', async (_label, errorReply) => {
            fakeServer.setHandler((req) => {
                if (req.method === 'GET' && req.pathname === '/translator') {
                    return bingConfigPageHtml();
                }
                return errorReply;
            });
            const res = await app.postJson('/api/translate/bing', { text: 'Hello', lang: 'fr' });
            expect(res.status).toBe(500);
        });
    });
});
