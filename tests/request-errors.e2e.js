import http from 'node:http';
import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { withoutAssistantAccount } from './helpers/assistant-library.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { quickOr } from './helpers/matrix.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

const FAILURES = {
    '401json': [401, 'application/json', '{"error":{"message":"Incorrect API key provided: sk-bad.","type":"invalid_request_error"}}'],
    '400json': [400, 'application/json', '{"error":{"message":"max_tokens is too large for this model."}}'],
    '401text': [401, 'text/plain', 'Unauthorized'],
    '403html': [403, 'text/html', '<html><body><h1>403 Forbidden</h1></body></html>'],
    '404empty': [404, 'text/plain', ''],
    '429json': [429, 'application/json', '{"error":{"message":"Rate limit reached for requests"}}'],
    '500text': [500, 'text/plain', 'upstream connect error or disconnect/reset before headers'],
    '502html': [502, 'text/html', '<html><head><title>502 Bad Gateway</title></head><body>Bad gateway</body></html>'],
};

const HINTS = {
    key: 'The provider didn\'t accept your API key. Check it in Backend ▸ Connections.',
    model: 'The provider couldn\'t find the selected model or address. Check both in Backend ▸ Connections.',
    rate: 'The provider is limiting your requests, or your credits ran out. Wait a moment and try again, or check your account with the provider.',
    down: 'The provider couldn\'t be reached or is having problems. Try again in a few minutes.',
};

/** Rows: [api, failure, the provider text the toast must show, the kind of hint it must carry (or '' for none)]. */
const ROWS = [
    ['chat', '401json', 'Incorrect API key provided: sk-bad.', 'key'],
    ['chat', '400json', 'max_tokens is too large for this model.', ''],
    ['chat', '500text', 'upstream connect error or disconnect/reset before headers', 'down'],
    ['chat-stream', '401text', 'Unauthorized', 'key'],
    ['chat-stream', '404empty', 'Not Found', 'model'],
    ['chat-stream', '502html', 'Bad Gateway', 'down'],
    ['text', '429json', 'Rate limit reached for requests', 'rate'],
    ['text', '403html', 'Unknown error (403)', 'key'],
    ['text-stream', '401json', 'Incorrect API key provided: sk-bad.', 'key'],
    ['text-stream', '500text', 'upstream connect error or disconnect/reset before headers', 'down'],
];

// A quick run keeps one row per API path, because each path reports a failure through its own code.
const FIRST_ROW_OF_EACH_API = ROWS.filter(([api], index) => ROWS.findIndex(([other]) => other === api) === index);

const TOAST_TITLES = ['Chat Completion API', 'Text Completion API', 'Text generation error'];

/**
 * A provider that fails the way the test asks: /fail/<name>/... answers with that failure.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
async function startFailingProvider() {
    const server = http.createServer((request, response) => {
        const [status, type, body] = FAILURES[request.url.split('/')[2]] ?? [404, 'text/plain', 'unknown failure'];
        request.resume();
        request.on('end', () => {
            response.writeHead(status, { 'content-type': type });
            response.end(body);
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

/** Opens the first chat with the toast recorder installed, so every row of the table starts from the same page. */
async function openChatWithToastRecorder(page) {
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyHomeTestSettings(settings);
        settings.accountStorage = { ...withoutAssistantAccount(settings.accountStorage), WelcomePage_LastMode: 'roleplay' };
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/chats/save', route => route.fulfill({ json: { result: 'ok' } }));
    await page.addInitScript(() => {
        window.requestErrorToasts = [];
        document.addEventListener('DOMContentLoaded', () => {
            new MutationObserver((records) => {
                for (const record of records) {
                    for (const node of record.addedNodes) {
                        if (!(node instanceof HTMLElement) || !node.classList.contains('toast')) continue;
                        const hint = node.querySelector('[data-sb-request-error-hint]');
                        window.requestErrorToasts.push({
                            title: node.querySelector('.toast-title')?.textContent ?? '',
                            message: (hint ? hint.previousElementSibling : node.querySelector('.toast-message'))?.textContent ?? '',
                            kind: hint?.getAttribute('data-sb-request-error-hint') ?? '',
                            hint: hint?.textContent ?? '',
                        });
                    }
                }
            }).observe(document.body, { childList: true, subtree: true });
        });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await testSetup.waitForAppReady({ page });
    const card = page.locator('#chat > .welcomePanel .sbHomeCard[data-sb-home-key="assistant-reisen"]');
    await expect(card.locator('.sbHomeCardOpen')).toBeEnabled({ timeout: 30000 });
    await card.locator('.sbHomeFootButton').first().click();
    await expect(page.locator('#chat .mes[mesid="0"]')).toBeVisible({ timeout: 30000 });
}

test.describe('failed generation requests show the provider message and a hint instead of the HTTP reason', () => {
    test.describe.configure({ timeout: 90000 });

    /** @type {{ port: number, close: () => Promise<void> }} */
    let provider;
    test.beforeAll(async () => {
        provider = await startFailingProvider();
    });
    test.afterAll(async () => {
        await provider.close();
    });

    for (const [api, failure, expectedMessage, expectedKind] of quickOr(ROWS, FIRST_ROW_OF_EACH_API)) {
        test(`${api} answered with ${failure}`, async ({ page }) => {
            await openChatWithToastRecorder(page);
            await page.evaluate(async ({ api, failure, port }) => {
                const script = await import('/script.js');
                const { oai_settings } = await import('/scripts/openai.js');
                const { textgenerationwebui_settings: textgen } = await import('/scripts/textgen-settings.js');
                const base = `http://127.0.0.1:${port}/fail/${failure}`;
                if (api.startsWith('chat')) {
                    $('#main_api').val('openai').trigger('change');
                    oai_settings.chat_completion_source = 'custom';
                    oai_settings.custom_url = `${base}/v1`;
                    oai_settings.custom_model = 'test-model';
                    oai_settings.stream_openai = api === 'chat-stream';
                } else {
                    $('#main_api').val('textgenerationwebui').trigger('change');
                    textgen.type = 'generic';
                    textgen.server_urls = { ...textgen.server_urls, generic: base };
                    textgen.streaming = api === 'text-stream';
                }
                script.setOnlineStatus('Valid');
            }, { api, failure, port: provider.port });

            await page.locator('#send_textarea').fill(`hello ${api} ${failure}`);
            await page.locator('#send_but').click();

            await expect.poll(
                () => page.evaluate(titles => window.requestErrorToasts.filter(toast => titles.includes(toast.title)), TOAST_TITLES),
                { timeout: 15000 },
            ).toHaveLength(1);

            const [toast] = await page.evaluate(titles => window.requestErrorToasts.filter(entry => titles.includes(entry.title)), TOAST_TITLES);
            expect(toast.message).toBe(expectedMessage);
            expect(toast.kind).toBe(expectedKind);
            expect(toast.hint).toBe(expectedKind ? HINTS[expectedKind] : '');
        });
    }
});
