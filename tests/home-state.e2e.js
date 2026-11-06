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
        const character = context.characters.find(entry => /Seraphina/.test(entry?.name ?? ''));
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

        test('boots to Home without a composer and fills the shell down to the composer gap', async ({ page }) => {
            await expectHome(page);

            const { gap, expectedGap } = await page.evaluate(() => {
                const sheld = document.getElementById('sheld').getBoundingClientRect();
                const chat = document.getElementById('chat').getBoundingClientRect();
                // Desktop Home ends where the Roleplay composer card ends, one composer gap above the shell's bottom edge.
                const probe = document.createElement('div');
                probe.style.cssText = 'position: absolute; visibility: hidden; padding-block-end: max(var(--sb-chat-composer-edge-gap), var(--sb-safe-area-bottom));';
                document.body.append(probe);
                const composerGap = parseFloat(getComputedStyle(probe).paddingBlockEnd);
                probe.remove();
                return { gap: sheld.bottom - chat.bottom, expectedGap: window.innerWidth >= 769 ? composerGap : 0 };
            });
            expect(Math.abs(gap - expectedGap)).toBeLessThanOrEqual(1);
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

const TOP_BAR_VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'wide 1744x1000', options: { viewport: { width: 1744, height: 1000 } } },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];
const TOP_BAR_TOLERANCE = 0.5;

/** The box of every visible element in the top bar, by id or by its tag and classes with a running count. */
function readTopBar(page) {
    return page.evaluate(() => {
        const boxes = {};
        const counts = {};
        for (const node of document.querySelectorAll('#top-bar, #top-bar *')) {
            const rect = node.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const base = node.id ? `#${node.id}` : `${node.tagName.toLowerCase()}.${[...node.classList].join('.')}`;
            counts[base] = (counts[base] ?? 0) + 1;
            boxes[`${base}[${counts[base]}]`] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
        return boxes;
    });
}

/** Names every item that moved or changed size by more than the tolerance, or that only one of the two states has. */
function describeTopBarChanges(before, after) {
    const changes = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const [a, b] = [before[key], after[key]];
        if (!a || !b) {
            changes.push(`${key} only in ${a ? 'Home' : 'the chat'}`);
            continue;
        }
        const moved = ['x', 'y', 'width', 'height'].filter(side => Math.abs(a[side] - b[side]) > TOP_BAR_TOLERANCE);
        if (moved.length) changes.push(`${key} ${moved.map(side => `${side} ${a[side].toFixed(1)} -> ${b[side].toFixed(1)}`).join(', ')}`);
    }
    return changes;
}

for (const { name, options } of TOP_BAR_VIEWPORTS) {
    test.describe(`Top bar position at ${name}`, () => {
        test.use(options);

        test.beforeEach(async ({ page }) => {
            await protectMaintainerServer(page);
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await expectHome(page);
        });

        test('every item of the top bar is where it is in a chat', async ({ page }) => {
            const onHome = await readTopBar(page);

            await selectSampleCharacter(page);
            await expectChat(page);
            await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).length)).toBe(0);
            const inChat = await readTopBar(page);

            expect(Object.keys(onHome).length).toBeGreaterThan(5);
            // The title names the page, so its width differs by design. The two groups of buttons share the room it leaves,
            // so their own boxes change while the buttons in them stay put.
            const skipped = key => /^#sb-topbar-title|^#sb-topbar-chat|^div\.sb-topbar-(brand|group)/.test(key);
            const changes = describeTopBarChanges(onHome, inChat).filter(change => !skipped(change));
            expect(changes).toEqual([]);
        });

        test('the top bar stays put in every frame while the shell narrows from the Home width to the chat width', async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'no-preference' });
            await page.evaluate(() => document.body.classList.remove('reduced-motion'));
            const onHome = await readTopBar(page);
            await page.evaluate(() => {
                window.qaFrames = [];
                const sample = () => {
                    const stack = document.getElementById('sb-topbar-stack').getBoundingClientRect();
                    const buttons = [...document.querySelectorAll('#top-bar button')].map(button => button.getBoundingClientRect().x);
                    window.qaFrames.push({ shell: document.getElementById('sheld').getBoundingClientRect().width, stack: [stack.x, stack.width], buttons });
                    if (window.qaFrames.length < 90) requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
            });

            await selectSampleCharacter(page);
            await expectChat(page);
            await expect.poll(() => page.evaluate(() => window.qaFrames.length)).toBe(90);

            const frames = await page.evaluate(() => window.qaFrames);
            const shellWidths = new Set(frames.map(frame => Math.round(frame.shell)));
            const stack = onHome['#sb-topbar-stack[1]'];
            const first = frames[0];
            if (name.startsWith('phone')) {
                expect(shellWidths.size).toBe(1);
            } else {
                // Without the shell animating, the check below would pass whatever the top bar does.
                expect(shellWidths.size, 'the shell width animates between the two states').toBeGreaterThan(2);
            }
            for (const frame of frames) {
                expect(Math.abs(frame.stack[0] - stack.x)).toBeLessThanOrEqual(TOP_BAR_TOLERANCE);
                expect(Math.abs(frame.stack[1] - stack.width)).toBeLessThanOrEqual(TOP_BAR_TOLERANCE);
                expect(frame.buttons.length).toBe(first.buttons.length);
                frame.buttons.forEach((x, index) => expect(Math.abs(x - first.buttons[index])).toBeLessThanOrEqual(TOP_BAR_TOLERANCE));
            }
        });
    });
}

test.describe('Home column width at desktop', () => {
    for (const width of [1440, 1744]) {
        test(`the column is the Home width and wider than the chat column at ${width}`, async ({ page }) => {
            await page.setViewportSize({ width, height: 1000 });
            await protectMaintainerServer(page);
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await expectHome(page);

            const home = await page.evaluate(() => {
                const probe = document.createElement('div');
                probe.style.cssText = 'position: absolute; visibility: hidden; width: var(--sb-home-width);';
                document.body.append(probe);
                const expected = probe.getBoundingClientRect().width;
                probe.remove();
                return { expected, column: document.getElementById('chat').getBoundingClientRect().width, shell: document.getElementById('sheld').getBoundingClientRect().width };
            });
            await selectSampleCharacter(page);
            await expectChat(page);
            await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).length)).toBe(0);
            const chatWidth = await page.evaluate(() => document.getElementById('chat').getBoundingClientRect().width);

            expect(Math.abs(home.shell - home.expected)).toBeLessThanOrEqual(1);
            expect(home.column).toBeGreaterThan(chatWidth);
        });
    }
});
