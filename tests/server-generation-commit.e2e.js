import http from 'node:http';
import { expect, test } from '@playwright/test';
import { APP_URL, dismissOpenDialogIfPresent, selectSampleCharacter } from './chat-scroll-regression-helpers.js';
import { testSetup } from './frontend/frontent-test-utils.js';

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

const MODEL = 'fake-stream-model';
const CHUNKS = Array.from({ length: 20 }, (_, index) => `word${index} `);
const FULL_REPLY = CHUNKS.join('').trim();

/**
 * An OpenAI-compatible server that streams CHUNKS slowly, so a test can act while a reply is written.
 * @param {number} intervalMs Delay between chunks
 * @param {string} [deltaField] Delta field that carries CHUNKS: content for reply text, reasoning_content for reasoning
 * @returns {Promise<http.Server>}
 */
function startFakeModel(intervalMs, deltaField = 'content') {
    const server = http.createServer((request, response) => {
        if (request.method === 'GET' && request.url.endsWith('/models')) {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
            return;
        }
        if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
            response.writeHead(404);
            response.end();
            return;
        }
        request.resume();
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const chunk = (delta, finishReason = null) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
        let index = 0;
        const timer = setInterval(() => {
            if (index < CHUNKS.length) {
                response.write(chunk({ [deltaField]: CHUNKS[index++] }));
                return;
            }
            clearInterval(timer);
            response.write(chunk({}, 'stop'));
            response.end('data: [DONE]\n\n');
        }, intervalMs);
        response.on('close', () => clearInterval(timer));
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * Loads the app with real chat saves, unlike openReadyChat(), and opens the sample character's chat.
 * @param {import('@playwright/test').Page} page
 */
async function openChat(page) {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    await testSetup.waitForAppReady({ page });
    await dismissOpenDialogIfPresent(page);
    await selectSampleCharacter(page);
    await dismissOpenDialogIfPresent(page);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} baseUrl Fake model server
 */
async function connectFakeModel(page, baseUrl) {
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function');
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'api'));
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_api_url_text').fill(baseUrl);
    await page.locator('#custom_model_id').fill(MODEL);
    const status = page.waitForResponse('**/api/backends/chat-completions/status');
    await page.locator('#api_button_openai').click();
    expect((await status).ok()).toBe(true);
    await page.evaluate(async () => {
        const { oai_settings } = await import('/scripts/openai.js');
        oai_settings.stream_openai = true;
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} text Message to send
 */
async function send(page, text) {
    await page.evaluate(async (message) => {
        const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
        textarea.value = message;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.locator('#send_textarea').press('Enter');
}

test.describe('server-owned chat generations', () => {
    test('staying on the page after a leave-site prompt keeps the reply with the page', async ({ page }) => {
        test.setTimeout(120_000);
        const model = await startFakeModel(250);
        try {
            await openChat(page);
            await connectFakeModel(page, `http://127.0.0.1:${model.address().port}/v1`);
            page.on('dialog', async (dialog) => {
                if (dialog.type() === 'beforeunload') {
                    await dialog.dismiss();
                }
            });

            await send(page, `stay test ${Date.now()}`);
            await page.waitForFunction(() => (window.SillyTavern.getContext().streamingProcessor?.result ?? '').includes('word2'), null, { timeout: 30_000 });

            // Any page part (an unsaved preset, an extension) can ask before the page goes.
            await page.evaluate(() => window.addEventListener('beforeunload', (event) => {
                event.preventDefault();
                event.returnValue = '';
            }));
            const prompted = page.waitForEvent('dialog', { predicate: dialog => dialog.type() === 'beforeunload' });
            await page.close({ runBeforeUnload: true });
            await prompted;

            // waitForFunction() takes a returned Promise as a truthy result, so the check stays synchronous.
            await page.evaluate(async () => {
                window.__isGenerating = (await import('/script.js')).isGenerating;
            });
            await page.waitForFunction(() => !window.SillyTavern.getContext().streamingProcessor && !window.__isGenerating(), null, { timeout: 30_000 });
            const shown = await page.evaluate(() => window.SillyTavern.getContext().chat.at(-1)?.mes ?? '');
            expect(shown.trim()).toBe(FULL_REPLY);

            // A server write over this chat would make this save stop at the integrity popup.
            const saved = await page.evaluate(async () => {
                const context = window.SillyTavern.getContext();
                const outcome = await Promise.race([
                    context.saveChat().then(() => 'saved'),
                    new Promise(resolve => setTimeout(() => resolve(document.querySelector('dialog[open]')?.textContent?.trim() || 'save timed out'), 10_000)),
                ]);
                if (outcome !== 'saved') {
                    return { outcome };
                }
                await context.reloadCurrentChat();
                const last = window.SillyTavern.getContext().chat.at(-1);
                return { outcome, mes: String(last?.mes ?? '').trim(), serverWritten: Boolean(last?.extra?.server_generation) };
            });
            expect(saved).toEqual({ outcome: 'saved', mes: FULL_REPLY, serverWritten: false });
        } finally {
            model.closeAllConnections?.();
            model.close();
        }
    });

    test('a message edit stays open, with its unsaved text, across the reload for a server-written reply', async ({ page }) => {
        test.setTimeout(120_000);
        await openChat(page);
        const original = await page.evaluate(() => window.SillyTavern.getContext().chat[0]?.mes ?? '');
        await page.evaluate(async () => (await import('/script.js')).messageEdit(0));
        const unsaved = `unsaved edit ${Date.now()}`;
        await page.locator('#curEditTextarea').fill(unsaved);
        await page.evaluate(() => {
            document.getElementById('curEditTextarea').dataset.beforeReload = 'true';
        });

        await page.evaluate(async () => (await import('/scripts/server-generations.js')).reloadServerCommittedReply());

        const reopened = page.locator('#curEditTextarea:not([data-before-reload])');
        await expect(reopened).toHaveValue(unsaved, { timeout: 30_000 });
        await expect(page.locator('.mes[mesid="0"] #curEditTextarea')).toHaveCount(1);
        expect(await page.evaluate(() => window.SillyTavern.getContext().chat[0]?.mes)).toBe(original);
    });

    test('hidden tabs leave the browser\'s connections to the server free', async ({ context }) => {
        test.setTimeout(240_000);
        // Over HTTP/1.1 a browser opens about 6 connections per server, shared by every tab.
        const tabCount = 7;
        const pages = [];
        for (let index = 0; index < tabCount; index++) {
            const page = await context.newPage();
            await page.addInitScript((initialVisibility) => {
                const NativeEventSource = window.EventSource;
                const sources = [];
                window.__openEventSources = () => sources.filter(source => source.readyState !== NativeEventSource.CLOSED).length;
                window.EventSource = class extends NativeEventSource {
                    constructor(...args) {
                        super(...args);
                        sources.push(this);
                    }
                };
                // Background tabs are simulated: every Playwright page reports itself visible.
                let visibility = initialVisibility;
                Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
                Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
                window.__setVisibility = (state) => {
                    visibility = state;
                    document.dispatchEvent(new Event('visibilitychange'));
                };
            }, index === 0 ? 'visible' : 'hidden');
            await openChat(page);
            pages.push(page);
        }

        const [front, ...background] = pages;
        await expect.poll(() => front.evaluate(() => window.__openEventSources())).toBe(1);
        for (const page of background) {
            expect(await page.evaluate(() => window.__openEventSources())).toBe(0);
        }
        const status = await front.evaluate(() => Promise.race([
            fetch('/', { cache: 'no-store' }).then(response => response.status),
            new Promise(resolve => setTimeout(() => resolve('stalled'), 5000)),
        ]));
        expect(status).toBe(200);

        await background[2].evaluate(() => window.__setVisibility('visible'));
        await expect.poll(() => background[2].evaluate(() => window.__openEventSources())).toBe(1);
    });
});

for (const { name, options } of [
    { name: 'desktop', options: { viewport: { width: 1440, height: 900 } } },
    {
        name: 'mobile',
        options: {
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        },
    },
]) {
    test.describe(`Stop during streamed reasoning on ${name}`, () => {
        test.use(options);

        test('keeps the reasoning that arrived as finished reasoning and saves the reply', async ({ page }) => {
            test.setTimeout(120_000);
            const model = await startFakeModel(1000, 'reasoning_content');
            try {
                await openChat(page);
                await connectFakeModel(page, `http://127.0.0.1:${model.address().port}/v1`);
                await page.locator('#left-nav-panel .sb-shell-close').click();
                // Enter adds a new line on touch layouts, so send with the button.
                await page.locator('#send_textarea').fill(`stop during reasoning ${Date.now()}`);
                await page.locator('#send_but').click();
                await page.waitForFunction(() => (window.SillyTavern.getContext().streamingProcessor?.pendingReasoning ?? '').includes('word2'), null, { timeout: 30_000 });

                const saved = page.waitForResponse(response => response.url().endsWith('/api/chats/save') && response.request().method() === 'POST', { timeout: 15_000 });
                // Read the reasoning and press Stop in one task, so no chunk can arrive between them.
                const arrived = await page.evaluate(() => {
                    const reasoning = window.SillyTavern.getContext().streamingProcessor.pendingReasoning;
                    document.getElementById('mes_stop').click();
                    return reasoning.trim();
                });
                expect((await saved).ok()).toBe(true);

                const details = page.locator('#chat .last_mes .mes_reasoning_details');
                await expect(details).toHaveAttribute('data-state', 'done');
                await expect(details.locator('.mes_reasoning_header_title')).toHaveText(/^Thought for /);
                await expect(details.locator('.mes_reasoning')).toHaveText(arrived);

                const readLastReply = () => page.evaluate(() => {
                    const message = window.SillyTavern.getContext().chat.at(-1);
                    return {
                        reasoning: message.extra.reasoning,
                        duration: message.extra.reasoning_duration,
                        swipeDuration: message.swipe_info?.[message.swipe_id]?.extra?.reasoning_duration,
                        placeholder: message.extra.server_generation_placeholder ?? null,
                    };
                });
                const stopped = await readLastReply();
                expect(stopped.reasoning).toBe(arrived);
                expect(stopped.duration).toBeGreaterThan(0);
                expect(stopped.swipeDuration).toBe(stopped.duration);
                expect(stopped.placeholder).toBeNull();

                await page.evaluate(() => window.SillyTavern.getContext().reloadCurrentChat());
                expect(await readLastReply()).toEqual(stopped);
                await expect(details).toHaveAttribute('data-state', 'done');
            } finally {
                model.closeAllConnections?.();
                model.close();
            }
        });
    });
}
