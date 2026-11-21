import { expect, test } from '@playwright/test';
import { openReadyChat } from './chat-scroll-regression-helpers.js';
import { openSettingsTab } from './helpers/surfaces/steps.js';

// Auto-fix Markdown off: it removes the spaces inside nested emphasis before either engine sees the text.
const NESTED_EMPHASIS = '*one **two *three* two** one*';
const NESTED_EMPHASIS_SHOWDOWN_HTML = '<p>*one <strong>two *three* two</strong> one*</p>';
const NESTED_EMPHASIS_MARKDOWN_IT_HTML = '<p><em>one <strong>two <em>three</em> two</strong> one</em></p>';
// Auto-fix Markdown on, which is the code default: this text keeps its form for both engines, and they nest it the other way round.
const TRIPLE_EMPHASIS = '***Warning!***';

const VIEWPORTS = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
];

test.setTimeout(90_000);
test.describe.configure({ mode: 'parallel' });

/**
 * Serves the profile of one test: the saved engine (none, as for a profile from before the setting existed), the
 * Auto-fix Markdown choice and one chat message. Saves are answered here and kept, so the run leaves the server's
 * settings as they were and a reload reads back what the page saved.
 * @param {import('@playwright/test').Page} page
 * @param {{ engine?: string, autoFix: boolean, text: string }} profile
 */
async function serveProfile(page, { engine, autoFix, text }) {
    const state = {
        /** @type {Array<string | undefined>} */
        saved: [],
        persisted: engine,
    };
    await page.route('**/api/settings/get', async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        if (typeof data.settings === 'string') {
            const settings = JSON.parse(data.settings);
            settings.power_user = { ...settings.power_user, auto_fix_generated_markdown: autoFix };
            if (state.persisted === undefined) {
                delete settings.power_user.markdown_engine;
            } else {
                settings.power_user.markdown_engine = state.persisted;
            }
            data.settings = JSON.stringify(settings);
        }
        await route.fulfill({ response, json: data });
    });
    let settingsVersion = Date.now();
    await page.route('**/api/settings/save', async (route) => {
        const saved = JSON.parse(route.request().postData() ?? '{}').power_user?.markdown_engine;
        state.saved.push(saved);
        state.persisted = saved;
        await route.fulfill({ json: { result: 'ok', version: ++settingsVersion } });
    });
    // Every read of the chat, including the one after an engine change, ends with the message of the test.
    await page.route('**/api/chats/get', async (route) => {
        const response = await route.fetch();
        // openReadyChat() answers the chat save itself, so a new sample chat has no file and its reload gets a 404.
        const chat = response.ok() ? await response.json() : [];
        const messages = Array.isArray(chat) && chat.length > 0 ? chat : [{ chat_metadata: {} }];
        messages.push({
            name: 'Markdown Engine Test',
            is_user: false,
            is_system: false,
            send_date: '2024-01-01T00:00:00.000Z',
            mes: text,
            extra: {},
        });
        await route.fulfill({ json: messages });
    });
    return state;
}

/**
 * Opens Customize ▸ Messages and returns the toggle row of the Message Display group, found by its title.
 * @param {import('@playwright/test').Page} page
 */
async function openEngineRow(page) {
    await openSettingsTab(page, { shell: 'right', tab: 'messages' });
    const group = page.locator('[data-sb-category="message-display"]');
    await expect(group.getByRole('heading', { name: 'Message Display' })).toBeVisible();
    const choice = group.getByRole('radiogroup', { name: 'Markdown Engine' });
    await expect(choice).toBeVisible();
    return {
        choice,
        markdownIt: choice.getByRole('radio', { name: 'markdown-it', exact: true }),
        showdown: choice.getByRole('radio', { name: 'Showdown', exact: true }),
    };
}

const storedEngine = page => page.evaluate(() => window.SillyTavern.getContext().powerUserSettings.markdown_engine);

/** @param {import('@playwright/test').Page} page */
const lastMessageText = page => page.locator('#chat .mes').last().locator('.mes_text');

/** Marks the last chat message, so that a test can tell when the chat has rendered it again. */
async function markLastMessage(page) {
    await page.locator('#chat .mes').last().evaluate((message) => {
        message.dataset.markdownEngineTest = 'rendered before the switch';
    });
}

/** @param {import('@playwright/test').Page} page */
const markedMessages = page => page.locator('#chat .mes[data-markdown-engine-test]');

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 * @returns {Promise<string>} messageFormatting() output for the text
 */
function format(page, text) {
    return page.evaluate(async (source) => {
        const { messageFormatting } = await import('/script.js');
        return messageFormatting(source, 'Markdown Engine Test', false, false, -1, {}, false);
    }, text);
}

/**
 * Asserts the chat message that the nested emphasis text renders to, for one engine.
 * @param {import('@playwright/test').Page} page
 * @param {'markdown-it' | 'showdown'} engine
 */
async function expectNestedEmphasisFor(page, engine) {
    const message = lastMessageText(page);
    if (engine === 'markdown-it') {
        await expect(message).toHaveText('one two three two one');
        await expect(message.locator('em strong em')).toHaveText('three');
        expect(await format(page, NESTED_EMPHASIS)).toContain(NESTED_EMPHASIS_MARKDOWN_IT_HTML);
    } else {
        await expect(message).toHaveText('*one two *three* two one*');
        await expect(message.locator('em')).toHaveCount(0);
        await expect(message.locator('strong')).toHaveText('two *three* two');
        expect(await format(page, NESTED_EMPHASIS)).toContain(NESTED_EMPHASIS_SHOWDOWN_HTML);
    }
}

for (const viewport of VIEWPORTS) {
    test.describe(`markdown engine setting at ${viewport.width}x${viewport.height}`, () => {
        test.use({ viewport });

        test('a profile without a saved choice starts on markdown-it, and each choice re-renders the open chat, is saved and survives a reload', async ({ page }) => {
            const profile = await serveProfile(page, { autoFix: false, text: NESTED_EMPHASIS });
            await openReadyChat(page);

            let row = await openEngineRow(page);
            await expect(row.markdownIt).toBeChecked();
            await expect(row.showdown).not.toBeChecked();
            expect(await storedEngine(page)).toBe('markdown-it');
            await expectNestedEmphasisFor(page, 'markdown-it');

            await markLastMessage(page);
            await row.showdown.check();
            await expect(row.showdown).toBeChecked();
            await expect(markedMessages(page)).toHaveCount(0);
            await expectNestedEmphasisFor(page, 'showdown');
            await expect.poll(() => storedEngine(page)).toBe('showdown');
            await expect.poll(() => profile.saved.at(-1)).toBe('showdown');

            await openReadyChat(page);
            row = await openEngineRow(page);
            await expect(row.showdown).toBeChecked();
            expect(await storedEngine(page)).toBe('showdown');
            await expectNestedEmphasisFor(page, 'showdown');

            await markLastMessage(page);
            await row.markdownIt.check();
            await expect(row.markdownIt).toBeChecked();
            await expect(markedMessages(page)).toHaveCount(0);
            await expectNestedEmphasisFor(page, 'markdown-it');
            await expect.poll(() => profile.saved.at(-1)).toBe('markdown-it');

            await openReadyChat(page);
            row = await openEngineRow(page);
            await expect(row.markdownIt).toBeChecked();
            expect(await storedEngine(page)).toBe('markdown-it');
            await expectNestedEmphasisFor(page, 'markdown-it');
        });

        test('the keyboard moves the choice with the arrow keys', async ({ page }) => {
            const profile = await serveProfile(page, { autoFix: false, text: NESTED_EMPHASIS });
            await openReadyChat(page);
            const row = await openEngineRow(page);

            await row.markdownIt.focus();
            await page.keyboard.press('ArrowRight');
            await expect(row.showdown).toBeChecked();
            await expect(row.showdown).toBeFocused();
            await expectNestedEmphasisFor(page, 'showdown');
            await expect.poll(() => profile.saved.at(-1)).toBe('showdown');

            await page.keyboard.press('ArrowLeft');
            await expect(row.markdownIt).toBeChecked();
            await expectNestedEmphasisFor(page, 'markdown-it');
            await expect.poll(() => profile.saved.at(-1)).toBe('markdown-it');
        });

        test('with Auto-fix Markdown on, which is the default, the two engines still render the same text differently', async ({ page }) => {
            await serveProfile(page, { autoFix: true, text: TRIPLE_EMPHASIS });
            await openReadyChat(page);
            expect(await page.evaluate(() => window.SillyTavern.getContext().powerUserSettings.auto_fix_generated_markdown)).toBe(true);

            const row = await openEngineRow(page);
            const message = lastMessageText(page);
            await expect(message.locator('em > strong')).toHaveText('Warning!');
            await expect(message.locator('strong > em')).toHaveCount(0);

            await row.showdown.check();
            await expect(message.locator('strong > em')).toHaveText('Warning!');
            await expect(message.locator('em > strong')).toHaveCount(0);

            await row.markdownIt.check();
            await expect(message.locator('em > strong')).toHaveText('Warning!');
            await expect(message.locator('strong > em')).toHaveCount(0);
        });

        test('a settings file that names Showdown loads as Showdown', async ({ page }) => {
            await serveProfile(page, { engine: 'showdown', autoFix: false, text: NESTED_EMPHASIS });
            await openReadyChat(page);

            const row = await openEngineRow(page);
            await expect(row.showdown).toBeChecked();
            expect(await storedEngine(page)).toBe('showdown');
            await expectNestedEmphasisFor(page, 'showdown');
        });

        test('a settings file with an unknown engine name loads as markdown-it', async ({ page }) => {
            await serveProfile(page, { engine: 'marked', autoFix: false, text: NESTED_EMPHASIS });
            await openReadyChat(page);

            const row = await openEngineRow(page);
            await expect(row.markdownIt).toBeChecked();
            await expectNestedEmphasisFor(page, 'markdown-it');
        });
    });
}

test.describe('Showdown converter methods while markdown-it renders', () => {
    test('an extension that calls the Showdown converter does not throw, and each method warns once', async ({ page }) => {
        await serveProfile(page, { autoFix: false, text: NESTED_EMPHASIS });
        const warnings = [];
        page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
        await openReadyChat(page);

        const result = await page.evaluate(async () => {
            const { converter } = await import('/script.js');
            const names = ['addExtension', 'removeExtension', 'useExtension', 'setOption', 'getOption', 'getOptions', 'setFlavor', 'getFlavor', 'listen', 'makeMarkdown'];
            const returns = {};
            for (let round = 0; round < 2; round++) {
                for (const name of names) {
                    returns[name] = typeof converter[name] === 'function' ? typeof converter[name]('x', () => {}) : 'missing';
                }
            }
            return returns;
        });

        expect(result).toEqual({
            addExtension: 'undefined',
            removeExtension: 'undefined',
            useExtension: 'undefined',
            setOption: 'undefined',
            getOption: 'undefined',
            getOptions: 'object',
            setFlavor: 'undefined',
            getFlavor: 'string',
            listen: 'object',
            makeMarkdown: 'string',
        });
        for (const name of ['addExtension', 'removeExtension', 'useExtension', 'setOption', 'getOption', 'getOptions', 'setFlavor', 'getFlavor', 'listen', 'makeMarkdown']) {
            expect(warnings.filter(text => text.includes(`${name}()`)), name).toHaveLength(1);
        }
    });
});
