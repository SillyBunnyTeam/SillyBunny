import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.beforeEach(async ({ page }) => { await protectMaintainerServer(page); });

// Mobile shell smoke pack: pins the open/close contracts of the SillyBunny
// mobile shell (settings page, section navigation, chat tools, character
// panel) so shell refactors have a net.
// Run with: SILLYBUNNY_TEST_BASE_URL=http://127.0.0.1:<port> npx playwright test mobile-shell-smoke.e2e.js

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
// Each case boots the whole app, which can use most of the default 30 s when
// several workers share one server.
test.describe.configure({ timeout: 60_000 });

const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const VIEWPORT_SURFACE_SELECTOR = [
    '#sb-settings-page:not([hidden])',
    // On phones only one pane of the settings page is on screen at a time.
    '#sb-settings-page:not([hidden]):not(.sb-settings-page--content) #sb-settings-sidebar',
    '#sb-settings-page.sb-settings-page--content:not([hidden]) #sb-settings-content',
    '#sb-settings-page.sb-settings-page--content:not([hidden]) .sb-settings-active-root',
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

// POST endpoints that only read. Any other request that is not a GET is
// answered here, so the pack never writes to the server.
const READ_ONLY_POSTS = new Set([
    '/api/avatars/get',
    '/api/backgrounds/all',
    '/api/backgrounds/folders',
    '/api/characters/all',
    '/api/characters/chats',
    '/api/characters/get',
    '/api/chats/get',
    '/api/chats/recent',
    '/api/groups/all',
    '/api/image-metadata/all',
    '/api/in-chat-agents/groups/list',
    '/api/presets/defaults',
    '/api/sd/comfy/workflows',
    '/api/secrets/read',
    '/api/server-admin/config/chat-completions/get',
    '/api/server-admin/install-type',
    '/api/stats/get',
    '/api/users/me',
]);

async function interceptWrites(page, baseURL) {
    const origin = new URL(baseURL).origin;
    let settingsVersion = Date.now();

    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());

        if (url.origin !== origin) {
            return route.abort();
        }

        if (url.pathname === '/api/settings/get') {
            // One retry: the fetch can land on a keep-alive socket the server just closed.
            const response = await route.fetch().catch(() => route.fetch());
            const data = await response.json();
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            settings.power_user.auto_connect = false;
            settings.extension_settings['quick-image-gen'] = { ...settings.extension_settings['quick-image-gen'], setupWizardSeen: true };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ json: data });
        }

        if (['GET', 'HEAD'].includes(request.method())
            || READ_ONLY_POSTS.has(url.pathname)
            || url.pathname.startsWith('/api/tokenizers/')) {
            return route.continue();
        }

        // A settings save must return a newer version, or the app shows a save error.
        if (url.pathname === '/api/settings/save') {
            return route.fulfill({ json: { result: 'ok', version: ++settingsVersion } });
        }

        // Provider lists are fetched from the internet by the server.
        return route.fulfill({ json: url.pathname.endsWith('/providers') ? [] : {} });
    });
}

// Startup notices (for example a bundled character that could not be saved)
// are transient and can sit over menus that are being hit tested.
function clearToasts(page) {
    return page.evaluate(() => window.toastr?.remove());
}

function getOverlayStateSnapshot(page) {
    return page.evaluate(() => {
        // Backend, Customize and Characters share one settings page; a section
        // is open when the page is shown and its root is the active one.
        const isSettingsSectionOpen = (rootId) => {
            const settingsPage = document.getElementById('sb-settings-page');
            const root = document.getElementById(rootId);

            return Boolean(settingsPage
                && !settingsPage.hidden
                && root?.classList.contains('sb-settings-active-root')
                && root.getAttribute('aria-hidden') === 'false');
        };
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
            leftShellOpen: isSettingsSectionOpen('left-nav-panel'),
            rightShellOpen: isSettingsSectionOpen('user-settings-block'),
            characterPanelOpen: isSettingsSectionOpen('right-nav-panel'),
        };
    });
}

function getSettingsPageFit(page) {
    return page.evaluate(() => {
        const settingsPage = document.getElementById('sb-settings-page');
        const rect = settingsPage.getBoundingClientRect();

        return {
            isOpen: !settingsPage.hidden,
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            viewportHeight: window.innerHeight,
        };
    });
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

// A plain open restores the section's saved tab (the content view on phones).
function openLeftShell(page) {
    return page.evaluate(() => window.SillyBunnyShell.openTab('left'));
}

// List/persona navigation APIs reveal mobile content; request the sidebar through its Back control.
async function openSettingsSection(page, shellKey, tabId) {
    await page.evaluate(({ shell, tab }) => window.SillyBunnyShell.openTab(shell, tab), { shell: shellKey, tab: tabId });

    const settingsPage = page.locator('#sb-settings-page');
    await expect(settingsPage).not.toHaveAttribute('hidden');
    if (await settingsPage.evaluate(element => element.classList.contains('sb-settings-page--content'))) await showSettingsSidebar(page);
    await expect(settingsPage).not.toHaveClass(/sb-settings-page--content/);
}

function getSettingsTab(page, tabId) {
    return page.locator(`#sb-settings-tab-list .sb-settings-tab[data-sb-settings-tab="${tabId}"]`);
}

// Taps a sidebar tab the way a user does, which slides in the content view.
async function showSettingsTab(page, tabId) {
    const tab = getSettingsTab(page, tabId);

    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#sb-settings-page')).toHaveClass(/sb-settings-page--content/);
}

async function showSettingsSidebar(page) {
    await page.locator('#sb-settings-back').click();
    await expect(page.locator('#sb-settings-page')).not.toHaveClass(/sb-settings-page--content/);
}

async function closeSettingsPageThroughUi(page) {
    await page.locator('#sb-settings-close').click();
    await expect(page.locator('#sb-settings-page')).toHaveAttribute('hidden', '');
}

async function captureCheckpoint(page, testInfo, name) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);

    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' });
}

test.beforeEach(async ({ page, baseURL }) => {
    await interceptWrites(page, baseURL);
});

test.describe('mobile shell smoke at iPhone 390x844', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE_USER_AGENT,
    });

    test.beforeEach(async ({ page }) => {
        await openQuietChatForSmoke(page, { selectCharacter: false });
        await clearToasts(page);
        await waitForAnimationFrames(page, 3);
    });

    test('primary chat starts without off-canvas document overflow', async ({ page }) => {
        const overflow = await getDocumentOverflow(page);
        expect(overflow.horizontal).toBeLessThanOrEqual(1);
        expect(overflow.vertical).toBeLessThanOrEqual(1);
    });

    test('settings page opens without off-canvas document overflow', async ({ page }, testInfo) => {
        await openLeftShell(page);

        const settingsPage = page.locator('#sb-settings-page');
        await expect(settingsPage).not.toHaveAttribute('hidden');

        await captureCheckpoint(page, testInfo, 'settings-page');

        const overflow = await getDocumentOverflow(page);
        expect(overflow.horizontal).toBeLessThanOrEqual(1);
        expect(overflow.vertical).toBeLessThanOrEqual(1);

        await closeSettingsPageThroughUi(page);

        await expectNoDocumentOverflow(page);
    });

    test('settings page opens in mobile sidebar view', async ({ page }, testInfo) => {
        await expect(page.locator('html')).toHaveAttribute('data-sb-mobile-ui-mode', 'mobile');

        await openSettingsSection(page, 'left', 'sampling');
        const settingsPage = page.locator('#sb-settings-page');
        const sidebar = settingsPage.locator('#sb-settings-sidebar');
        const content = settingsPage.locator('#sb-settings-content');
        const samplingTab = getSettingsTab(page, 'sampling');

        // The named tab is preselected while the sidebar fills the page.
        await expect(samplingTab).toHaveAttribute('aria-selected', 'true');
        await expect(sidebar).toBeInViewport({ ratio: 1 });
        await expect(content).not.toBeInViewport();
        await expectNoDocumentOverflow(page);

        await showSettingsTab(page, 'sampling');
        await expect(settingsPage.locator('#sb-settings-content-title')).toHaveText('Sampling');
        await expect(content).toBeInViewport({ ratio: 1 });
        await expect(sidebar).not.toBeInViewport();

        await captureCheckpoint(page, testInfo, 'settings-content-view');
        await expectNoDocumentOverflow(page);

        // Back returns to the sidebar and hands focus to the selected tab.
        await showSettingsSidebar(page);
        await expect(samplingTab).toBeFocused();
        await expect(sidebar).toBeInViewport({ ratio: 1 });

        await showSettingsTab(page, 'sampling');
        await closeSettingsPageThroughUi(page);

        await expectNoDocumentOverflow(page);
    });

    test('chat chip sheet opens, closes on Escape, and stays inside the viewport', async ({ page }, testInfo) => {
        const chip = page.locator('#sb-bottom-chat-bar .sb-bottom-chat-chip');
        await expect(chip).toBeVisible();
        await chip.click();
        const sheet = page.locator('#sb-bottom-chat-sheet');
        await expect(sheet).toBeVisible();
        await expect(chip).toHaveAttribute('aria-expanded', 'true');
        await expect(sheet.locator('#sb-bottom-chat-select')).toBeAttached();
        await captureCheckpoint(page, testInfo, 'chat-sheet-open');
        await expectNoDocumentOverflow(page);
        await page.keyboard.press('Escape');
        await expect(sheet).toBeHidden();
        await expect(chip).toHaveAttribute('aria-expanded', 'false');
        await expect(chip).toBeFocused();
    });

    test('opening each overlay closes competing mobile surfaces', async ({ page }, testInfo) => {
        await openLeftShell(page);

        await expect.poll(() => getOverlayStateSnapshot(page)).toEqual({
            navOpen: false,
            chatToolsOpen: false,
            leftShellOpen: true,
            rightShellOpen: false,
            characterPanelOpen: false,
        });

        // openMobileChatTools closes the nav and the settings page.
        await page.evaluate(() => window.SillyBunnyShell.openChatTools());

        await expect.poll(() => getOverlayStateSnapshot(page)).toEqual({
            navOpen: false,
            chatToolsOpen: true,
            leftShellOpen: false,
            rightShellOpen: false,
            characterPanelOpen: false,
        });

        await captureCheckpoint(page, testInfo, 'chat-tools');

        // toggleCharacterPanel opens Characters in the settings page and
        // closes the competing mobile surfaces first.
        await page.evaluate(() => window.SillyBunnyShell.openCharacters());

        await expect.poll(() => getOverlayStateSnapshot(page)).toEqual({
            navOpen: false,
            chatToolsOpen: false,
            leftShellOpen: false,
            rightShellOpen: false,
            characterPanelOpen: true,
        });

        // Switching sections leaves exactly one active root.
        await page.evaluate(() => window.SillyBunnyShell.openTab('right'));

        await expect.poll(() => getOverlayStateSnapshot(page)).toEqual({
            navOpen: false,
            chatToolsOpen: false,
            leftShellOpen: false,
            rightShellOpen: true,
            characterPanelOpen: false,
        });

        await expectNoDocumentOverflow(page);
    });

    test('chat tools close on Escape and hand focus back', async ({ page }) => {
        const composer = page.locator('#send_textarea');

        await composer.focus();
        await page.evaluate(() => window.SillyBunnyShell.openChatTools());
        await expect.poll(() => getOverlayStateSnapshot(page)).toMatchObject({ chatToolsOpen: true });
        // Opening moves focus into the sheet, so Escape reaches its handler.
        await expect(page.locator('#sb-mobile-chat-tools-panel')).toBeFocused();

        await page.keyboard.press('Escape');

        await expect.poll(() => getOverlayStateSnapshot(page)).toEqual({
            navOpen: false,
            chatToolsOpen: false,
            leftShellOpen: false,
            rightShellOpen: false,
            characterPanelOpen: false,
        });
        await expect(page.locator('#sb-settings-page')).toHaveAttribute('hidden', '');
        await expect(composer).toBeFocused();
        await expectNoDocumentOverflow(page);
    });

    test('every primary chat surface stays inside the document viewport', async ({ page }) => {
        test.setTimeout(120_000);

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
        const settingsPage = page.locator('#sb-settings-page');
        const visitSection = async (name, shellKey, tabIds) => {
            await openSettingsSection(page, shellKey, tabIds[0]);
            await checkpoint(`${name} · sidebar`);
            for (const tabId of tabIds) {
                await showSettingsTab(page, tabId);
                await checkpoint(`${name} · ${tabId}`);
                await showSettingsSidebar(page);
            }
        };

        await visitSection('Backend', 'left', ['connections', 'sampling', 'prompting', 'editor', 'context', 'agents']);
        await showSettingsTab(page, 'agents');
        const textareaFullscreenToggle = page.locator('#left-nav-panel .ica--textarea-fullscreen-toggle').first();
        await expect(textareaFullscreenToggle).toBeVisible();
        await textareaFullscreenToggle.click();
        await expect(page.locator('dialog.popup[open] textarea.maximized_textarea')).toBeVisible();
        await checkpoint('Agents textarea · fullscreen');
        await page.keyboard.press('Escape');
        await expect(page.locator('textarea.maximized_textarea')).toHaveCount(0);
        await checkpoint('Agents textarea · restored');
        await closeSettingsPageThroughUi(page);
        await checkpoint('Backend · closed');

        await visitSection('Customize', 'right', ['appearance', 'extensions', 'interface', 'messages', 'data-security', 'logs']);
        await page.keyboard.press('Escape');
        await expect(settingsPage).toHaveAttribute('hidden', '');
        await checkpoint('Customize · closed');

        await visitSection('Characters', 'characters', ['characters', 'groups', 'editor', 'world-info', 'persona', 'import']);
        await page.evaluate(() => window.SillyBunnyShell.closeCharacters());
        await expect(settingsPage).toHaveAttribute('hidden', '');
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

        await page.evaluate(() => window.SillyBunnyShell.openChatTools());
        await checkpoint('Chat tools · open');
        await page.locator('#sb-mobile-chat-close').click();
        await expect.poll(() => getOverlayStateSnapshot(page)).toMatchObject({ chatToolsOpen: false });
        await checkpoint('Chat tools · closed');

        await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
        await checkpoint('Global search · open');
        await page.keyboard.press('Escape');
        await expect(page.locator('#sb-universal-search')).not.toHaveClass(/\bis-open\b/);
        await checkpoint('Global search · closed');
        await expect(settingsPage).toHaveAttribute('hidden', '');

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
        const autocomplete = page.locator('.autoComplete-wrap');
        const originalComposerValue = await composer.inputValue();
        try {
            await composer.fill('');
            await composer.pressSequentially('/');
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
        }
        await expect(autocomplete).toBeHidden();
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
            await clearToasts(page);
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

    test('keyboard-style viewport shrink re-syncs settings page bounds and recovers', async ({ page }) => {
        await openLeftShell(page);

        // The page sits below the top bar and takes its height from the shell
        // viewport, so its bottom edge must follow a viewport shrink (standing
        // in for the on-screen keyboard) and come back on restore.
        const expectPageFit = (viewportHeight) => expect.poll(async () => {
            const fit = await getSettingsPageFit(page);

            return fit.isOpen && fit.top > 0 && Math.abs(fit.bottom - viewportHeight) <= 2;
        }).toBe(true);

        await expectPageFit(844);

        await page.setViewportSize({ width: 390, height: 500 });

        await expectPageFit(500);
        await expect(page.locator('#sb-settings-close')).toBeInViewport({ ratio: 1 });
        await expectNoDocumentOverflow(page);

        await page.setViewportSize({ width: 390, height: 844 });

        await expectPageFit(844);

        await closeSettingsPageThroughUi(page);
        await expect(page.locator('html')).not.toHaveAttribute('data-sb-settings-open');

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

        // The phone layout applies: one pane at a time, the saved tab in the
        // content view, and a back button to the sidebar.
        await openLeftShell(page);

        const settingsPage = page.locator('#sb-settings-page');
        await expect(settingsPage).not.toHaveAttribute('hidden');
        await expect(settingsPage).toHaveClass(/sb-settings-page--content/);
        await expect(page.locator('#sb-settings-back')).toBeVisible();
        await expect(page.locator('#sb-settings-content')).toBeInViewport({ ratio: 1 });
        await expect(page.locator('#sb-settings-sidebar')).not.toBeInViewport();

        await page.evaluate(() => window.SillyBunnyShell.openChatTools());

        await expect.poll(() => getOverlayStateSnapshot(page)).toMatchObject({
            chatToolsOpen: true,
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

        // The settings page opens in its desktop layout: sidebar and content
        // side by side, no content-view switch and no back button.
        await openLeftShell(page);

        const settingsPage = page.locator('#sb-settings-page');
        await expect(settingsPage).not.toHaveAttribute('hidden');
        await expect(settingsPage).not.toHaveClass(/sb-settings-page--content/);
        await expect(page.locator('#sb-settings-back')).toBeHidden();
        await expect(page.locator('#sb-settings-sidebar')).toBeInViewport({ ratio: 1 });
        await expect(page.locator('#sb-settings-content')).toBeInViewport({ ratio: 1 });

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

        // Backend, Customize and Characters live in the settings page and no
        // longer drag; Author's Note is still a floating MovingUI panel.
        const original = await page.evaluate(async () => {
            const powerUserModule = await import('/scripts/power-user.js');
            const { dragElement } = await import('/scripts/RossAscends-mods.js');
            const panel = document.getElementById('floatingPrompt');
            const snapshot = {
                movingUI: powerUserModule.power_user.movingUI,
                movingUIState: powerUserModule.power_user.movingUIState,
                panelStyle: panel.style.cssText,
                hadMovingUIClass: document.body.classList.contains('movingUI'),
            };

            powerUserModule.power_user.movingUI = true;
            powerUserModule.power_user.movingUIState = {};
            document.body.classList.add('movingUI');
            panel.style.setProperty('display', 'flex', 'important');
            panel.style.setProperty('position', 'fixed', 'important');
            panel.style.setProperty('inset', 'auto', 'important');
            panel.style.setProperty('left', '100px', 'important');
            panel.style.setProperty('top', '100px', 'important');
            panel.style.setProperty('width', '400px', 'important');
            panel.style.setProperty('height', '500px', 'important');
            dragElement(window.$(panel));
            return snapshot;
        });

        const dragBeyond = async (targetX, targetY) => {
            const header = page.locator('#floatingPromptheader');
            const box = await header.boundingBox();
            expect(box).not.toBeNull();
            await page.mouse.move(box.x + (box.width / 2), box.y + (box.height / 2));
            await page.mouse.down();
            await page.mouse.move(targetX, targetY, { steps: 2 });
            await page.mouse.up();
            await waitForAnimationFrames(page, 2);
        };
        const getBounds = () => page.evaluate(() => {
            const rect = document.getElementById('floatingPrompt').getBoundingClientRect();
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
            // Each drag must end on the far edges, or the clamp never ran.
            await dragBeyond(2000, 1600);
            const bottomRight = await getBounds();
            expectContained(bottomRight);
            expect(bottomRight.right).toBeGreaterThanOrEqual(bottomRight.viewportWidth - 2);
            expect(bottomRight.bottom).toBeGreaterThanOrEqual(bottomRight.viewportHeight - 2);
            await dragBeyond(-800, -600);
            const topLeft = await getBounds();
            expectContained(topLeft);
            expect(topLeft.left).toBeLessThanOrEqual(1);
            expect(topLeft.top).toBeLessThanOrEqual(1);
        } finally {
            await page.evaluate(async (snapshot) => {
                const module = await import('/scripts/power-user.js');
                module.power_user.movingUI = snapshot.movingUI;
                module.power_user.movingUIState = snapshot.movingUIState;
                document.body.classList.toggle('movingUI', snapshot.hadMovingUIClass);
                document.getElementById('floatingPrompt').style.cssText = snapshot.panelStyle;
            }, original);
        }
    });

    test('contains corrupt persisted panel geometry before it can enlarge the document', async ({ page }) => {
        await openQuietChatForSmoke(page, { selectCharacter: false });
        await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'prompting'));
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
                document.getElementById('sb-settings-close')?.click();
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

test.describe('desktop Escape at 1264x800', () => {
    test.use({ viewport: { width: 1264, height: 800 } });

    test('Escape closes one surface at a time, including floating portraits', async ({ page }) => {
        await openQuietChatForSmoke(page, { selectCharacter: false });
        await clearToasts(page);
        const settingsPage = page.locator('#sb-settings-page');
        const search = page.locator('#sb-universal-search');

        // Leaving Characters on World Info keeps #WorldInfo laid out in the closed page.
        await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'world-info'));
        await expect(settingsPage).not.toHaveAttribute('hidden');

        // Built the way the app builds a zoomed portrait: a draggable appended to the body.
        await page.evaluate(() => {
            const $ = window.jQuery;
            const portrait = $($('#zoomed_avatar_template').html());
            portrait.attr({ id: 'zoomFor_smoke', forChar: 'smoke' }).addClass('draggable');
            $('body').append(portrait);
            portrait.css('display', 'flex');
        });
        const portrait = page.locator('#zoomFor_smoke');
        const chatSidebar = page.locator('#movingDivs > #sb-chat-sidebar.draggable');

        // The open page hides the portrait, so Escape from outside the page leaves it alone.
        await page.evaluate(() => document.activeElement?.blur());
        await page.keyboard.press('Escape');
        await expect(portrait).toBeAttached();

        // Escape inside the page closes only the page, not Author's Note floating above it.
        const authorsNote = page.locator('#floatingPrompt');
        await page.evaluate(() => window.jQuery('#floatingPrompt').css({ display: 'flex', opacity: 1 }));
        await page.locator('#sb-settings-close').focus();
        await page.keyboard.press('Escape');
        await expect(settingsPage).toHaveAttribute('hidden', '');
        await expect(authorsNote).toBeVisible();
        await page.evaluate(() => window.jQuery('#floatingPrompt').hide());

        expect(await page.evaluate(() => window.jQuery('#WorldInfo').is(':visible'))).toBe(true);
        await expect(portrait).toBeVisible();
        await expect(chatSidebar).toBeAttached();
        await expect(chatSidebar).toBeHidden();

        // Global search marks its Escape as used, so that press leaves the portrait open.
        await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
        await expect(search).toHaveClass(/\bis-open\b/);
        await page.keyboard.press('Escape');
        await expect(search).not.toHaveClass(/\bis-open\b/);
        await expect(portrait).toBeVisible();

        await page.keyboard.press('Escape');

        await expect(portrait).toHaveCount(0);
        await expect(chatSidebar).toBeAttached();
        await expect(settingsPage).toHaveAttribute('hidden', '');
    });
});

test.describe('mobile chat tools with a chat at iPhone 390x844', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE_USER_AGENT,
    });

    test('Escape clears the search, then closes the chat files list, then the sheet', async ({ page }) => {
        await openQuietChatForSmoke(page);
        await clearToasts(page);
        const search = page.locator('#sb-mobile-chat-search');
        const chatFilesButton = page.locator('#sb-mobile-chat-tools-panel .sb-mobile-chat-actions button[title="View chat files"]');
        const chatFiles = page.locator('#shadow_select_chat_popup');
        const authorsNote = page.locator('#floatingPrompt');

        await page.evaluate(() => window.SillyBunnyShell.openChatTools());
        await expect.poll(() => getOverlayStateSnapshot(page)).toMatchObject({ chatToolsOpen: true });

        // A search with text clears first and keeps the sheet open.
        await search.fill('Seraphina');
        await page.keyboard.press('Escape');
        await expect(search).toHaveValue('');
        await expect.poll(() => getOverlayStateSnapshot(page)).toMatchObject({ chatToolsOpen: true });

        // The chat files list opens above the sheet; its Escape closes only the list.
        await chatFilesButton.click();
        await expect(chatFiles).toBeVisible();
        await chatFilesButton.focus();
        await page.keyboard.press('Escape');
        await expect(chatFiles).toBeHidden();
        await expect.poll(() => getOverlayStateSnapshot(page)).toMatchObject({ chatToolsOpen: true });

        // The sheet's own Escape stops there, so Author's Note behind it stays open.
        await page.evaluate(() => window.jQuery('#floatingPrompt').css({ display: 'flex', opacity: 1 }));
        await page.locator('#sb-mobile-chat-tools-panel').focus();
        await page.keyboard.press('Escape');
        await expect.poll(() => getOverlayStateSnapshot(page)).toMatchObject({ chatToolsOpen: false });
        await expect(authorsNote).toBeVisible();
        await expect(page.locator('#sb-settings-page')).toHaveAttribute('hidden', '');
        await page.evaluate(() => window.jQuery('#floatingPrompt').hide());
    });
});
