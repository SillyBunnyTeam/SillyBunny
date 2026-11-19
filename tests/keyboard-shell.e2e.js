import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { waitForAppReady } from './helpers/app-ready.js';
import { showSettingsSidebar } from './helpers/settings-phone-pane.js';

// Keyboard order of the shell: what a full-screen page covers, how its sidebar tabs move, and where Escape goes.
// Every step is a key press; the pointer only opens the page where the test is about the toggle.

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.setTimeout(120000);

const VIEWPORTS = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'phone', width: 390, height: 844 },
];

const TOGGLES = [
    { shell: 'left', id: 'sb-left-shell-toggle', label: 'Backend' },
    { shell: 'right', id: 'sb-right-shell-toggle', label: 'Customize' },
    { shell: 'characters', id: 'sb-character-toggle', label: 'Characters' },
];

async function loadApp(page, viewport) {
    await protectMaintainerServer(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');
    await waitForAppReady(page, { timeout: 60000 });
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
}

/** Opens a page from its top-bar toggle with the keyboard. */
async function openFromToggle(page, id) {
    const toggle = page.locator(`#${id}`);
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#sb-settings-page')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-sb-settings-open', 'true');
    // The page has finished opening once nothing is animating it.
    await expect.poll(() => page.evaluate(() => document.getElementById('sb-settings-page').getAnimations().length)).toBe(0);
}

const focusDescription = page => page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { body: true };
    const rect = element.getBoundingClientRect();
    return {
        body: false,
        id: element.id,
        role: element.getAttribute('role') || '',
        inPage: Boolean(element.closest('#sb-settings-page')),
        inTopBar: Boolean(element.closest('#top-bar')),
        inSheld: Boolean(element.closest('#sheld')),
        width: rect.width,
        height: rect.height,
        label: (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').trim().slice(0, 40),
    };
});

for (const viewport of VIEWPORTS) {
    test.describe(`keyboard order of the shell, ${viewport.name}`, () => {
        test.beforeEach(async ({ page }) => {
            await loadApp(page, viewport);
        });

        for (const toggle of TOGGLES) {
            test(`${toggle.label}: Tab past the page's last control never reaches the layer behind it`, async ({ page }) => {
                await openFromToggle(page, toggle.id);
                const behind = [];
                for (let press = 0; press < 220; press++) {
                    await page.keyboard.press('Tab');
                    const focus = await focusDescription(page);
                    if (!focus.body && !focus.inPage && !focus.inTopBar) behind.push(`${press}: #${focus.id} ${focus.label}`);
                }
                expect(behind).toEqual([]);
                expect(await page.evaluate(() => document.getElementById('sheld').inert)).toBe(true);
            });

            test(`${toggle.label}: closing returns focus to the toggle and frees the layer behind`, async ({ page }) => {
                await openFromToggle(page, toggle.id);
                await page.keyboard.press('Escape');
                await expect(page.locator('#sb-settings-page')).toBeHidden();
                await expect(page.locator(`#${toggle.id}`)).toBeFocused();
                expect(await page.evaluate(() => {
                    const sheld = document.getElementById('sheld');
                    return { inert: sheld.inert, ariaHidden: sheld.getAttribute('aria-hidden') };
                })).toEqual({ inert: false, ariaHidden: null });
            });
        }

        test('opening a page over another keeps the layer inert, and closing frees it', async ({ page }) => {
            await openFromToggle(page, 'sb-right-shell-toggle');
            await openFromToggle(page, 'sb-left-shell-toggle');
            expect(await page.evaluate(() => document.getElementById('sheld').inert)).toBe(true);
            await page.keyboard.press('Escape');
            await expect(page.locator('#sb-settings-page')).toBeHidden();
            expect(await page.evaluate(() => document.getElementById('sheld').inert)).toBe(false);
        });

        for (const toggle of TOGGLES) {
            test(`${toggle.label}: the sidebar tabs are one Tab stop and the arrow keys move between them`, async ({ page }) => {
                await openFromToggle(page, toggle.id);
                if (viewport.name === 'phone') await showSettingsSidebar(page);
                const tabs = page.locator('#sb-settings-tab-list [role="tab"]');
                const count = await tabs.count();
                expect(count).toBeGreaterThan(2);
                expect(await tabs.evaluateAll(nodes => nodes.filter(node => node.tabIndex === 0).length)).toBe(1);
                await expect(page.locator('#sb-settings-tab-list [role="tab"][aria-selected="true"]')).toHaveAttribute('tabindex', '0');

                const selected = page.locator('#sb-settings-tab-list [role="tab"][aria-selected="true"]');
                await selected.focus();
                const selectedId = await selected.getAttribute('data-sb-settings-tab');
                await page.keyboard.press('ArrowDown');
                expect((await focusDescription(page)).role).toBe('tab');
                expect(await page.evaluate(() => document.activeElement.dataset.sbSettingsTab)).not.toBe(selectedId);
                // Moving does not select: the page does not change until Enter.
                await expect(selected).toHaveAttribute('aria-selected', 'true');
                await page.keyboard.press('End');
                expect(await page.evaluate(() => document.activeElement === [...document.querySelectorAll('#sb-settings-tab-list [role="tab"]')].at(-1))).toBe(true);
                await page.keyboard.press('ArrowDown');
                expect(await page.evaluate(() => document.activeElement === document.querySelector('#sb-settings-tab-list [role="tab"]'))).toBe(true);
                await page.keyboard.press('ArrowUp');
                expect(await page.evaluate(() => document.activeElement === [...document.querySelectorAll('#sb-settings-tab-list [role="tab"]')].at(-1))).toBe(true);
                await page.keyboard.press('Home');
                expect(await page.evaluate(() => document.activeElement === document.querySelector('#sb-settings-tab-list [role="tab"]'))).toBe(true);
                // The focused tab holds the one Tab stop.
                expect(await tabs.evaluateAll(nodes => nodes.filter(node => node.tabIndex === 0).length)).toBe(1);

                // Enter selects the tab that has focus.
                await page.keyboard.press('ArrowDown');
                const target = await page.evaluate(() => document.activeElement.dataset.sbSettingsTab);
                await page.keyboard.press('Enter');
                await expect(page.locator(`#sb-settings-tab-list [role="tab"][data-sb-settings-tab="${target}"]`)).toHaveAttribute('aria-selected', 'true');
            });

            test(`${toggle.label}: Tab leaves the sidebar tabs in one press`, async ({ page }) => {
                await openFromToggle(page, toggle.id);
                if (viewport.name === 'phone') await showSettingsSidebar(page);
                await page.locator('#sb-settings-tab-list [role="tab"][aria-selected="true"]').focus();
                await page.keyboard.press('Tab');
                expect((await focusDescription(page)).role).not.toBe('tab');
            });
        }

        test('Home: the recent-chat filters are one Tab stop and the arrow keys move between them', async ({ page }) => {
            const filters = page.locator('.welcomePanel .welcomeRecentTab:visible');
            await expect(filters.first()).toBeVisible();
            expect(await filters.evaluateAll(nodes => nodes.filter(node => node.tabIndex === 0).length)).toBe(1);
            const pressed = page.locator('.welcomePanel .welcomeRecentTab[aria-pressed="true"]');
            await expect(pressed).toHaveAttribute('tabindex', '0');
            await pressed.focus();
            await page.keyboard.press('ArrowRight');
            await expect(page.locator('.welcomePanel .welcomeRecentTab[data-recent-chat-filter="individual"]')).toBeFocused();
            await expect(page.locator('.welcomePanel .welcomeRecentTab[data-recent-chat-filter="individual"]')).toHaveAttribute('aria-pressed', 'true');
            await page.keyboard.press('End');
            expect(await page.evaluate(() => document.activeElement === [...document.querySelectorAll('.welcomePanel .welcomeRecentTab')].filter(node => node.offsetParent).at(-1))).toBe(true);
            await page.keyboard.press('Home');
            await expect(page.locator('.welcomePanel .welcomeRecentTab[data-recent-chat-filter="all"]')).toBeFocused();
            await page.keyboard.press('ArrowLeft');
            expect(await page.evaluate(() => document.activeElement === [...document.querySelectorAll('.welcomePanel .welcomeRecentTab')].filter(node => node.offsetParent).at(-1))).toBe(true);
        });

        test('Characters: no Tab stop without a box, and focus never falls to the page body', async ({ page }) => {
            await openFromToggle(page, 'sb-character-toggle');
            if (viewport.name === 'phone') await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
            // The list mounts after the page opens; Tab before then walks a page that holds only its sidebar.
            await expect(page.locator('#rm_characters_block .sb-character-list .ds-entity-row').first()).toBeVisible();
            const stops = [];
            for (let press = 0; press < 7; press++) {
                await page.keyboard.press('Tab');
                stops.push(await focusDescription(page));
            }
            expect(stops.filter(stop => stop.body || stop.id === 'rm_button_create' || stop.id === 'character_import_button')).toEqual([]);
            expect(stops.filter(stop => !stop.body && (stop.width < 16 || stop.height < 16))).toEqual([]);
        });

        test('Characters: the upstream button bar is out of the Tab order before the list has mounted', async ({ page }) => {
            // The list sheet hides the bar only while the list is mounted, and the list mounts when the page first opens.
            const bar = await page.evaluate(() => ({
                mounted: Boolean(document.querySelector('.sb-character-list')),
                display: getComputedStyle(document.getElementById('rm_button_bar')).display,
            }));
            expect(bar.mounted).toBe(false);
            expect(bar.display).toBe('none');
        });

        test('Customize: no Tab stop without a box, and focus never falls to the page body', async ({ page }) => {
            await openFromToggle(page, 'sb-right-shell-toggle');
            if (viewport.name === 'phone') await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'appearance'));
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'backgrounds'));
            await page.locator('#sb-settings-content').focus().catch(() => {});
            const stops = [];
            for (let press = 0; press < 70; press++) {
                await page.keyboard.press('Tab');
                stops.push(await focusDescription(page));
            }
            expect(stops.filter(stop => stop.body)).toEqual([]);
            expect(stops.filter(stop => !stop.body && stop.inPage && (stop.width < 12 || stop.height < 12))).toEqual([]);
        });

        test('Settings opened from its toggle holds focus inside the page, and Escape closes it', async ({ page }) => {
            await openFromToggle(page, 'sb-right-shell-toggle');
            expect((await focusDescription(page)).inPage).toBe(true);
            await page.keyboard.press('Escape');
            await expect(page.locator('#sb-settings-page')).toBeHidden();
        });

        test('Escape closes the page while focus is still on its toggle', async ({ page }) => {
            await openFromToggle(page, 'sb-right-shell-toggle');
            await page.locator('#sb-right-shell-toggle').focus();
            await page.keyboard.press('Escape');
            await expect(page.locator('#sb-settings-page')).toBeHidden();
            await expect(page.locator('#sb-right-shell-toggle')).toBeFocused();
        });
    });
}

test.describe('Persona editor Escape', () => {
    async function openPersonaEditorPage(page) {
        await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'persona'));
        await expect(page.locator('#PersonaManagement .sb-persona-editor')).toBeVisible();
        await page.evaluate(async () => {
            const { user_avatar } = await import('./scripts/personas.js');
            const { openPersonaEditor } = await import('./scripts/sillybunny-persona-editor.js');
            if (!await openPersonaEditor({ avatarId: user_avatar })) throw new Error('Could not open the current persona');
        });
        const entry = page.locator('#PersonaManagement .sb-persona-entry');
        await expect(entry).toBeVisible();
        return entry;
    }

    for (const viewport of VIEWPORTS) {
        test(`${viewport.name}: Escape in a field does what Back does and never focuses a container`, async ({ page }) => {
            await loadApp(page, viewport);
            const entry = await openPersonaEditorPage(page);
            const description = entry.getByRole('textbox', { name: 'Persona Description', exact: true });
            await description.focus();
            await page.keyboard.press('Escape');
            await expect(entry).toBeHidden();
            await expect(page.locator('#sb-settings-page')).toBeVisible();
            const focus = await page.evaluate(() => ({ tag: document.activeElement.tagName, role: document.activeElement.getAttribute('role') }));
            expect(focus.tag).not.toBe('BODY');
            expect(focus.tag).not.toBe('SECTION');
        });
    }
});
