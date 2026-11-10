import { expect, test } from '@playwright/test';
import { dismissOpenDialogIfPresent, openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

// Regression pack for third-party top-bar buttons. CharacterLibrary injects a bare
// `<div class="drawer">` after #rightNavHolder; upstream's global `.drawer { width: 100% }` made it
// the only non-zero flex child of this fork's fixed, full-width #top-settings-holder, so it painted
// over the whole SillyBunny bar and swallowed every click meant for it.
// Run with: SILLYBUNNY_TEST_BASE_URL=http://127.0.0.1:<port> npx playwright test topbar-extension-adoption.e2e.js

const IPHONE_VIEWPORT = { width: 390, height: 844 };

// Extensions raise first-run surfaces after the chat settles, and a full-screen overlay owns
// every elementFromPoint hit. Several are plain divs rather than <dialog>, so
// dismissOpenDialogIfPresent alone does not clear them, and which ones appear depends on what is
// installed. Clear them by shape rather than by name so this pack does not have to track them.
async function openBarForTest(page) {
    await openQuietChatForSmoke(page);
    await dismissOpenDialogIfPresent(page);
    await page.evaluate(() => {
        const shellIds = new Set(['top-bar', 'top-settings-holder', 'sheld', 'left-nav-panel', 'right-nav-panel', 'user-settings-block']);
        const viewportArea = window.innerWidth * window.innerHeight;

        for (const node of Array.from(document.body.children)) {
            if (!(node instanceof HTMLElement) || shellIds.has(node.id) || node.id.startsWith('sb-')) {
                continue;
            }

            const rect = node.getBoundingClientRect();

            if (window.getComputedStyle(node).position === 'fixed' && rect.width * rect.height > viewportArea * 0.3) {
                node.remove();
            }
        }

        document.querySelectorAll('#toast-container .toast').forEach(toast => toast.remove());
    });
    await waitForAnimationFrames(page, 2);
}

async function injectCharacterLibraryButton(page) {
    await page.evaluate(() => {
        document.getElementById('st-gallery-btn')?.remove();
        document.querySelector('#rightNavHolder').insertAdjacentHTML('afterend', [
            '<div id="st-gallery-btn" class="drawer">',
            '<div class="drawer-toggle drawer-header">',
            '<div id="charlib-launcher-icon" class="drawer-icon fa-solid fa-layer-group fa-fw closedIcon"></div>',
            '</div></div>',
        ].join(''));

        // Bind before adoption runs: if the slot cloned instead of moved, this never fires.
        window.__sbGalleryClicks = 0;
        document.getElementById('st-gallery-btn')
            .addEventListener('click', () => { window.__sbGalleryClicks++; });
    });

    await waitForAnimationFrames(page, 3);
}

function getAdoptionSnapshot(page) {
    return page.evaluate(() => {
        const button = document.getElementById('st-gallery-btn');
        const slot = document.getElementById('sb-topbar-extension-slot');
        const title = document.getElementById('sb-topbar-title');
        const titleRect = title.getBoundingClientRect();
        const titleHit = document.elementFromPoint(
            Math.round(titleRect.left + titleRect.width / 2),
            Math.round(titleRect.top + titleRect.height / 2),
        );

        const hitTest = (id) => {
            const element = document.getElementById(id);
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
                Math.round(rect.left + rect.width / 2),
                Math.round(rect.top + rect.height / 2),
            );

            return element.contains(hit);
        };

        return {
            inSlot: Boolean(slot && button && slot.contains(button)),
            slotEmpty: slot?.dataset.sbTopbarSlotEmpty,
            buttonWidth: button.getBoundingClientRect().width,
            viewportWidth: window.innerWidth,
            titleBlocked: Boolean(button.contains(titleHit)),
            homeHittable: hitTest('sb-home-toggle'),
            charactersHittable: hitTest('sb-character-toggle'),
        };
    });
}

test.describe('third-party top-bar button adoption', () => {
    test('adopts the CharacterLibrary button instead of letting it cover the bar', async ({ page }) => {
        await openBarForTest(page);
        await injectCharacterLibraryButton(page);

        const snapshot = await getAdoptionSnapshot(page);

        expect(snapshot.inSlot).toBe(true);
        expect(snapshot.slotEmpty).toBe('false');
        // The literal regression: the button used to stretch the full viewport width.
        expect(snapshot.buttonWidth).toBeLessThan(80);
        expect(snapshot.buttonWidth).toBeLessThan(snapshot.viewportWidth / 2);
        expect(snapshot.titleBlocked).toBe(false);
        expect(snapshot.homeHittable).toBe(true);
        expect(snapshot.charactersHittable).toBe(true);
    });

    test('keeps listeners bound before adoption, so the node was moved and not cloned', async ({ page }) => {
        await openBarForTest(page);
        await injectCharacterLibraryButton(page);

        await page.click('#charlib-launcher-icon');

        expect(await page.evaluate(() => window.__sbGalleryClicks)).toBe(1);
        expect(await page.evaluate(() => document.querySelectorAll('#st-gallery-btn').length)).toBe(1);
    });

    test('mirrors an extension badge onto the visible Characters button', async ({ page }) => {
        await openBarForTest(page);

        await page.evaluate(() => {
            const chevron = document.createElement('i');
            chevron.className = 'fa-solid fa-caret-down charlib-chevron-badge';
            document.getElementById('rightNavDrawerIcon').appendChild(chevron);
        });
        await waitForAnimationFrames(page, 3);

        const badge = await page.evaluate(() => {
            const chevron = document.querySelector('.charlib-chevron-badge');
            const proxy = document.getElementById('sb-character-toggle');
            const rect = chevron.getBoundingClientRect();

            return {
                onProxy: proxy.contains(chevron),
                proxyUnclipped: proxy.classList.contains('sb-has-adopted-badge'),
                width: rect.width,
                height: rect.height,
                copies: document.querySelectorAll('.charlib-chevron-badge').length,
            };
        });

        expect(badge.onProxy).toBe(true);
        expect(badge.proxyUnclipped).toBe(true);
        expect(badge.width).toBeGreaterThan(0);
        expect(badge.height).toBeGreaterThan(0);
        expect(badge.copies).toBe(1);
    });

    test('makes a plain non-drawer extension button clickable in the top strip', async ({ page }) => {
        await openBarForTest(page);

        await page.evaluate(() => {
            window.__sbPlainClicks = 0;
            const button = document.createElement('div');
            button.id = 'sb-e2e-plain-ext-button';
            button.className = 'menu_button';
            button.innerHTML = '<i class="fa-solid fa-flask"></i>';
            button.addEventListener('click', () => { window.__sbPlainClicks++; });
            document.getElementById('top-settings-holder').appendChild(button);
        });
        await waitForAnimationFrames(page, 3);

        await page.click('#sb-e2e-plain-ext-button');

        expect(await page.evaluate(() => window.__sbPlainClicks)).toBe(1);
    });

    test('lets a bare text-node label expand an adopted menu button on a phone', async ({ page }) => {
        await page.setViewportSize(IPHONE_VIEWPORT);
        await openBarForTest(page);

        await page.evaluate(() => {
            const button = document.createElement('button');
            button.id = 'sb-e2e-bare-text-menu-button';
            button.type = 'button';
            button.className = 'menu_button';
            button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Copilot';
            document.getElementById('top-settings-holder').appendChild(button);
        });
        await waitForAnimationFrames(page, 3);

        const button = await page.evaluate(() => {
            const element = document.getElementById('sb-e2e-bare-text-menu-button');
            const slot = document.getElementById('sb-topbar-extension-slot');
            return {
                adopted: Boolean(slot && slot.contains(element)),
                width: element.getBoundingClientRect().width,
                height: element.getBoundingClientRect().height,
                contentFits: element.scrollWidth <= element.clientWidth
                    && element.scrollHeight <= element.clientHeight,
            };
        });

        expect(button.adopted).toBe(true);
        expect(button.width).toBeGreaterThan(button.height);
        expect(button.contentFits).toBe(true);
    });

    test('lets a span label expand an adopted menu button on a phone', async ({ page }) => {
        await page.setViewportSize(IPHONE_VIEWPORT);
        await openBarForTest(page);

        await page.evaluate(() => {
            const button = document.createElement('button');
            button.id = 'sb-e2e-span-text-menu-button';
            button.type = 'button';
            button.className = 'menu_button';
            button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>Copilot</span>';
            document.getElementById('top-settings-holder').appendChild(button);
        });
        await waitForAnimationFrames(page, 3);

        const button = await page.evaluate(() => {
            const element = document.getElementById('sb-e2e-span-text-menu-button');
            const slot = document.getElementById('sb-topbar-extension-slot');
            return {
                adopted: Boolean(slot && slot.contains(element)),
                width: element.getBoundingClientRect().width,
                height: element.getBoundingClientRect().height,
                contentFits: element.scrollWidth <= element.clientWidth
                    && element.scrollHeight <= element.clientHeight,
            };
        });

        expect(button.adopted).toBe(true);
        expect(button.width).toBeGreaterThan(button.height);
        expect(button.contentFits).toBe(true);
    });

    test('keeps a third-party composer button visible on a phone', async ({ page }) => {
        await page.setViewportSize(IPHONE_VIEWPORT);
        await openBarForTest(page);

        await page.evaluate(() => {
            const button = document.createElement('div');
            button.id = 'sb-e2e-composer-ext-button';
            button.className = 'fa-solid fa-dice interactable';
            document.getElementById('rightSendForm').appendChild(button);
        });
        await waitForAnimationFrames(page, 3);

        const composer = await page.evaluate(() => {
            const button = document.getElementById('sb-e2e-composer-ext-button');
            const rect = button.getBoundingClientRect();

            return {
                inLeftRail: document.getElementById('leftSendForm').contains(button),
                display: window.getComputedStyle(button).display,
                width: rect.width,
                height: rect.height,
            };
        });

        // The old allow-list rule hid every unrecognised right-rail child outright on phones.
        expect(composer.display).not.toBe('none');
        expect(composer.inLeftRail).toBe(true);
        expect(composer.width).toBeGreaterThan(0);
        expect(composer.height).toBeGreaterThan(0);
    });

    test('lists a third-party settings drawer on the Extensions page and on no other', async ({ page }) => {
        await openBarForTest(page);
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'appearance'));
        await expect(page.locator('#sb-settings-page')).toBeVisible();

        // An extension that predates the Extensions panel appends its drawer to the legacy settings column.
        await page.evaluate(() => {
            const drawer = document.createElement('div');
            drawer.id = 'sb-e2e-ext-settings-drawer';
            drawer.className = 'inline-drawer wide100p flexFlowColumn';
            drawer.innerHTML = '<div class="inline-drawer-toggle inline-drawer-header"><b>E2E Ext</b></div>'
                + '<div class="inline-drawer-content">body</div>';
            document.getElementById('user-settings-block-content').appendChild(drawer);
        });

        const shown = page.locator(':text-is("E2E Ext"):visible');
        const row = page.locator('.sb-subpage-row', { hasText: 'E2E Ext' });

        for (const tab of ['appearance', 'interface', 'messages', 'data-security', 'logs']) {
            await page.evaluate(id => window.SillyBunnyShell.openTab('right', id), tab);
            await expect(page.locator('#sb-settings-page [aria-current="page"], #sb-settings-page .sb-settings-tab[aria-selected="true"]').first()).toBeVisible();
            await expect(shown, `the drawer is not shown on ${tab}`).toHaveCount(0);
        }

        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
        await expect(row, 'the drawer is a row of the Extensions page').toBeVisible();
        await expect(row).toHaveCount(1);

        const homes = await page.evaluate(() => ({
            drawer: document.getElementById('sb-e2e-ext-settings-drawer').parentElement.id,
            firstParty: document.getElementById('ChatCharactersSection')?.closest('#user-settings-block-content') !== null,
        }));
        expect(homes.drawer).toBe('extensions_settings2');
        // A drawer that the page was authored with is not an extension's, so it stays where it is.
        expect(homes.firstParty).toBe(true);

        // The row opens the drawer as a page, which names it, so the drawer's own toggle stays hidden.
        await row.click();
        await expect(page.locator('#sb-e2e-ext-settings-drawer .inline-drawer-content')).toBeVisible();
    });

    test('global search finds a setting of a third-party drawer and opens the Extensions page for it', async ({ page }) => {
        await openBarForTest(page);
        await page.evaluate(() => {
            const drawer = document.createElement('div');
            drawer.id = 'sb-e2e-ext-settings-drawer';
            drawer.className = 'inline-drawer wide100p flexFlowColumn';
            drawer.innerHTML = '<div class="inline-drawer-toggle inline-drawer-header"><b>E2E Ext</b></div>'
                + '<div class="inline-drawer-content"><label class="checkbox_label"><input type="checkbox" id="sb-e2e-ext-setting">'
                + '<span>Frobnicate the widgets</span></label></div>';
            document.getElementById('user-settings-block-content').appendChild(drawer);
        });

        await page.locator('#sb-topbar-search-toggle').click();
        await page.locator('#sb-universal-search input').fill('Frobnicate the widgets');
        const result = page.locator('#sb-universal-search-results').getByRole('group', { name: 'Customize · Extensions', exact: true })
            .getByRole('option', { name: /Frobnicate the widgets/ });
        await expect(result).toBeVisible();
        await result.click();

        await expect(page.locator('button[data-sb-settings-tab="extensions"]')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#sb-e2e-ext-setting')).toBeVisible();
    });

    test('anchors a fixed extension panel below the whole bar, chat bar row included', async ({ page }) => {
        await openBarForTest(page);

        const measure = () => page.evaluate(() => {
            // CharacterLibrary positions its embedded panel with exactly these inline styles.
            const container = document.createElement('div');
            container.id = 'charlib-embedded-container';
            Object.assign(container.style, {
                position: 'fixed',
                top: 'var(--topBarBlockSize, 37px)',
                left: '0',
                right: '0',
                bottom: '0',
            });
            document.body.appendChild(container);
            const containerTop = container.getBoundingClientRect().top;
            container.remove();

            return { barBottom: document.getElementById('top-bar').getBoundingClientRect().bottom, containerTop };
        });

        const compact = await measure();
        expect(compact.containerTop).toBeCloseTo(compact.barBottom, 0);

        // The regression case: with the chat bar row showing, the bar is taller than
        // --topBarBlockSize and the panel used to paint over the bottom of it.
        await page.evaluate(() => document.body.classList.remove('sb-topbar-compact'));
        await waitForAnimationFrames(page, 2);

        const withChatBar = await measure();
        expect(withChatBar.barBottom).toBeGreaterThan(compact.barBottom);
        expect(withChatBar.containerTop).toBeCloseTo(withChatBar.barBottom, 0);
    });

    test('holds the same contract on a phone viewport with the icons-only bar', async ({ page }) => {
        await page.setViewportSize(IPHONE_VIEWPORT);
        await openBarForTest(page);

        await page.evaluate(() => {
            window.SillyBunnyShell?.setTopbarIconsOnly?.(true);
        });
        await waitForAnimationFrames(page, 3);
        await injectCharacterLibraryButton(page);

        const snapshot = await getAdoptionSnapshot(page);

        expect(snapshot.inSlot).toBe(true);
        expect(snapshot.buttonWidth).toBeLessThan(snapshot.viewportWidth / 2);
        expect(snapshot.titleBlocked).toBe(false);
        expect(snapshot.charactersHittable).toBe(true);
    });
});
