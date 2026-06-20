/* global document, window */
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

// Mobile shell smoke pack: pins the current open/close contracts of the
// SillyBunny mobile shell (drawers, hamburger nav, chat tools, character
// panel) so the Phase 1 decomposition of sillybunny-tabs.js has a net.
// Run with: SILLYBUNNY_TEST_BASE_URL=http://127.0.0.1:<port> npx playwright test mobile-shell-smoke.e2e.js

test.describe.configure({ mode: 'serial' });

const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_USER_AGENT = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MOBILE_SHELL_NAV_OPEN_GRACE_MS = 450;

function getOverlayStateSnapshot(page) {
    return page.evaluate(() => {
        const isDrawerOpen = id => document.getElementById(id)?.classList.contains('openDrawer') === true;
        const isOverlayOpen = (id, openClass) => {
            const overlay = document.getElementById(id);

            return Boolean(overlay
                && !overlay.hidden
                && overlay.classList.contains(openClass)
                && overlay.getAttribute('aria-hidden') === 'false');
        };

        // The connection strip is a desktop-chatbar surface; on mobile the
        // exclusion cascades close it via setConnectionStripOpenState(false),
        // which has no observable mobile DOM, so it is not snapshotted here.
        return {
            navOpen: isOverlayOpen('sb-mobile-nav', 'sb-nav-open'),
            chatToolsOpen: isOverlayOpen('sb-mobile-chat-tools', 'sb-chat-tools-open'),
            leftShellOpen: isDrawerOpen('left-nav-panel'),
            rightShellOpen: isDrawerOpen('user-settings-block'),
            characterPanelOpen: isDrawerOpen('right-nav-panel'),
        };
    });
}

function getDrawerBoundsSnapshot(page, drawerId) {
    return page.evaluate((id) => {
        const drawer = document.getElementById(id);

        if (!drawer) {
            return null;
        }

        return {
            isOpen: drawer.classList.contains('openDrawer'),
            isViewportBound: drawer.dataset.sbMobileViewportBound === 'true',
            top: drawer.style.top,
            bottom: drawer.style.bottom,
            height: drawer.style.height,
            maxHeight: drawer.style.maxHeight,
            boxSizing: drawer.style.boxSizing,
        };
    }, drawerId);
}

function getComposerViewportFit(page) {
    return page.evaluate(() => {
        const composer = document.getElementById('form_sheld');
        const rect = composer?.getBoundingClientRect();

        if (!rect) {
            return null;
        }

        return {
            top: rect.top,
            bottom: rect.bottom,
            viewportHeight: window.innerHeight,
        };
    });
}

function getHorizontalOverflow(page) {
    return page.evaluate(() => {
        const root = document.documentElement;

        return root.scrollWidth - root.clientWidth;
    });
}

function getIsMobileShellViewport(page) {
    return page.evaluate(() => window.SillyBunnyShell.isMobileViewport());
}

async function expectNoHorizontalOverflow(page) {
    await expect.poll(() => getHorizontalOverflow(page)).toBeLessThanOrEqual(1);
}

async function waitForNavOpenGrace(page) {
    // eslint-disable-next-line playwright/no-wait-for-timeout -- The mobile nav contract has a 450 ms open grace before cross-opening.
    await page.waitForTimeout(MOBILE_SHELL_NAV_OPEN_GRACE_MS);
}

function openLeftShell(page) {
    return page.evaluate(() => window.SillyBunnyShell.openTab('left', 'presets'));
}

async function swipeLeftDrawerDown(page) {
    await page.evaluate(() => {
        const drawer = document.getElementById('left-nav-panel');
        const header = drawer?.querySelector(':scope > .sb-shell-frame .sb-shell-header');
        const rect = header?.getBoundingClientRect();

        if (!drawer || !header || !rect) {
            throw new Error('Left drawer header is not ready for swipe-dismiss');
        }

        const touch = (clientX, clientY) => new Touch({
            identifier: 1,
            target: header,
            clientX,
            clientY,
            pageX: clientX + window.scrollX,
            pageY: clientY + window.scrollY,
            screenX: clientX,
            screenY: clientY,
        });
        const startX = Math.round(rect.left + rect.width / 2);
        const startY = Math.round(rect.top + Math.min(28, rect.height / 2));
        const endY = startY + 96;

        header.dispatchEvent(new TouchEvent('touchstart', {
            bubbles: true,
            cancelable: true,
            touches: [touch(startX, startY)],
            targetTouches: [touch(startX, startY)],
            changedTouches: [touch(startX, startY)],
        }));
        header.dispatchEvent(new TouchEvent('touchmove', {
            bubbles: true,
            cancelable: true,
            touches: [touch(startX, endY)],
            targetTouches: [touch(startX, endY)],
            changedTouches: [touch(startX, endY)],
        }));
        header.dispatchEvent(new TouchEvent('touchend', {
            bubbles: true,
            cancelable: true,
            touches: [],
            targetTouches: [],
            changedTouches: [touch(startX, endY)],
        }));
    });
}

// While any drawer or overlay is open, the mobile modal policy marks the page
// chrome (topbar included) inert, so a trusted pointer click cannot reach the
// hamburger. Synthetic .click() still runs the toggle cascade under test.
function clickHamburgerProgrammatically(page) {
    return page.evaluate(() => document.getElementById('sb-hamburger').click());
}

async function closeLeftShellThroughUi(page) {
    const closeButton = page.locator('#left-nav-panel .sb-shell-close');

    await closeButton.waitFor({ state: 'visible', timeout: 1000 }).catch(() => {});

    if (await closeButton.isVisible().catch(() => false)) {
        await closeButton.click();
        return;
    }

    // Escape routes through closeFocusedShell on the shell root keydown handler.
    await page.keyboard.press('Escape');
}

async function captureCheckpoint(page, testInfo, name) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);

    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' });
}

test.describe('mobile shell smoke at iPhone 390x844', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE_USER_AGENT,
    });

    test.beforeEach(async ({ page }) => {
        await openQuietChatForSmoke(page, { selectCharacter: false });
        await waitForAnimationFrames(page, 3);
    });

    test('left drawer open and close honor the mobile viewport bound contract', async ({ page }, testInfo) => {
        await openLeftShell(page);

        // syncMobileShellDrawerBounds binds open drawers to the visual viewport
        // with inline !important top/height and a dataset marker.
        await expect.poll(() => getDrawerBoundsSnapshot(page, 'left-nav-panel')).toMatchObject({
            isOpen: true,
            isViewportBound: true,
            bottom: 'auto',
            boxSizing: 'border-box',
        });

        await expect.poll(async () => {
            const openBounds = await getDrawerBoundsSnapshot(page, 'left-nav-panel');
            const height = Number.parseFloat(openBounds?.height ?? '');

            return {
                topIsPixels: /^\d+px$/.test(openBounds?.top ?? ''),
                heightPositive: height > 0,
                heightWithinViewport: height <= 844,
                maxHeightMatchesHeight: openBounds?.maxHeight === openBounds?.height,
            };
        }).toEqual({
            topIsPixels: true,
            heightPositive: true,
            heightWithinViewport: true,
            maxHeightMatchesHeight: true,
        });

        await captureCheckpoint(page, testInfo, 'left-drawer');

        await closeLeftShellThroughUi(page);

        // applyMobileDrawerBoundsDecision removes every bound property and
        // the dataset marker once the drawer is no longer open.
        await expect.poll(() => getDrawerBoundsSnapshot(page, 'left-nav-panel')).toEqual({
            isOpen: false,
            isViewportBound: false,
            top: '',
            bottom: '',
            height: '',
            maxHeight: '',
            boxSizing: '',
        });

        await expectNoHorizontalOverflow(page);
    });

    test('left drawer swipe-down dismisses the mobile sheet', async ({ page }) => {
        await openLeftShell(page);

        await expect.poll(() => getDrawerBoundsSnapshot(page, 'left-nav-panel')).toMatchObject({
            isOpen: true,
            isViewportBound: true,
        });

        await swipeLeftDrawerDown(page);

        await expect.poll(() => getDrawerBoundsSnapshot(page, 'left-nav-panel')).toEqual({
            isOpen: false,
            isViewportBound: false,
            top: '',
            bottom: '',
            height: '',
            maxHeight: '',
            boxSizing: '',
        });

        await expectNoHorizontalOverflow(page);
    });

    test('hamburger nav keeps hidden, aria-hidden, and inert in agreement', async ({ page }, testInfo) => {
        const getNavAgreementSnapshot = () => page.evaluate(() => {
            const overlay = document.getElementById('sb-mobile-nav');
            const button = document.getElementById('sb-hamburger');
            const content = document.getElementById('sb-mobile-nav-content');
            const contentRect = content?.getBoundingClientRect();
            const closeRect = content?.querySelector('.sb-mobile-panel-close')?.getBoundingClientRect();

            return {
                hidden: overlay?.hidden ?? null,
                ariaHidden: overlay?.getAttribute('aria-hidden') ?? null,
                inert: overlay?.inert === true,
                openClass: overlay?.classList.contains('sb-nav-open') === true,
                buttonExpanded: button?.getAttribute('aria-expanded') ?? null,
                buttonOpenClass: button?.classList.contains('is-open') === true,
                contentBottomPinned: contentRect ? Math.abs(window.innerHeight - contentRect.bottom) <= 10 : null,
                contentMaxHeight: contentRect ? contentRect.height <= Math.ceil(window.innerHeight * 0.76) + 1 : null,
                closeTargetFloor: closeRect ? Math.min(closeRect.width, closeRect.height) >= 44 : null,
                viewportHeight: window.innerHeight,
            };
        });

        await page.locator('#sb-hamburger').click();

        await expect.poll(getNavAgreementSnapshot).toEqual({
            hidden: false,
            ariaHidden: 'false',
            inert: false,
            openClass: true,
            buttonExpanded: 'true',
            buttonOpenClass: true,
            contentBottomPinned: true,
            contentMaxHeight: true,
            closeTargetFloor: true,
            viewportHeight: 844,
        });

        await captureCheckpoint(page, testInfo, 'nav-open');

        await waitForNavOpenGrace(page);

        await page.locator('#sb-hamburger').click();

        await expect.poll(getNavAgreementSnapshot).toEqual({
            hidden: true,
            ariaHidden: 'true',
            inert: true,
            openClass: false,
            buttonExpanded: 'false',
            buttonOpenClass: false,
            contentBottomPinned: false,
            contentMaxHeight: true,
            closeTargetFloor: false,
            viewportHeight: 844,
        });

        await expectNoHorizontalOverflow(page);
    });

    test('opening each overlay closes competing mobile surfaces', async ({ page }, testInfo) => {
        await openLeftShell(page);

        await expect.poll(() => getOverlayStateSnapshot(page)).toMatchObject({ leftShellOpen: true });

        // toggleMobileNav closes shells, the character panel, and chat tools.
        await clickHamburgerProgrammatically(page);

        await expect.poll(() => getOverlayStateSnapshot(page)).toEqual({
            navOpen: true,
            chatToolsOpen: false,
            leftShellOpen: false,
            rightShellOpen: false,
            characterPanelOpen: false,
        });

        await waitForNavOpenGrace(page);

        // openMobileChatTools closes the nav, both shells, and the character panel.
        await page.evaluate(() => window.SillyBunnyShell.openChatTools());

        await expect.poll(() => getOverlayStateSnapshot(page)).toEqual({
            navOpen: false,
            chatToolsOpen: true,
            leftShellOpen: false,
            rightShellOpen: false,
            characterPanelOpen: false,
        });

        await captureCheckpoint(page, testInfo, 'chat-tools');

        // toggleCharacterPanel routes through closeAllDropdowns({ except: 'characters' }).
        await page.evaluate(() => window.SillyBunnyShell.openCharacters());

        await expect.poll(() => getOverlayStateSnapshot(page)).toEqual({
            navOpen: false,
            chatToolsOpen: false,
            leftShellOpen: false,
            rightShellOpen: false,
            characterPanelOpen: true,
        });

        await expectNoHorizontalOverflow(page);
    });

    test('bottom chat overflow keeps persona and common chat actions reachable', async ({ page }) => {
        const getBottomBarSnapshot = () => page.evaluate(() => {
            const bar = document.getElementById('sb-bottom-chat-bar');
            const persona = document.getElementById('sb-persona-bubble');
            const overflow = bar?.querySelector('.sb-bottom-chat-overflow-toggle');
            const menu = document.getElementById('sb-bottom-chat-overflow-menu');
            const directAction = id => bar?.querySelector(`[data-sb-bottom-action-id="${id}"]`);
            const rectInfo = element => {
                const rect = element?.getBoundingClientRect();

                return rect
                    ? {
                        visible: rect.width > 0 && rect.height > 0,
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                    }
                    : null;
            };

            return {
                bar: rectInfo(bar),
                persona: rectInfo(persona),
                overflow: rectInfo(overflow),
                overflowExpanded: overflow?.getAttribute('aria-expanded') ?? null,
                viewFilesVisible: rectInfo(directAction('view-files'))?.visible ?? false,
                newChatVisible: rectInfo(directAction('new-chat'))?.visible ?? false,
                searchVisible: rectInfo(directAction('search-chat'))?.visible ?? false,
                massDeleteVisible: rectInfo(directAction('mass-delete'))?.visible ?? false,
                autoNameVisible: rectInfo(directAction('auto-name'))?.visible ?? false,
                renameVisible: rectInfo(directAction('rename-chat'))?.visible ?? false,
                deleteVisible: rectInfo(directAction('delete-chat'))?.visible ?? false,
                hideBottomBarVisible: rectInfo(directAction('hide-bottom-bar'))?.visible ?? false,
                menuOpen: menu ? !menu.hidden : false,
                menuItems: menu ? Array.from(menu.querySelectorAll('.sb-bottom-chat-overflow-item')).map(item => item.textContent.trim()) : [],
            };
        });

        await expect.poll(getBottomBarSnapshot).toMatchObject({
            bar: { visible: true },
            persona: { visible: true },
            overflow: { visible: true },
            overflowExpanded: 'false',
            viewFilesVisible: true,
            newChatVisible: true,
            searchVisible: true,
            massDeleteVisible: false,
            autoNameVisible: false,
            renameVisible: false,
            deleteVisible: true,
            hideBottomBarVisible: false,
            menuOpen: false,
        });

        await page.locator('.sb-bottom-chat-overflow-toggle').click();

        await expect.poll(getBottomBarSnapshot).toMatchObject({
            overflowExpanded: 'true',
            menuOpen: true,
            menuItems: [
                'Mass delete chats',
                'Ask the LLM to name this chat',
                'Rename chat',
                'Hide bottom chat bar',
            ],
        });

        await page.locator('#sb-persona-bubble').click();

        await expect.poll(getBottomBarSnapshot).toMatchObject({
            overflowExpanded: 'false',
            menuOpen: false,
        });

        const personaPickerBox = await page.locator('#sb-persona-picker').boundingBox();
        expect(personaPickerBox).not.toBeNull();
        expect(personaPickerBox.y + personaPickerBox.height).toBeLessThanOrEqual(844);

        await expectNoHorizontalOverflow(page);
    });

    test('keyboard-style viewport shrink re-syncs open drawer bounds and recovers', async ({ page }) => {
        await openLeftShell(page);

        // After a resize the inline height can be handed off to a stylesheet
        // rule driven by --sb-shell-viewport-height, so this asserts the
        // rendered geometry (the actual contract), not the inline styles.
        const getRenderedDrawerFit = () => page.evaluate(() => {
            const drawer = document.getElementById('left-nav-panel');
            const rect = drawer.getBoundingClientRect();
            const probe = document.createElement('div');

            probe.style.cssText = 'position:fixed;left:-9999px;bottom:0;width:0;height:0;padding-bottom:var(--sb-mobile-safe-area-bottom,0px);pointer-events:none;visibility:hidden;contain:layout style size;';
            document.body.appendChild(probe);
            const safeAreaBottom = Number.parseFloat(window.getComputedStyle(probe).paddingBottom) || 0;
            probe.remove();

            return {
                isOpen: drawer.classList.contains('openDrawer'),
                isViewportBound: drawer.dataset.sbMobileViewportBound === 'true',
                top: Math.round(rect.top),
                bottom: Math.round(rect.bottom),
                expectedBottom: Math.round(window.innerHeight - safeAreaBottom),
                viewportHeight: window.innerHeight,
            };
        });

        await expect.poll(async () => {
            const fit = await getRenderedDrawerFit();

            return fit.isViewportBound && fit.top > 0 && Math.abs(fit.bottom - fit.expectedBottom) <= 2;
        }).toBe(true);

        // Viewport shrink stands in for the on-screen keyboard: the resize
        // listener re-runs syncMobileViewportState and rebinds open drawers.
        await page.setViewportSize({ width: 390, height: 500 });

        await expect.poll(async () => {
            const fit = await getRenderedDrawerFit();

            return fit.isViewportBound && fit.top > 0 && Math.abs(fit.bottom - fit.expectedBottom) <= 2;
        }).toBe(true);

        await page.setViewportSize({ width: 390, height: 844 });

        await expect.poll(async () => {
            const fit = await getRenderedDrawerFit();

            return fit.isViewportBound && fit.top > 0 && Math.abs(fit.bottom - fit.expectedBottom) <= 2;
        }).toBe(true);

        await closeLeftShellThroughUi(page);

        await expect.poll(async () => {
            const bounds = await getDrawerBoundsSnapshot(page, 'left-nav-panel');

            return bounds?.isOpen === false && bounds?.isViewportBound === false;
        }).toBe(true);

        await expectNoHorizontalOverflow(page);
    });

    test('composer stays on screen through keyboard-style viewport shrink', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 390, height: 500 });

        await expect.poll(async () => {
            const fit = await getComposerViewportFit(page);

            return fit !== null && fit.bottom <= fit.viewportHeight + 1;
        }).toBe(true);

        await expect(page.locator('#send_textarea')).toBeVisible();

        await captureCheckpoint(page, testInfo, 'composer-short-viewport');

        await page.setViewportSize({ width: 390, height: 844 });

        await expect.poll(async () => {
            const fit = await getComposerViewportFit(page);

            return fit !== null && fit.bottom <= fit.viewportHeight + 1;
        }).toBe(true);

        await expectNoHorizontalOverflow(page);
    });
});

test.describe('mobile shell smoke at narrow 320x568', () => {
    test.use({
        viewport: { width: 320, height: 568 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE_USER_AGENT,
    });

    test('composer fits and the send target keeps its mobile tap floor', async ({ page }) => {
        await openQuietChatForSmoke(page, { selectCharacter: false });

        // Compact mode and connection state come from the linked user profile;
        // normalize both so this measures the stylesheet contract, not the
        // profile. The displayNone class on #send_but is only a connection
        // visibility gate (RossAscends-mods.js), not a sizing rule.
        await page.evaluate(() => {
            document.documentElement.setAttribute('data-sb-compact-mode', 'false');
            document.getElementById('send_but')?.classList.remove('displayNone');
        });
        await waitForAnimationFrames(page, 2);

        const sendButtonBox = await page.locator('#send_but').boundingBox();

        expect(sendButtonBox).not.toBeNull();
        expect(Math.min(sendButtonBox.width, sendButtonBox.height)).toBeGreaterThanOrEqual(44);

        const composerBox = await page.locator('#form_sheld').boundingBox();

        expect(composerBox).not.toBeNull();
        expect(composerBox.x).toBeGreaterThanOrEqual(-1);
        expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(321);

        await expectNoHorizontalOverflow(page);
    });
});

test.describe('mobile shell smoke at tablet 768x1024', () => {
    test.use({
        viewport: { width: 768, height: 1024 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPAD_USER_AGENT,
    });

    test('mobile shell stays active at the 768px boundary', async ({ page }) => {
        await openQuietChatForSmoke(page, { selectCharacter: false });

        await expect.poll(() => getIsMobileShellViewport(page)).toBe(true);

        await openLeftShell(page);

        await expect.poll(() => getDrawerBoundsSnapshot(page, 'left-nav-panel')).toMatchObject({
            isOpen: true,
            isViewportBound: true,
        });

        await clickHamburgerProgrammatically(page);

        await expect.poll(() => getOverlayStateSnapshot(page)).toMatchObject({
            navOpen: true,
            leftShellOpen: false,
        });

        await expectNoHorizontalOverflow(page);
    });
});

test.describe('compact desktop smoke at 820x1180', () => {
    test.use({
        viewport: { width: 820, height: 1180 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPAD_USER_AGENT,
    });

    test('mobile chrome stays dormant in the 769-1000px band', async ({ page }) => {
        await openQuietChatForSmoke(page, { selectCharacter: false });

        await expect.poll(() => getIsMobileShellViewport(page)).toBe(false);

        // Shells open as pinned desktop panels without the mobile bound contract.
        await openLeftShell(page);

        await expect.poll(() => getDrawerBoundsSnapshot(page, 'left-nav-panel')).toMatchObject({
            isOpen: true,
            isViewportBound: false,
        });

        // openChatTools routes to the desktop chat sidebar above 768px; the
        // mobile chat tools overlay must stay closed.
        await page.evaluate(() => window.SillyBunnyShell.openChatTools());
        await waitForAnimationFrames(page, 2);

        await expect.poll(async () => {
            const overlayState = await getOverlayStateSnapshot(page);

            return overlayState.chatToolsOpen;
        }).toBe(false);

        await expectNoHorizontalOverflow(page);
    });
});
