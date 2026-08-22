/* global document, getComputedStyle, localStorage, requestAnimationFrame, window */
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

// Mobile shell smoke pack: pins the current open/close contracts of the
// SillyBunny mobile shell (drawers, hamburger nav, chat tools, character
// panel) so the Phase 1 decomposition of sillybunny-tabs.js has a net.
// Run with: SILLYBUNNY_TEST_BASE_URL=http://127.0.0.1:<port> npx playwright test mobile-shell-smoke.e2e.js

test.describe.configure({ mode: 'serial' });

const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const VIEWPORT_SURFACE_SELECTOR = [
    '#left-nav-panel.openDrawer',
    '#right-nav-panel.openDrawer',
    '#user-settings-block.openDrawer',
    '#sb-mobile-nav.sb-nav-open',
    '#sb-mobile-chat-tools.sb-chat-tools-open',
    '#sb-universal-search.is-open .sb-universal-search-panel',
    '#sb-persona-picker',
    '.options-content',
    '#extensionsMenu',
    '.ica--tpanel.is-open',
    'dialog[open]',
    '#shadow_popup #dialogue_popup',
    '.autoComplete-wrap',
    '.ctx-menu',
].join(', ');
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

function getDocumentOverflow(page) {
    return page.evaluate(() => {
        const root = document.documentElement;

        return {
            horizontal: root.scrollWidth - root.clientWidth,
            vertical: root.scrollHeight - root.clientHeight,
        };
    });
}

function getIsMobileShellViewport(page) {
    return page.evaluate(() => window.SillyBunnyShell.isMobileViewport());
}

async function expectNoDocumentOverflow(page) {
    await expect.poll(async () => {
        const overflow = await getDocumentOverflow(page);
        const escapedSurfaces = await page.evaluate((selector) => {
            const viewport = window.visualViewport;
            const viewportBounds = {
                left: viewport?.offsetLeft ?? 0,
                top: viewport?.offsetTop ?? 0,
                right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth),
                bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
            };

            return Array.from(document.querySelectorAll(selector)).flatMap((element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                if (style.display === 'none'
                    || style.visibility === 'hidden'
                    || style.visibility === 'collapse'
                    || Number(style.opacity) === 0
                    || rect.width <= 1
                    || rect.height <= 1) {
                    return [];
                }

                const escaped = rect.left < viewportBounds.left - 1
                    || rect.top < viewportBounds.top - 1
                    || rect.right > viewportBounds.right + 1
                    || rect.bottom > viewportBounds.bottom + 1;
                return escaped ? [{
                    surface: element.id || element.className || element.tagName,
                    rect: [rect.left, rect.top, rect.right, rect.bottom],
                    viewport: Object.values(viewportBounds),
                }] : [];
            });
        }, VIEWPORT_SURFACE_SELECTOR);
        const violations = [];
        if (overflow.horizontal > 1) violations.push({ documentHorizontalOverflow: overflow.horizontal });
        if (overflow.vertical > 1) violations.push({ documentVerticalOverflow: overflow.vertical });
        violations.push(...escapedSurfaces);
        return JSON.stringify(violations);
    }).toBe('[]');
}

async function waitForNavOpenGrace(page) {
    // eslint-disable-next-line playwright/no-wait-for-timeout -- The mobile nav contract has a 450 ms open grace before cross-opening.
    await page.waitForTimeout(MOBILE_SHELL_NAV_OPEN_GRACE_MS);
}

function openLeftShell(page) {
    return page.evaluate(() => window.SillyBunnyShell.openTab('left', 'presets'));
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

    test('primary chat starts without off-canvas document overflow', async ({ page }) => {
        const overflow = await getDocumentOverflow(page);
        expect(overflow.horizontal).toBeLessThanOrEqual(1);
        expect(overflow.vertical).toBeLessThanOrEqual(1);
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

        await expectNoDocumentOverflow(page);
    });

    test('hamburger nav keeps hidden, aria-hidden, and inert in agreement', async ({ page }, testInfo) => {
        const getNavAgreementSnapshot = () => page.evaluate(() => {
            const overlay = document.getElementById('sb-mobile-nav');
            const button = document.getElementById('sb-hamburger');

            return {
                hidden: overlay?.hidden ?? null,
                ariaHidden: overlay?.getAttribute('aria-hidden') ?? null,
                inert: overlay?.inert === true,
                openClass: overlay?.classList.contains('sb-nav-open') === true,
                buttonExpanded: button?.getAttribute('aria-expanded') ?? null,
                buttonOpenClass: button?.classList.contains('is-open') === true,
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
        });

        await expectNoDocumentOverflow(page);
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

        await expectNoDocumentOverflow(page);
    });

    test('every primary chat surface stays inside the document viewport', async ({ page }) => {
        const detachedAutocompleteErrors = [];
        page.on('pageerror', error => {
            if (error.message.includes('Cannot read properties of null (reading \'getBoundingClientRect\')')) {
                detachedAutocompleteErrors.push(error.message);
            }
        });
        const checkpoint = async (label) => {
            await test.step(label, async () => {
                await waitForAnimationFrames(page, 2);
                await expectNoDocumentOverflow(page);
            });
        };
        const closeOpenShell = () => page.evaluate(() => {
            document.querySelector('.sb-shell-root.openDrawer .sb-shell-close')?.click();
        });

        for (const tabId of ['presets', 'api', 'sampling', 'advanced-formatting', 'agents']) {
            await page.evaluate(tab => window.SillyBunnyShell.openTab('left', tab), tabId);
            await checkpoint(`Workspace · ${tabId}`);
        }
        const textareaFullscreenToggle = page.locator('#left-nav-panel .ica--textarea-fullscreen-toggle').first();
        await expect(textareaFullscreenToggle).toBeVisible();
        await textareaFullscreenToggle.click();
        await expect(page.locator('dialog.popup[open] textarea.maximized_textarea')).toBeVisible();
        await checkpoint('Agents textarea · fullscreen');
        await page.keyboard.press('Escape');
        await expect(page.locator('textarea.maximized_textarea')).toHaveCount(0);
        await checkpoint('Agents textarea · restored');
        await closeOpenShell();
        await checkpoint('Workspace · closed');

        for (const tabId of ['settings', 'extensions', 'background', 'server', 'console-logs']) {
            await page.evaluate(tab => window.SillyBunnyShell.openTab('right', tab), tabId);
            await checkpoint(`Customize · ${tabId}`);
        }
        await closeOpenShell();
        await checkpoint('Customize · closed');

        for (const tabId of ['characters', 'groups', 'editor', 'world-info', 'persona', 'import']) {
            await page.evaluate(tab => window.SillyBunnyShell.openTab('characters', tab), tabId);
            await checkpoint(`Characters · ${tabId}`);
        }
        await page.evaluate(() => window.SillyBunnyShell.closeCharacters());
        await checkpoint('Characters · closed');
        await page.evaluate(async () => {
            const { AutoComplete } = await import('/scripts/autocomplete/AutoComplete.js');
            const detachedTextarea = document.createElement('textarea');
            document.body.append(detachedTextarea);
            new AutoComplete(detachedTextarea, () => false, async () => null, true);
            detachedTextarea.remove();
            window.dispatchEvent(new Event('resize'));
            await new Promise(resolve => setTimeout(resolve, 30));
        });
        expect(detachedAutocompleteErrors).toEqual([]);

        await clickHamburgerProgrammatically(page);
        await checkpoint('Mobile nav · open');
        await page.evaluate(() => document.querySelector('#sb-mobile-nav .sb-mobile-panel-close')?.click());
        await checkpoint('Mobile nav · closed');

        await page.evaluate(() => window.SillyBunnyShell.openChatTools());
        await checkpoint('Chat tools · open');
        await page.evaluate(() => document.querySelector('#sb-mobile-chat-tools .sb-mobile-panel-close')?.click());
        await checkpoint('Chat tools · closed');

        await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
        await checkpoint('Global search · open');
        await page.keyboard.press('Escape');
        await checkpoint('Global search · closed');

        await page.evaluate(() => document.getElementById('sb-persona-bubble')?.click());
        await checkpoint('Persona picker · open');
        await page.evaluate(() => document.getElementById('sb-persona-bubble')?.click());
        await checkpoint('Persona picker · closed');

        for (const buttonId of ['options_button', 'extensionsMenuButton']) {
            await page.evaluate(id => document.getElementById(id)?.click(), buttonId);
            await checkpoint(`${buttonId} · open`);
            await page.evaluate(id => document.getElementById(id)?.click(), buttonId);
            await checkpoint(`${buttonId} · closed`);
        }

        const contextMenuBounds = await page.evaluate(async () => {
            const { ContextMenu } = await import('/scripts/extensions/quick-reply/src/ui/ctx/ContextMenu.js');
            const childQuickReply = {
                icon: '',
                showLabel: true,
                label: 'A long contextual quick reply that must remain reachable',
                title: '',
                message: '',
                contextList: [],
                isHidden: false,
            };
            const set = {
                name: 'Context actions',
                qrList: [childQuickReply],
                execute() {},
            };
            const menu = new ContextMenu({
                icon: '',
                showLabel: true,
                label: 'Root',
                title: '',
                message: '',
                contextList: [{ set, isChained: false }],
            });

            menu.show({ clientX: window.innerWidth - 1, clientY: window.innerHeight / 2 });
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const rect = menu.menu.getBoundingClientRect();
            const bounds = {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
            };
            menu.hide();
            return bounds;
        });
        expect(contextMenuBounds.left).toBeGreaterThanOrEqual(4);
        expect(contextMenuBounds.top).toBeGreaterThanOrEqual(4);
        expect(contextMenuBounds.right).toBeLessThanOrEqual(contextMenuBounds.viewportWidth - 4);
        expect(contextMenuBounds.bottom).toBeLessThanOrEqual(contextMenuBounds.viewportHeight - 4);
        await checkpoint('Quick Reply context menu · closed');

        const composer = page.locator('#send_textarea');
        const originalComposerValue = await composer.inputValue();
        try {
            await composer.fill('');
            await composer.pressSequentially('/');
            const autocomplete = page.locator('.autoComplete-wrap');
            await expect(autocomplete).toBeVisible();
            const autocompleteBounds = await autocomplete.boundingBox();
            expect(autocompleteBounds).not.toBeNull();
            expect(autocompleteBounds.x).toBeGreaterThanOrEqual(-1);
            expect(autocompleteBounds.y).toBeGreaterThanOrEqual(-1);
            expect(autocompleteBounds.x + autocompleteBounds.width).toBeLessThanOrEqual(391);
            expect(autocompleteBounds.y + autocompleteBounds.height).toBeLessThanOrEqual(845);
            await checkpoint('Composer autocomplete · open');
        } finally {
            await composer.fill(originalComposerValue);
            await page.keyboard.press('Escape');
        }
        await checkpoint('Composer autocomplete · closed');

        const companionHandleStorageKey = 'ica--tracker-panel-handle-top-v2';
        const storedCompanionHandlePosition = await page.evaluate(key => localStorage.getItem(key), companionHandleStorageKey);
        try {
            for (const edge of ['right', 'left', 'top', 'bottom']) {
                await page.evaluate(async ({ key, panelEdge }) => {
                    localStorage.setItem(key, JSON.stringify({ edge: panelEdge, fraction: 0.5 }));
                    const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                    panel.openCompanionPanel();
                }, { key: companionHandleStorageKey, panelEdge: edge });
                await checkpoint(`Companion panel · ${edge} · open`);
                await page.evaluate(async () => {
                    const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                    panel.closeCompanionPanel();
                });
                await checkpoint(`Companion panel · ${edge} · closed`);
            }
        } finally {
            await page.evaluate(async ({ key, storedValue }) => {
                const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                panel.closeCompanionPanel();
                if (storedValue === null) {
                    localStorage.removeItem(key);
                } else {
                    localStorage.setItem(key, storedValue);
                }
            }, { key: companionHandleStorageKey, storedValue: storedCompanionHandlePosition });
        }

        await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            const popup = new Popup('<p>Viewport containment regression</p>', POPUP_TYPE.CONFIRM);
            window.__viewportContainmentPopup = popup;
            void popup.show();
        });
        await checkpoint('Generic popup · open');
        await page.evaluate(async () => {
            await window.__viewportContainmentPopup?.completeCancelled();
            delete window.__viewportContainmentPopup;
        });
        await checkpoint('Generic popup · closed');

        await page.evaluate(async () => {
            const { callPopup } = await import('/script.js');
            window.__viewportContainmentLegacyPopup = callPopup('<p>Legacy viewport containment regression</p>', 'confirm');
        });
        await expect(page.locator('#shadow_popup')).toBeVisible();
        const legacyPopupBounds = await page.locator('#dialogue_popup').boundingBox();
        expect(legacyPopupBounds).not.toBeNull();
        expect(legacyPopupBounds.x).toBeGreaterThanOrEqual(-1);
        expect(legacyPopupBounds.y).toBeGreaterThanOrEqual(-1);
        expect(legacyPopupBounds.x + legacyPopupBounds.width).toBeLessThanOrEqual(391);
        expect(legacyPopupBounds.y + legacyPopupBounds.height).toBeLessThanOrEqual(845);
        await checkpoint('Legacy popup · open');
        await page.locator('#dialogue_popup_cancel').click();
        await page.evaluate(async () => {
            await window.__viewportContainmentLegacyPopup;
            delete window.__viewportContainmentLegacyPopup;
        });
        await checkpoint('Legacy popup · closed');
    });

    test('nested Quick Reply menus stay reachable through viewport changes', async ({ page }) => {
        await page.evaluate(async () => {
            const { ContextMenu } = await import('/scripts/extensions/quick-reply/src/ui/ctx/ContextMenu.js');
            const leafQuickReply = {
                icon: '',
                showLabel: true,
                label: 'Unbroken_nested_action_'.repeat(24),
                title: '',
                message: '',
                contextList: [],
                isHidden: false,
            };
            const nestedSet = {
                name: 'Nested actions',
                qrList: [leafQuickReply],
                execute() {},
            };
            const parentQuickReply = {
                icon: '',
                showLabel: true,
                label: 'Nested actions',
                title: '',
                message: '',
                contextList: [{ set: nestedSet, isChained: false }],
                isHidden: false,
            };
            const fillerQuickReplies = Array.from({ length: 30 }, (_, index) => ({
                icon: '',
                showLabel: true,
                label: `Filler action ${index + 1}`,
                title: '',
                message: '',
                contextList: [],
                isHidden: false,
            }));
            const rootSet = {
                name: 'Root actions',
                qrList: [parentQuickReply, ...fillerQuickReplies],
                execute() {},
            };
            const menu = new ContextMenu({
                icon: '',
                showLabel: true,
                label: 'Root',
                title: '',
                message: '',
                contextList: [{ set: rootSet, isChained: false }],
            });

            menu.show({ clientX: window.innerWidth - 1, clientY: window.innerHeight - 1 });
            window.__viewportContainmentContextMenu = menu;
        });

        const parentItem = page.locator('.ctx-menu:not(.ctx-sub-menu) > .ctx-has-children').first();
        await parentItem.locator('.ctx-expander').evaluate(element => element.click());
        await expect(page.locator('.ctx-sub-menu')).toBeVisible();

        const expectMenusContained = async () => {
            await waitForAnimationFrames(page, 2);
            const bounds = await page.locator('.ctx-menu').evaluateAll(menus => menus.map(menu => {
                const rect = menu.getBoundingClientRect();
                const hitTarget = document.elementFromPoint(
                    Math.min(window.innerWidth - 1, Math.max(0, rect.left + (rect.width / 2))),
                    Math.min(window.innerHeight - 1, Math.max(0, rect.top + (rect.height / 2))),
                );
                return {
                    className: menu.className,
                    style: menu.getAttribute('style'),
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                    viewportWidth: window.innerWidth,
                    viewportHeight: window.innerHeight,
                    visualViewportWidth: window.visualViewport?.width ?? null,
                    hitTestVisible: menu.classList.contains('ctx-sub-menu')
                        ? Boolean(hitTarget && menu.contains(hitTarget))
                        : Boolean(hitTarget?.closest('.ctx-menu')),
                };
            }));

            expect(bounds.length).toBeGreaterThan(1);
            for (const rect of bounds) {
                const diagnostic = JSON.stringify(rect);
                expect(rect.left, diagnostic).toBeGreaterThanOrEqual(4);
                expect(rect.top, diagnostic).toBeGreaterThanOrEqual(4);
                expect(rect.right, diagnostic).toBeLessThanOrEqual(rect.viewportWidth - 4);
                expect(rect.bottom, diagnostic).toBeLessThanOrEqual(rect.viewportHeight - 4);
                expect(rect.hitTestVisible, diagnostic).toBe(true);
            }
            await expectNoDocumentOverflow(page);
        };

        try {
            await test.step('initial tall menu and nested submenu', async () => {
                await expectMenusContained();
                await page.locator('.ctx-sub-menu .ctx-item').first().hover();
                await expect(page.locator('.ctx-sub-menu')).toBeVisible();
            });
            await test.step('visual viewport scroll repositions open menus', async () => {
                const submenuPlacementCount = await page.evaluate(() => {
                    const rootMenu = window.__viewportContainmentContextMenu;
                    const subMenu = rootMenu.itemList.find(item => item.subMenu)?.subMenu;
                    const originalPlace = subMenu.place.bind(subMenu);
                    let placementCount = 0;
                    subMenu.place = () => {
                        placementCount += 1;
                        return originalPlace();
                    };
                    document.querySelector('.ctx-menu:not(.ctx-sub-menu)').style.left = '2000px';
                    window.visualViewport?.dispatchEvent(new window.Event('scroll'));
                    return placementCount;
                });
                expect(submenuPlacementCount).toBeGreaterThan(0);
                await expectMenusContained();
            });
            await test.step('resize viewport', () => page.setViewportSize({ width: 320, height: 568 }));
            await test.step('keep nested submenu open', async () => {
                await expect(page.locator('.ctx-sub-menu')).toBeVisible();
            });
            await test.step('assert resized menu containment', () => expectMenusContained());
        } finally {
            await page.evaluate(() => {
                window.__viewportContainmentContextMenu?.hide();
                delete window.__viewportContainmentContextMenu;
            });
        }
        await expect(page.locator('.ctx-menu')).toHaveCount(0);
    });

    test('keyboard-style viewport shrink re-syncs open drawer bounds and recovers', async ({ page }) => {
        await openLeftShell(page);

        // After a resize the inline height can be handed off to a stylesheet
        // rule driven by --sb-shell-viewport-height, so this asserts the
        // rendered geometry (the actual contract), not the inline styles.
        const getRenderedDrawerFit = () => page.evaluate(() => {
            const drawer = document.getElementById('left-nav-panel');
            const rect = drawer.getBoundingClientRect();

            return {
                isOpen: drawer.classList.contains('openDrawer'),
                isViewportBound: drawer.dataset.sbMobileViewportBound === 'true',
                top: Math.round(rect.top),
                bottom: Math.round(rect.bottom),
                viewportHeight: window.innerHeight,
            };
        });

        await expect.poll(async () => {
            const fit = await getRenderedDrawerFit();

            return fit.isViewportBound && fit.top > 0 && Math.abs(fit.bottom - 844) <= 2;
        }).toBe(true);

        // Viewport shrink stands in for the on-screen keyboard: the resize
        // listener re-runs syncMobileViewportState and rebinds open drawers.
        await page.setViewportSize({ width: 390, height: 500 });

        await expect.poll(async () => {
            const fit = await getRenderedDrawerFit();

            return fit.isViewportBound && fit.top > 0 && Math.abs(fit.bottom - 500) <= 2;
        }).toBe(true);

        await page.setViewportSize({ width: 390, height: 844 });

        await expect.poll(async () => {
            const fit = await getRenderedDrawerFit();

            return fit.isViewportBound && fit.top > 0 && Math.abs(fit.bottom - 844) <= 2;
        }).toBe(true);

        await closeLeftShellThroughUi(page);

        await expect.poll(async () => {
            const bounds = await getDrawerBoundsSnapshot(page, 'left-nav-panel');

            return bounds?.isOpen === false && bounds?.isViewportBound === false;
        }).toBe(true);

        await expectNoDocumentOverflow(page);
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

        await expectNoDocumentOverflow(page);
    });
});

test.describe('mobile shell smoke at narrow 320x568', () => {
    test.use({
        viewport: { width: 320, height: 568 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE_USER_AGENT,
    });

    test('composer fits and the send target keeps its current floor', async ({ page }) => {
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

        // Ratchet floor: today's composer renders the send target at
        // --sb-composer-action-size (26px tall at this width). The mobile UX
        // redesign raises this floor to 44px; until then this only guards
        // against shrinking below the current shipped size.
        expect(sendButtonBox).not.toBeNull();
        expect(Math.min(sendButtonBox.width, sendButtonBox.height)).toBeGreaterThanOrEqual(24);

        const composerBox = await page.locator('#form_sheld').boundingBox();

        expect(composerBox).not.toBeNull();
        expect(composerBox.x).toBeGreaterThanOrEqual(-1);
        expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(321);

        await expectNoDocumentOverflow(page);
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

        await expectNoDocumentOverflow(page);
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

        await expectNoDocumentOverflow(page);
    });
});

test.describe('desktop MovingUI containment at 1264x800', () => {
    test.use({ viewport: { width: 1264, height: 800 } });

    test('clamps an active panel drag at every viewport edge', async ({ page }) => {
        await openQuietChatForSmoke(page, { selectCharacter: false });
        await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'presets'));
        await waitForAnimationFrames(page, 2);

        const original = await page.evaluate(async () => {
            const powerUserModule = await import('/scripts/power-user.js');
            const { dragElement } = await import('/scripts/RossAscends-mods.js');
            const leftPanel = document.getElementById('left-nav-panel');
            const rightPanel = document.getElementById('right-nav-panel');
            const snapshot = {
                movingUI: powerUserModule.power_user.movingUI,
                movingUIState: powerUserModule.power_user.movingUIState,
                leftStyle: leftPanel.style.cssText,
                rightStyle: rightPanel.style.cssText,
                hadMovingUIClass: document.body.classList.contains('movingUI'),
            };

            powerUserModule.power_user.movingUI = true;
            powerUserModule.power_user.movingUIState = {};
            document.body.classList.add('movingUI');
            leftPanel.style.setProperty('position', 'fixed', 'important');
            leftPanel.style.setProperty('inset', 'auto', 'important');
            leftPanel.style.setProperty('left', '100px', 'important');
            leftPanel.style.setProperty('top', '100px', 'important');
            leftPanel.style.setProperty('width', '400px', 'important');
            leftPanel.style.setProperty('height', '500px', 'important');
            dragElement(window.$(leftPanel));
            return snapshot;
        });

        const dragBeyond = async (targetX, targetY) => {
            const header = page.locator('#left-nav-panelheader').first();
            const box = await header.boundingBox();
            expect(box).not.toBeNull();
            await page.mouse.move(box.x + (box.width / 2), box.y + (box.height / 2));
            await page.mouse.down();
            await page.mouse.move(targetX, targetY, { steps: 2 });
            await page.mouse.up();
            await waitForAnimationFrames(page, 2);
        };
        const getBounds = () => page.evaluate(() => {
            const rect = document.getElementById('left-nav-panel').getBoundingClientRect();
            return {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                rootScrollWidth: document.documentElement.scrollWidth,
                rootScrollHeight: document.documentElement.scrollHeight,
            };
        });
        const expectContained = (bounds) => {
            expect(bounds.left).toBeGreaterThanOrEqual(-1);
            expect(bounds.top).toBeGreaterThanOrEqual(-1);
            expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth + 1);
            expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight + 1);
            expect(bounds.rootScrollWidth).toBe(bounds.viewportWidth);
            expect(bounds.rootScrollHeight).toBe(bounds.viewportHeight);
        };

        try {
            await dragBeyond(2000, 1600);
            expectContained(await getBounds());
            await dragBeyond(-800, -600);
            expectContained(await getBounds());
        } finally {
            await page.evaluate(async (snapshot) => {
                const module = await import('/scripts/power-user.js');
                const leftPanel = document.getElementById('left-nav-panel');
                const rightPanel = document.getElementById('right-nav-panel');
                module.power_user.movingUI = snapshot.movingUI;
                module.power_user.movingUIState = snapshot.movingUIState;
                document.body.classList.toggle('movingUI', snapshot.hadMovingUIClass);
                leftPanel.style.cssText = snapshot.leftStyle;
                rightPanel.style.cssText = snapshot.rightStyle;
                document.querySelector('#left-nav-panel .sb-shell-close')?.click();
            }, original);
        }
    });

    test('contains corrupt persisted panel geometry before it can enlarge the document', async ({ page }) => {
        await openQuietChatForSmoke(page, { selectCharacter: false });
        await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'presets'));
        await waitForAnimationFrames(page, 2);

        const snapshot = await page.evaluate(async () => {
            const module = await import('/scripts/power-user.js');
            const leftPanel = document.getElementById('left-nav-panel');
            const rightPanel = document.getElementById('right-nav-panel');
            const warning = document.getElementById('movingUIOffscreenWarning');
            const original = {
                movingUI: module.power_user.movingUI,
                movingUIState: module.power_user.movingUIState,
                leftStyle: leftPanel.style.cssText,
                rightStyle: rightPanel.style.cssText,
                warningClass: warning?.className ?? '',
            };

            try {
                module.power_user.movingUI = true;
                module.power_user.movingUIState = {
                    'nav-panel-shared-size': {
                        position: 'fixed',
                        width: 600,
                        height: 500,
                        left: 1800,
                        top: 100,
                        right: -1136,
                        bottom: 200,
                    },
                };

                module.loadMovingUIState();
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

                const rect = leftPanel.getBoundingClientRect();
                return {
                    viewportWidth: window.innerWidth,
                    rootScrollWidth: document.documentElement.scrollWidth,
                    rect: {
                        left: rect.left,
                        right: rect.right,
                        width: rect.width,
                    },
                    state: { ...module.power_user.movingUIState['nav-panel-shared-size'] },
                    warningVisible: !warning?.classList.contains('displayNone'),
                };
            } finally {
                module.power_user.movingUI = original.movingUI;
                module.power_user.movingUIState = original.movingUIState;
                leftPanel.style.cssText = original.leftStyle;
                rightPanel.style.cssText = original.rightStyle;
                if (warning) {
                    warning.className = original.warningClass;
                }
                document.querySelector('#left-nav-panel .sb-shell-close')?.click();
            }
        });

        expect(snapshot.rootScrollWidth).toBe(snapshot.viewportWidth);
        expect(snapshot.rect.left).toBeGreaterThanOrEqual(-1);
        expect(snapshot.rect.right).toBeLessThanOrEqual(snapshot.viewportWidth + 1);
        expect(snapshot.state.left).toBeGreaterThanOrEqual(0);
        expect(snapshot.state.left + snapshot.state.width).toBe(snapshot.viewportWidth);
        expect(snapshot.state.right).toBe(0);
        expect(snapshot.warningVisible).toBe(false);
        await expectNoDocumentOverflow(page);
    });
});
