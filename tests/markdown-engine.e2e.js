import { expect, test } from '@playwright/test';
import { openReadyChat } from './chat-scroll-regression-helpers.js';

const NESTED_EMPHASIS = '*one **two *three* two** one*';
const SHOWDOWN_HTML = '<p>*one <strong>two *three* two</strong> one*</p>';
const MARKDOWN_IT_HTML = '<p><em>one <strong>two <em>three</em> two</strong> one</em></p>';

test.setTimeout(60_000);

let savedEngines = [];

test.beforeEach(async ({ page }) => {
    savedEngines = [];
    let settingsVersion = Date.now();
    // Answered here, so the run leaves the server's settings as they were.
    await page.route('**/api/settings/save', async (route) => {
        savedEngines.push(JSON.parse(route.request().postData() ?? '{}').power_user?.markdown_engine);
        await route.fulfill({ json: { result: 'ok', version: ++settingsVersion } });
    });
    // Every load of the chat, including the reload after an engine change, ends with a message that has nested emphasis.
    await page.route('**/api/chats/get', async (route) => {
        const response = await route.fetch();
        const chat = await response.json();
        const messages = Array.isArray(chat) && chat.length > 0 ? chat : [{ chat_metadata: {} }];
        messages.push({
            name: 'Markdown Engine Test',
            is_user: false,
            is_system: false,
            send_date: '2024-01-01T00:00:00.000Z',
            mes: NESTED_EMPHASIS,
            extra: {},
        });
        await route.fulfill({ response, json: messages });
    });
});

/**
 * Picks an engine in the User Settings select. The select sits in a collapsed settings drawer, so the change event
 * is dispatched on it directly.
 * @param {import('@playwright/test').Page} page
 * @param {string} engine
 */
async function selectEngine(page, engine) {
    await page.locator('#markdown_engine').evaluate((select, value) => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }, engine);
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>} messageFormatting() output for the nested emphasis text
 */
async function formatNestedEmphasis(page) {
    return page.evaluate(async (text) => {
        const { messageFormatting } = await import('/script.js');
        return messageFormatting(text, 'Markdown Engine Test', false, false, -1, {}, false);
    }, NESTED_EMPHASIS);
}

test.describe('markdown engine setting', () => {
    test('switching the engine changes messageFormatting output and re-renders the open chat', async ({ page }) => {
        await openReadyChat(page);
        // Auto-fix Markdown removes the spaces inside nested emphasis before either engine sees the text.
        await page.evaluate(() => {
            window.SillyTavern.getContext().powerUserSettings.auto_fix_generated_markdown = false;
        });

        const engineSelect = page.locator('#markdown_engine');
        const testMessageText = page.locator('#chat .mes').last().locator('.mes_text');

        await selectEngine(page, 'showdown');
        await expect(engineSelect).toHaveValue('showdown');
        await expect(testMessageText).toHaveText('*one two *three* two one*');
        await expect(testMessageText.locator('em')).toHaveCount(0);
        await expect(testMessageText.locator('strong')).toHaveText('two *three* two');
        expect(await formatNestedEmphasis(page)).toContain(SHOWDOWN_HTML);

        await page.locator('#chat .mes').last().evaluate((message) => {
            message.dataset.markdownEngineTest = 'showdown';
        });
        await selectEngine(page, 'markdown-it');
        await expect(engineSelect).toHaveValue('markdown-it');
        await expect(page.locator('#chat .mes[data-markdown-engine-test]')).toHaveCount(0);
        await expect(testMessageText).toHaveText('one two three two one');
        await expect(testMessageText.locator('em strong em')).toHaveText('three');
        expect(await formatNestedEmphasis(page)).toContain(MARKDOWN_IT_HTML);
        await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().powerUserSettings.markdown_engine)).toBe('markdown-it');
        await expect.poll(() => savedEngines.at(-1)).toBe('markdown-it');

        await selectEngine(page, 'showdown');
        await expect(engineSelect).toHaveValue('showdown');
        await expect(testMessageText).toHaveText('*one two *three* two one*');
        await expect(testMessageText.locator('em')).toHaveCount(0);
        await expect(testMessageText.locator('strong')).toHaveText('two *three* two');
        expect(await formatNestedEmphasis(page)).toContain(SHOWDOWN_HTML);
        await expect.poll(() => savedEngines.at(-1)).toBe('showdown');
    });
});
