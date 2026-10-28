import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, selectSampleCharacter } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 60_000 });

const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];
const STARTUP_TIMEOUT = 20_000;

async function expectHome(page) {
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await expect(page.locator('#form_sheld')).toBeHidden();
    await expect(page.locator('#sb-home-toggle')).toHaveClass(/\bis-current\b/);
    await expect(page.locator('#sb-home-toggle')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#sb-topbar-title')).toHaveText('Home');
}

async function expectChat(page) {
    await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/, { timeout: STARTUP_TIMEOUT });
    await expect(page.locator('#form_sheld')).toBeVisible();
    await expect(page.locator('#sb-home-toggle')).not.toHaveClass(/\bis-current\b/);
    await expect(page.locator('#sb-home-toggle')).not.toHaveAttribute('aria-current', /.*/);
}

async function closeChatWithComposerFocused(page) {
    await page.evaluate(async () => {
        document.getElementById('send_textarea').focus();
        await window.SillyTavern.getContext().closeCurrentChat();
    });
}

async function openConversationOverHome(page) {
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const character = context.characters.find(entry => /Bunny Guide|Seraphina/.test(entry?.name ?? ''));
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        if (!openConversationWorkspaceForAvatar(character.avatar, { showToast: false, enable: true })) {
            throw new Error('Could not open the Conversation workspace.');
        }
    });
    await expect(page.locator('#sheld[data-sb-conversation-mode="on"]')).toBeAttached({ timeout: STARTUP_TIMEOUT });
}

for (const { name, options } of VIEWPORTS) {
    test.describe(`Home state at ${name}`, () => {
        test.use(options);

        test.beforeEach(async ({ page }) => {
            await protectMaintainerServer(page);
            await openQuietChatForSmoke(page, { selectCharacter: false });
        });

        test('boots to Home without a composer and fills the shell', async ({ page }) => {
            await expectHome(page);

            const gap = await page.evaluate(() => {
                const sheld = document.getElementById('sheld').getBoundingClientRect();
                const chat = document.getElementById('chat').getBoundingClientRect();
                return sheld.bottom - chat.bottom;
            });
            expect(gap).toBeLessThanOrEqual(2);
            expect(gap).toBeGreaterThanOrEqual(-2);
        });

        test('opening a chat leaves Home and brings the composer back', async ({ page }) => {
            await expectHome(page);

            await selectSampleCharacter(page);

            await expectChat(page);
            await expect(page.locator('#sb-topbar-title')).not.toHaveText('Home');
        });

        test('Ctrl+O from a chat returns to Home with the composer hidden and unfocused', async ({ page }) => {
            await selectSampleCharacter(page);
            await expectChat(page);
            await page.locator('#chat').click({ position: { x: 4, y: 4 } });

            await page.keyboard.press('Control+O');

            await expectHome(page);
            const focusInComposer = await page.evaluate(() => document.getElementById('form_sheld').contains(document.activeElement));
            expect(focusInComposer).toBe(false);
        });

        test('closing a chat with the composer focused drops the focus', async ({ page }) => {
            // Chromium moves focus off an element that becomes display:none, so this check cannot fail without the
            // explicit blur. The blur matters for WebKit, and the WebKit container run covers this spec.
            await selectSampleCharacter(page);
            await expectChat(page);

            await closeChatWithComposerFocused(page);

            await expectHome(page);
            const focusInComposer = await page.evaluate(() => document.getElementById('form_sheld').contains(document.activeElement));
            expect(focusInComposer).toBe(false);
        });

        test('Conversation over Home clears Home, and closing it restores Home', async ({ page }) => {
            await expectHome(page);

            await openConversationOverHome(page);

            await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/);
            await expect(page.locator('#sb-home-toggle')).not.toHaveClass(/\bis-current\b/);

            await page.evaluate(() => window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace')));

            await expectHome(page);
        });
    });
}

test.describe('Home title with custom top bar text', () => {
    test.beforeEach(async ({ page }) => {
        await protectMaintainerServer(page);
        await page.addInitScript(() => {
            localStorage.setItem('sb-topbar-label-desktop-parts', JSON.stringify(['custom']));
            localStorage.setItem('sb-topbar-label-mobile-part', 'custom');
            localStorage.setItem('sb-topbar-label-custom-text', 'My Bunny');
        });
        await openQuietChatForSmoke(page, { selectCharacter: false });
    });

    test('the custom text wins over the Home label', async ({ page }) => {
        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
        await expect(page.locator('#sb-topbar-title')).toHaveText('My Bunny');
    });
});

test.describe('Home state on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test.beforeEach(async ({ page }) => {
        await protectMaintainerServer(page);
        await openQuietChatForSmoke(page, { selectCharacter: false });
    });

    test('the chat chip and sheet are not shown on Home', async ({ page }) => {
        await expectHome(page);

        await expect(page.locator('html')).not.toHaveAttribute('data-sb-mobile-chat-bar-shown', /.*/);
        await expect(page.locator('.sb-bottom-chat-chip')).toBeHidden();
        await expect(page.locator('#sb-bottom-chat-sheet')).toHaveCount(0);

        await selectSampleCharacter(page);

        await expect(page.locator('html')).toHaveAttribute('data-sb-mobile-chat-bar-shown', '', { timeout: STARTUP_TIMEOUT });
        await expect(page.locator('.sb-bottom-chat-chip')).toBeVisible();
    });

    test('a side panel sheet opened on Home has a height and stays inside the shell', async ({ page }) => {
        await expectHome(page);

        await page.evaluate(async () => {
            const source = document.createElement('section');
            source.id = 'qa-home-panel';
            const control = document.createElement('button');
            control.textContent = 'Panel control';
            source.append(control);
            document.getElementById('movingDivs').append(source);
            const sidePanels = await import('/scripts/sillybunny-editor/side-panel.js');
            const panel = sidePanels.registerSidePanel({ id: 'qa-home-panel', element: source, title: 'Home panel', defaultSide: 'left' });
            await panel.open({ opener: document.body });
        });

        const panel = page.locator('.sb-side-panel[data-sb-side-panel-id="qa-home-panel"]');
        await expect(panel).toBeVisible();
        await expect(panel).toHaveClass(/sb-side-panel--sheet/);
        await expect.poll(() => panel.evaluate(element => element.getAnimations().length)).toBe(0);
        const box = await panel.boundingBox();
        const shell = await page.locator('#sheld').boundingBox();
        expect(box.height).toBeGreaterThan(100);
        expect(box.y + box.height).toBeLessThanOrEqual(shell.y + shell.height + 1);
    });

    test('returning to Home closes the open chat sheet', async ({ page }) => {
        await selectSampleCharacter(page);
        await page.locator('.sb-bottom-chat-chip').click();
        await expect(page.locator('#sb-bottom-chat-sheet')).toBeVisible();

        await page.evaluate(() => window.SillyTavern.getContext().closeCurrentChat());

        await expectHome(page);
        await expect(page.locator('#sb-bottom-chat-sheet')).toHaveCount(0);
        await expect(page.locator('html')).not.toHaveAttribute('data-sb-mobile-chat-bar-shown', /.*/);
    });

    test('returning to Home closes the mobile chat tools', async ({ page }) => {
        await selectSampleCharacter(page);
        await page.evaluate(() => window.SillyBunnyShell.openChatTools());
        await expect(page.locator('#sb-mobile-chat-tools.sb-chat-tools-open')).toBeVisible();

        await page.evaluate(() => window.SillyTavern.getContext().closeCurrentChat());

        await expectHome(page);
        await expect(page.locator('#sb-mobile-chat-tools.sb-chat-tools-open')).toHaveCount(0);
    });
});
