import { expect, test } from '@playwright/test';
import { bootConversationPage, getCharacterAvatars } from './helpers/conversation-list-steps.js';
import { seedConversation } from './helpers/conversation-seed.js';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120000 });

const MODULES = '/scripts/sillybunny-conversation/';
// What `lazy-parts.js` loads later: the runtime (the worker, the asides, the reply stream) and the workspace (the interface).
const RUNTIME_MODULES = ['runtime.js', 'auto-engine.js', 'generation.js', 'send-queue.js'];
const WORKSPACE_MODULES = ['chrome.js', 'interface.js', 'timeline-render.js', 'pickers.js', 'conversation-list-view.js'];

/** The page records its fetches in a buffer of 250 entries unless it is told to keep more, and a start makes about 900. */
async function keepEveryFetch(page) {
    await page.addInitScript(() => window.performance.setResourceTimingBufferSize(2000));
}

async function fetchedModules(page) {
    const paths = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname));
    return paths.filter(path => path.startsWith(MODULES)).map(path => path.slice(MODULES.length));
}

/** Waits for the start to settle: the data module has the list of the persona, and the page asks for nothing more. */
async function waitForStart(page) {
    await page.waitForFunction(async () => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        await conversationData.whenReady();
        return true;
    });
    let previous = -1;
    await expect.poll(async () => {
        const count = await page.evaluate(() => performance.getEntriesByType('resource').length);
        const settled = count === previous;
        previous = count;
        return settled;
    }, { intervals: [400, 400, 400], timeout: 20000 }).toBe(true);
}

test.describe('the parts of Conversation Mode that load after the page has started', () => {
    test('a page without a conversation fetches neither the runtime nor the workspace', async ({ page, baseURL }) => {
        await keepEveryFetch(page);
        await bootConversationPage(page, baseURL);
        await waitForStart(page);

        const modules = await fetchedModules(page);

        expect(modules).toContain('index.js');
        for (const name of [...RUNTIME_MODULES, ...WORKSPACE_MODULES]) {
            expect(modules).not.toContain(name);
        }
    });

    test('a page with a conversation starts the worker without the workspace, and the workspace comes with the first open', async ({ page, baseURL }) => {
        await keepEveryFetch(page);
        await bootConversationPage(page, baseURL);
        const { seraphina } = await getCharacterAvatars(page);
        await seedConversation(page, { avatar: seraphina, chats: [{ messages: [{ role: 'character', mes: 'Hello' }] }] });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForStart(page);

        await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-conversation/state.js')).conversationState.autoWorkerStarted)).toBe(true);
        let modules = await fetchedModules(page);
        for (const name of RUNTIME_MODULES) {
            expect(modules).toContain(name);
        }
        for (const name of WORKSPACE_MODULES) {
            expect(modules).not.toContain(name);
        }

        await page.evaluate(avatar => window.dispatchEvent(new CustomEvent('sb:open-conversation-workspace', { detail: { avatar, showToast: false } })), seraphina);

        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
        await expect(page.locator('#sb_conversation_timeline .sb-conversation-message').first()).toBeVisible();
        modules = await fetchedModules(page);
        for (const name of WORKSPACE_MODULES) {
            expect(modules).toContain(name);
        }
    });

    test.describe('the approach to the mode toggle', () => {
        const TOGGLE = '#sb-mode-toggle';

        async function bootSettledPage(page, baseURL) {
            await keepEveryFetch(page);
            await bootConversationPage(page, baseURL);
            await waitForStart(page);
            await expect(page.locator(TOGGLE)).toBeVisible();
        }

        /** The approach prefetches the parts; it does not open the workspace or change what the page says is open. */
        async function expectNothingOpened(page) {
            await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-conversation-mode', 'on');
            expect(await page.evaluate(async () => (await import('/scripts/sillybunny-conversation/state.js')).conversationState.conversationWorkspaceOpen)).toBe(false);
        }

        const BOTH_PARTS = expect.arrayContaining([...WORKSPACE_MODULES, ...RUNTIME_MODULES]);

        test('hovering it fetches the workspace and the runtime and opens nothing', async ({ page, baseURL }) => {
            await bootSettledPage(page, baseURL);
            expect(await fetchedModules(page)).not.toContain('chrome.js');

            await page.locator(TOGGLE).hover();

            await expect.poll(() => fetchedModules(page)).toEqual(BOTH_PARTS);
            await expectNothingOpened(page);
        });

        test('moving the focus to it does the same', async ({ page, baseURL }) => {
            await bootSettledPage(page, baseURL);

            await page.locator(TOGGLE).focus();

            await expect.poll(() => fetchedModules(page)).toEqual(BOTH_PARTS);
            await expectNothingOpened(page);
        });

        test('a touch on it does the same', async ({ page, baseURL }) => {
            await bootSettledPage(page, baseURL);

            await page.locator(TOGGLE).dispatchEvent('touchstart');

            await expect.poll(() => fetchedModules(page)).toEqual(BOTH_PARTS);
            await expectNothingOpened(page);
        });

        test('hovering it again fetches nothing twice, and the open that follows finds the workspace loaded', async ({ page, baseURL }) => {
            await bootSettledPage(page, baseURL);
            const { seraphina } = await getCharacterAvatars(page);

            await page.locator(TOGGLE).hover();
            await expect.poll(() => fetchedModules(page)).toEqual(BOTH_PARTS);
            await page.mouse.move(0, 0);
            await page.locator(TOGGLE).hover();
            await page.evaluate(avatar => window.dispatchEvent(new CustomEvent('sb:open-conversation-workspace', { detail: { avatar, showToast: false } })), seraphina);
            await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');

            const modules = await fetchedModules(page);
            expect(modules.filter(name => name === 'chrome.js')).toHaveLength(1);
            expect(modules.filter(name => name === 'runtime.js')).toHaveLength(1);
        });
    });
});
