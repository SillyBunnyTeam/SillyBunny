/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- viewport mode selects docked or sheet-specific geometry assertions. */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchBodyOrSkip } from './helpers/route-fetch.js';

const VIEWPORTS = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1280, height: 900 },
    { width: 1024, height: 768 },
    { width: 900, height: 768 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
];

const RECENT_CHAT_FIXTURES = Array.from({ length: 24 }, (_, index) => ({
    file_name: `side-panel-qa-chat-${String(index).padStart(2, '0')}.jsonl`,
    mes: `Preview for saved conversation ${index + 1}`,
    last_mes: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    chat_items: index + 1,
}));

const PANELS = [
    { id: 'floatingPrompt', trigger: '#option_toggle_AN', side: 'left', lastControl: '#extension_default_interval' },
    { id: 'cfgConfig', trigger: '#option_toggle_CFG', side: 'left', lastControl: '#cfg_prompt_insertion_depth' },
    { id: 'logprobsViewer', trigger: '#option_toggle_logprobs', side: 'right', lastControl: '#logprobs_selected_top_logprobs' },
    { id: 'sb-chat-sidebar', trigger: null, side: 'right', lastControl: '.sb-chat-sidebar-body' },
];

test.describe.configure({ timeout: 120_000 });

test('side panels share dialog headers, boxed groups, and theme-derived surfaces', async ({ page }) => {
    await boot(page, { width: 1440, height: 900 });
    const panel = await openPanel(page, PANELS[0]);
    const headings = panel.locator('.ds-pref-group-heading');
    const heading = headings.first();
    const description = panel.locator('.ds-pref-group-subtitle').first();
    await expect(heading).toBeVisible();
    await expect(description).toBeVisible();
    for (const node of await panel.locator('.ds-pref-group-subtitle').all()) {
        expect(await node.evaluate(element => element.parentElement.classList.contains('ds-pref-group-header'))).toBe(true);
    }
    for (const node of await headings.all()) {
        const style = await node.evaluate(element => {
            const computed = getComputedStyle(element);
            return { background: computed.backgroundColor, borderRadius: computed.borderRadius, borderWidth: computed.borderWidth };
        });
        expect(style).toEqual({ background: 'rgba(0, 0, 0, 0)', borderRadius: '0px', borderWidth: '0px' });
    }
    await expect(panel.locator('.ds-row[data-sb-editor-field="authors-note-character-prompt"] .ds-row-label')).toHaveText('Author\'s Note');

    await page.evaluate(async () => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        window.qaSidePanelHeaderPopup = new Popup('<h3>Header Reference</h3>', POPUP_TYPE.TEXT, '', { large: true });
        void window.qaSidePanelHeaderPopup.show();
    });
    const popup = page.locator('dialog.popup[open]').last();
    await expect(popup.locator('.sb-dialog__header')).toBeVisible();
    await expect(popup).not.toHaveAttribute('opening');
    await expect.poll(() => popup.locator('.sb-dialog__header').evaluate(node => node.getBoundingClientRect().height)).toBe(56);
    const headerMetrics = await page.evaluate(() => {
        const panel = document.querySelector('.sb-side-panel[data-sb-side-panel-id="floatingPrompt"]');
        const popupHeader = document.querySelector('dialog.popup[open] .sb-dialog__header');
        const panelHeader = panel.querySelector('.sb-side-panel__header');
        const panelButtons = [...panelHeader.querySelectorAll('.sb-dialog__icon-button')];
        const popupButton = popupHeader.querySelector('.sb-dialog__close');
        const body = panel.querySelector('.sb-side-panel__body');
        const panelStyle = getComputedStyle(panel);
        return {
            panelHeaderHeight: panelHeader.getBoundingClientRect().height,
            popupHeaderHeight: popupHeader.getBoundingClientRect().height,
            panelButtons: panelButtons.map(button => [getComputedStyle(button).width, getComputedStyle(button).height]),
            popupButton: [getComputedStyle(popupButton).width, getComputedStyle(popupButton).height],
            headerBackground: getComputedStyle(panelHeader).backgroundColor,
            bodyBackground: getComputedStyle(body).backgroundColor,
            shadow: panelStyle.boxShadow,
            borderWidths: [panelStyle.borderTopWidth, panelStyle.borderRightWidth, panelStyle.borderBottomWidth, panelStyle.borderLeftWidth],
            borderRadius: panelStyle.borderRadius,
            background: panelStyle.backgroundColor,
        };
    });
    expect(headerMetrics.panelHeaderHeight).toBe(headerMetrics.popupHeaderHeight);
    expect(headerMetrics.panelButtons).toEqual([['40px', '40px'], ['40px', '40px']]);
    expect(headerMetrics.popupButton).toEqual(['40px', '40px']);
    expect(headerMetrics.headerBackground).not.toBe(headerMetrics.bodyBackground);
    expect(headerMetrics.shadow).toBe('none');
    expect(headerMetrics.borderWidths).toEqual(['1px', '1px', '1px', '1px']);
    expect(headerMetrics.borderRadius).toBe('0px');
    expect(headerMetrics.background).toBe(await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.background = 'var(--sb-layer-window)';
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
    }));
    await popup.locator('.sb-dialog__close').click();
    await expect(popup).toHaveCount(0);

    const themeStyles = [];
    for (const theme of ['Libadwaita', 'Libadwaita Light', 'Cinder']) {
        await page.evaluate(themeName => {
            const select = document.getElementById('themes');
            select.value = themeName;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }, theme);
        await expect.poll(() => page.evaluate(themeName => window.SillyTavern.getContext().powerUserSettings.theme === themeName, theme)).toBe(true);
        themeStyles.push(await panel.evaluate(element => ({
            tone: document.documentElement.dataset.sbSurfaceTone,
            header: getComputedStyle(element.querySelector('.sb-side-panel__header')).backgroundColor,
            body: getComputedStyle(element.querySelector('.sb-side-panel__body')).backgroundColor,
            shadow: getComputedStyle(element).boxShadow,
            borderTopWidth: getComputedStyle(element).borderTopWidth,
            borderTopColor: getComputedStyle(element).borderTopColor,
        })));
    }
    expect(themeStyles[0].tone).toBe('dark');
    expect(themeStyles[1].tone).toBe('light');
    for (const style of themeStyles) {
        expect(style.header).not.toBe(style.body);
        expect(style.shadow).toBe('none');
        // With no shadow, the border is what separates a docked panel from the chat.
        expect(style.borderTopWidth).toBe('1px');
        expect(colourAlpha(style.borderTopColor), `${style.tone}: ${style.borderTopColor}`).toBeGreaterThan(0);
    }
    expect(themeStyles[0].header).not.toBe(themeStyles[1].header);
    expect(themeStyles[2].header).not.toBe(themeStyles[0].header);
    await page.evaluate(() => {
        const select = document.getElementById('themes');
        select.value = 'Libadwaita';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#sb-left-shell-toggle').click();
    await expect(page.locator('#sb-settings-page')).toBeVisible();
    const settingsCoversPanel = await page.evaluate(() => {
        const panel = document.querySelector('.sb-side-panel[data-sb-side-panel-id="floatingPrompt"]');
        const box = panel.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return document.getElementById('sb-settings-page').contains(hit);
    });
    expect(settingsCoversPanel).toBe(true);
    await page.locator('#sb-settings-close').click();
});

for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
    test(`Author's Note sheet fits inside ${viewport.width}×${viewport.height}`, async ({ page }) => {
        await boot(page, viewport);
        const panel = await openPanel(page, PANELS[0]);
        await expect(panel).toHaveClass(/sb-side-panel--sheet/);
        const overflow = await panel.evaluate(element => {
            const panelRight = element.getBoundingClientRect().right;
            const offenders = [...element.querySelectorAll('*')]
                .filter(child => child.getClientRects().length > 0 && child.getBoundingClientRect().right > panelRight + 0.5)
                .map(child => ({ selector: child.id ? `#${child.id}` : child.className, right: child.getBoundingClientRect().right }));
            const body = element.querySelector('.sb-side-panel__body');
            return {
                panelScroll: [element.scrollWidth, element.clientWidth],
                bodyScroll: [body.scrollWidth, body.clientWidth],
                offenders,
            };
        });
        expect(overflow.offenders, JSON.stringify(overflow)).toEqual([]);
        expect(overflow.panelScroll[0]).toBeLessThanOrEqual(overflow.panelScroll[1]);
        expect(overflow.bodyScroll[0]).toBeLessThanOrEqual(overflow.bodyScroll[1]);
    });
}

test.describe('the side-panel sheet swipe at 390×844', () => {
    const SHEET_VIEWPORT = { width: 390, height: 844 };

    async function openSheet(page) {
        await boot(page, SHEET_VIEWPORT);
        const panel = await openPanel(page, PANELS[0]);
        await closePanel(page, PANELS[0].id);
        // The Author's Note trigger does not pass the composer as the opener, so the test names it.
        await page.evaluate(() => window.SillyBunnySidePanels.openSidePanel('floatingPrompt', { opener: document.getElementById('send_textarea') }));
        await expect(panel).toBeVisible();
        await expect(panel).toHaveClass(/sb-side-panel--sheet/);
        await expect.poll(() => panel.evaluate(element => element.getAnimations().length)).toBe(0);
        return panel;
    }

    const topOf = panel => panel.evaluate(element => element.getBoundingClientRect().top);

    async function centreOf(locator) {
        const box = await locator.boundingBox();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }

    // The pointer stays still before release, so the release velocity is 0 and only the distance decides.
    async function dragDown(page, from, distance) {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x, from.y + distance, { steps: 8 });
    }

    test('a long swipe from the handle follows the finger, then closes through the normal close path', async ({ page }) => {
        const panel = await openSheet(page);
        const restTop = await topOf(panel);
        await dragDown(page, await centreOf(panel.locator(':scope > .sb-dialog__handle')), 220);
        await expect.poll(() => topOf(panel)).toBeCloseTo(restTop + 220, 0);
        await page.mouse.up();

        await expect(panel).toBeHidden();
        await expect(page.locator('body')).not.toHaveClass(/sb-has-side-panel-sheet/);
        await expect(page.locator('#send_textarea')).toBeFocused();
        expect(await panel.evaluate(element => element.style.transform)).toBe('');

        await openPanel(page, PANELS[0]);
        await expect.poll(() => topOf(panel)).toBeCloseTo(restTop, 0);
    });

    test('a long swipe from the header title closes the panel', async ({ page }) => {
        const panel = await openSheet(page);
        await dragDown(page, await centreOf(panel.locator('.sb-side-panel__title')), 220);
        await page.mouse.up();
        await expect(panel).toBeHidden();
    });

    test('a swipe that starts on a header control does not drag the panel', async ({ page }) => {
        const panel = await openSheet(page);
        const restTop = await topOf(panel);
        await dragDown(page, await centreOf(panel.locator('.sb-side-panel__close')), 220);
        expect(await topOf(panel)).toBe(restTop);
        await page.mouse.up();
        await expect(panel).toBeVisible();
        expect(await topOf(panel)).toBe(restTop);
    });

    test('a short swipe springs back and keeps the panel open', async ({ page }) => {
        const panel = await openSheet(page);
        const restTop = await topOf(panel);
        await dragDown(page, await centreOf(panel.locator(':scope > .sb-dialog__handle')), 40);
        await expect.poll(() => topOf(panel)).toBeCloseTo(restTop + 40, 0);
        await page.mouse.up();

        await expect.poll(() => topOf(panel)).toBeCloseTo(restTop, 0);
        await expect(panel).toBeVisible();
        await expect(panel).toHaveClass(/sb-side-panel--sheet/);
    });

    test('reduced motion springs back at once, without an animation', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const panel = await openSheet(page);
        const restTop = await topOf(panel);
        await dragDown(page, await centreOf(panel.locator(':scope > .sb-dialog__handle')), 40);
        await expect.poll(() => topOf(panel)).toBeCloseTo(restTop + 40, 0);
        await page.mouse.up();

        expect(await panel.evaluate(element => ({ animations: element.getAnimations().length, top: element.getBoundingClientRect().top }))).toEqual({ animations: 0, top: restTop });
    });

    test('the grab handle sits above the header at the shared sheet position and size', async ({ page }) => {
        const panel = await openSheet(page);
        const metrics = await panel.evaluate(element => {
            const panelRect = element.getBoundingClientRect();
            const handle = element.querySelector(':scope > .sb-dialog__handle');
            const header = element.querySelector(':scope > .sb-side-panel__header');
            const handleRect = handle.getBoundingClientRect();
            const pill = getComputedStyle(handle, '::before');
            return {
                order: [...element.children].map(child => child.className.split(' ')[0]),
                handle: { width: handleRect.width, height: handleRect.height, top: handleRect.top - panelRect.top, centre: handleRect.left + handleRect.width / 2 - panelRect.left - panelRect.width / 2 },
                pill: { top: pill.top, height: pill.height },
                headerPaddingTop: getComputedStyle(header).paddingTop,
                headerRowMinimum: getComputedStyle(header).gridAutoRows,
            };
        });
        expect(metrics.order.slice(0, 2)).toEqual(['sb-dialog__handle', 'sb-dialog__header']);
        expect(metrics.handle.width).toBe(80);
        expect(metrics.handle.height).toBe(20);
        expect(metrics.handle.top).toBeLessThanOrEqual(1);
        expect(Math.abs(metrics.handle.centre)).toBeLessThanOrEqual(1);
        expect(metrics.pill).toEqual({ top: '8px', height: '4px' });
        expect(metrics.headerPaddingTop).toBe('16px');
        expect(metrics.headerRowMinimum).toBe('minmax(44px, auto)');
    });

    test('the sheet header rules do not reach a dialog header inside the hosted content', async ({ page }) => {
        const panel = await openSheet(page);
        const hosted = await panel.evaluate(element => {
            const header = document.createElement('div');
            header.className = 'sb-dialog__header';
            element.querySelector('.sb-side-panel__content').append(header);
            const own = getComputedStyle(element.querySelector(':scope > .sb-side-panel__header'));
            const inner = getComputedStyle(header);
            const result = {
                ownTouchAction: own.touchAction,
                hostedTouchAction: inner.touchAction,
                hostedUserSelect: inner.userSelect,
                hostedPaddingTop: inner.paddingTop,
            };
            header.remove();
            return result;
        });
        expect(hosted.ownTouchAction).toBe('none');
        expect(hosted).toMatchObject({ hostedTouchAction: 'auto', hostedUserSelect: 'auto', hostedPaddingTop: '6px' });
    });

    test('a long swipe slides out from the drag position, then closes through the normal path', async ({ page }) => {
        await boot(page, SHEET_VIEWPORT, { motion: true });
        const panel = await openPanel(page, PANELS[0]);
        await closePanel(page, PANELS[0].id);
        await page.evaluate(() => window.SillyBunnySidePanels.openSidePanel('floatingPrompt', { opener: document.getElementById('send_textarea') }));
        await expect(panel).toHaveClass(/sb-side-panel--sheet/);
        await expect.poll(() => panel.evaluate(element => element.getAnimations().length)).toBe(0);
        const restTop = await topOf(panel);

        await dragDown(page, await centreOf(panel.locator(':scope > .sb-dialog__handle')), 220);
        const client = await page.context().newCDPSession(page);
        await client.send('Animation.enable');
        await client.send('Animation.setPlaybackRate', { playbackRate: 0.05 });
        await page.mouse.up();
        // The slide is still running, from the dragged position, and the panel has not closed yet.
        expect(await topOf(panel)).toBeGreaterThanOrEqual(restTop + 200);
        await expect(panel).toBeVisible();
        await client.send('Animation.setPlaybackRate', { playbackRate: 1 });

        await expect(panel).toBeHidden();
        await expect(page.locator('body')).not.toHaveClass(/sb-has-side-panel-sheet/);
        await expect(page.locator('#send_textarea')).toBeFocused();
        expect(await panel.evaluate(element => element.style.transform)).toBe('');

        await openPanel(page, PANELS[0]);
        await expect.poll(() => panel.evaluate(element => element.getAnimations().length)).toBe(0);
        expect(await topOf(panel)).toBe(restTop);
    });

    test('a drag that starts during the entry follows the finger', async ({ page }) => {
        await boot(page, SHEET_VIEWPORT, { motion: true });
        expect(await page.evaluate(async () => (await import('/scripts/sillybunny-motion.js')).prefersReducedMotion())).toBe(false);
        // Slowing the page's animations keeps the entry running while the pointer goes down.
        const client = await page.context().newCDPSession(page);
        await client.send('Animation.enable');
        await client.send('Animation.setPlaybackRate', { playbackRate: 0.02 });

        const panel = await openPanel(page, PANELS[0]);
        await expect(panel).toHaveClass(/sb-side-panel--sheet/);
        expect(await panel.evaluate(element => element.getAnimations().length)).toBeGreaterThan(0);
        const sheetTop = await panel.evaluate(element => Number.parseFloat(element.style.getPropertyValue('--sb-side-panel-sheet-top')));
        await dragDown(page, await centreOf(panel.locator(':scope > .sb-dialog__handle')), 60);

        await expect.poll(() => topOf(panel)).toBeCloseTo(sheetTop + 60, 0);
        expect(await panel.evaluate(element => element.getAnimations().length)).toBe(0);
        await client.send('Animation.setPlaybackRate', { playbackRate: 1 });
        await page.mouse.up();
        await expect.poll(() => topOf(panel)).toBeCloseTo(sheetTop, 0);
        await expect(panel).toBeVisible();
    });
});

// A computed colour is `rgb()`, `rgba()` or `color(... / alpha)`; no alpha means opaque.
function colourAlpha(colour) {
    const parseAlpha = text => (text.endsWith('%') ? Number.parseFloat(text) / 100 : Number.parseFloat(text));
    const slash = colour.match(/\/\s*([\d.]+%?)\s*\)$/);
    if (slash) return parseAlpha(slash[1]);
    const legacy = colour.match(/^rgba\(([^)]+)\)$/);
    if (legacy) return parseAlpha(legacy[1].split(',')[3].trim());
    return 1;
}

async function boot(page, viewport, { motion = false } = {}) {
    await protectMaintainerServer(page);
    if (motion) {
        // The test data turns the reduced-motion setting on, which would skip the sheet spring.
        await page.route('**/api/settings/get', async route => {
            const fetched = await fetchBodyOrSkip(route, response => response.json());
            if (!fetched) return;
            const { response, body: data } = fetched;
            const settings = JSON.parse(data.settings);
            settings.power_user.reduced_motion = false;
            return route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
        });
    }
    await page.setViewportSize(viewport);
    await openQuietChatForSmoke(page);
    await page.route('**/api/characters/chats', route => route.fulfill({ json: RECENT_CHAT_FIXTURES }));
    await page.evaluate(() => document.documentElement.style.setProperty('--sheldWidth', '55vw'));
}

async function openPanel(page, definition) {
    if (definition.trigger) {
        await page.evaluate(selector => document.querySelector(selector).click(), definition.trigger);
    } else {
        await page.evaluate(() => window.SillyBunnyShell.toggleChatSidebar());
    }
    const panel = page.locator(`.sb-side-panel[data-sb-side-panel-id="${definition.id}"]`);
    await expect(panel).toBeVisible();
    return panel;
}

async function closePanel(page, id) {
    await page.evaluate(panelId => window.SillyBunnySidePanels.closeSidePanel(panelId, { restoreFocus: false }), id);
    await expect(page.locator(`.sb-side-panel[data-sb-side-panel-id="${id}"]`)).toBeHidden();
}

async function expectControlAtRowEnd(panel, controlSelector) {
    const control = panel.locator(controlSelector);
    const row = control.locator('xpath=..');
    const label = row.locator('.ds-row-text');
    const [controlBox, labelBox] = await Promise.all([control.boundingBox(), label.boundingBox()]);
    expect(controlBox).not.toBeNull();
    expect(labelBox).not.toBeNull();
    expect(controlBox.x).toBeGreaterThanOrEqual(labelBox.x + labelBox.width - 1);
}

async function readGeometry(page, panel) {
    return panel.evaluate(element => {
        const panelRect = element.getBoundingClientRect();
        const chatRect = document.getElementById('sheld').getBoundingClientRect();
        const chatContentRect = document.getElementById('chat').getBoundingClientRect();
        const composerRect = document.getElementById('form_sheld').getBoundingClientRect();
        const topBarRect = document.getElementById('top-bar').getBoundingClientRect();
        const intersects = (left, right) => left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
        return {
            mode: element.classList.contains('sb-side-panel--sheet') ? 'sheet' : 'docked',
            side: element.dataset.sbSidePanelSide,
            panel: { left: panelRect.left, right: panelRect.right, top: panelRect.top, bottom: panelRect.bottom, height: panelRect.height },
            chat: { left: chatRect.left, right: chatRect.right, width: chatRect.width },
            initialChat: window.qaSidePanelInitialChat,
            chatRect: { left: chatRect.left, right: chatRect.right, top: chatRect.top, bottom: chatRect.bottom },
            chatContentRect: { left: chatContentRect.left, right: chatContentRect.right, top: chatContentRect.top, bottom: chatContentRect.bottom },
            composerRect: { left: composerRect.left, right: composerRect.right, top: composerRect.top, bottom: composerRect.bottom },
            topBarBottom: topBarRect.bottom,
            intersectsChat: intersects(panelRect, element.classList.contains('sb-side-panel--sheet') ? chatContentRect : chatRect),
            intersectsComposer: intersects(panelRect, composerRect),
        };
    });
}

for (const viewport of VIEWPORTS) {
    test(`real side panels dock, scroll, and stay reachable at ${viewport.width}×${viewport.height}`, async ({ page }) => {
        await boot(page, viewport);
        await page.evaluate(() => {
            window.qaSidePanelInitialChat = document.getElementById('sheld').getBoundingClientRect().toJSON();
        });

        for (const definition of PANELS) {
            const panel = await openPanel(page, definition);
            await expect(panel).toHaveClass(/sb-side-panel--left|sb-side-panel--right|sb-side-panel--sheet/);
            await expect(panel.locator(definition.lastControl)).toBeAttached();
            await panel.locator('.sb-side-panel__body').evaluate(body => { body.scrollTop = body.scrollHeight; });
            await expect(panel.locator(definition.lastControl)).toBeVisible();
            if (definition.id === 'floatingPrompt') {
                await expectControlAtRowEnd(panel, '#extension_floating_allow_wi_scan');
            }
            if (definition.id === 'cfgConfig') {
                await expectControlAtRowEnd(panel, 'input[name="cfg_prompt_combine"][value="1"]');
                const numberInputStyles = await panel.locator('#chat_cfg_guidance_scale_counter').evaluate(input => {
                    const style = getComputedStyle(input);
                    return { backgroundColor: style.backgroundColor, color: style.color };
                });
                expect(numberInputStyles.backgroundColor).not.toBe('rgb(255, 255, 255)');
                expect(numberInputStyles.color).not.toBe(numberInputStyles.backgroundColor);
            }
            if (definition.id === 'logprobsViewer') {
                await expect(panel.locator('.logprobs_panel_content > small')).toContainText('Select a token to see alternatives considered by the AI.');
            }
            if (definition.id === 'sb-chat-sidebar') {
                const list = panel.locator('.sb-chat-sidebar-list');
                await expect(list.locator('.sb-chat-file')).toHaveCount(RECENT_CHAT_FIXTURES.length + 1);
                await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
                const lastChat = list.locator('.sb-chat-file').last();
                await expect(lastChat).toBeVisible();
                expect(await lastChat.evaluate(element => {
                    const scroller = element.closest('.sb-chat-sidebar-list');
                    const row = element.getBoundingClientRect();
                    const view = scroller.getBoundingClientRect();
                    return row.top >= view.top - 1 && row.bottom <= view.bottom + 1;
                })).toBe(true);
                const previews = await list.locator('.sb-chat-file-preview').allTextContents();
                expect(previews.every(preview => preview !== 'undefined')).toBe(true);
                expect(await panel.locator('.sb-chat-sidebar-body').evaluate(body => getComputedStyle(body).paddingTop)).toBe('8px');
            }

            const geometry = await readGeometry(page, panel);
            expect(geometry.side).toBe(definition.side);
            expect(geometry.panel.top).toBeGreaterThanOrEqual(geometry.topBarBottom - 1);
            expect(geometry.intersectsChat).toBe(false);
            expect(geometry.intersectsComposer).toBe(false);
            if (viewport.width === 1440 && viewport.height === 900) {
                expect(Math.abs(geometry.panel.top - geometry.chatRect.top)).toBeLessThanOrEqual(2);
                expect(Math.abs(geometry.panel.bottom - geometry.chatRect.bottom)).toBeLessThanOrEqual(2);
            }
            if (geometry.mode === 'sheet') {
                await expect(panel.locator(':scope > .sb-dialog__handle')).toBeVisible();
                expect(geometry.panel.height).toBeLessThanOrEqual(viewport.height * 0.5 + 1);
                await page.locator('#send_textarea').fill('Composer remains usable above the panel sheet');
                await expect(page.locator('#send_textarea')).toHaveValue('Composer remains usable above the panel sheet');
                await page.locator('#send_textarea').fill('');
            } else if (viewport.width >= 1280) {
                expect(Math.abs(geometry.chat.left - geometry.initialChat.left)).toBeLessThan(1);
                expect(Math.abs(geometry.chat.width - geometry.initialChat.width)).toBeLessThan(1);
            }

            await closePanel(page, definition.id);
        }
    });
}

test('two real panels split one side while Visual Novel sprites stay in the free chat area', async ({ page }) => {
    await boot(page, { width: 1440, height: 900 });
    await page.route('**/api/chats/group/info', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/group/get', route => route.fulfill({ json: [
        { chat_metadata: { tainted: true } },
        { name: 'Seraphina', original_avatar: 'default_Seraphina.png', is_user: false, is_system: false, send_date: '2026-10-23', mes: 'Visual Novel sprite layout fixture' },
    ] }));
    await page.route('**/api/chats/group/save', route => route.fulfill({ json: {} }));
    await page.route(/\/api\/sprites\/get(?:\?.*)?$/, route => route.fulfill({ json: [
        { label: 'caring', path: '/qa-side-panel-vn-sprite.png' },
    ] }));
    await page.route('**/qa-side-panel-vn-sprite.png', route => route.fulfill({ contentType: 'image/png', body: readFileSync(new URL('../default/content/Seraphina/caring.png', import.meta.url)) }));

    const fixture = await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const character = context.characters[context.characterId];
        if (!character?.avatar) throw new Error('The Visual Novel fixture needs the selected sample character.');
        delete context.powerUserSettings?.movingUIState?.[`expression-${character.avatar}`];
        context.extensionSettings.expressions.api = 'none';
        context.extensionSettings.expressions.fallback_expression = 'caring';

        const groupChats = await import('/scripts/group-chats.js');
        const group = {
            id: 'qa-side-panel-visual-novel-group',
            name: 'QA side-panel Visual Novel group',
            members: [character.avatar],
            disabled_members: [],
            member_models: {},
            avatar_url: '',
            chat_id: 'qa-side-panel-visual-novel-chat',
            chats: ['qa-side-panel-visual-novel-chat'],
            activation_strategy: 0,
            generation_mode: 0,
            allow_self_responses: false,
            hideMutedSprites: false,
        };
        groupChats.groups.push(group);

        const visualNovelToggle = document.getElementById('waifuMode');
        visualNovelToggle.checked = true;
        visualNovelToggle.dispatchEvent(new Event('change', { bubbles: true }));
        if (!await groupChats.openGroupById(group.id, { switchMenu: false })) {
            throw new Error('The Visual Novel fixture group could not be opened.');
        }

        return { characterName: character.name, avatar: character.avatar };
    });
    await page.waitForFunction(() => {
        const wrapper = document.getElementById('visual-novel-wrapper');
        return document.body.classList.contains('waifuMode') && wrapper && getComputedStyle(wrapper).display !== 'none';
    });
    await page.evaluate(async name => {
        const expressions = await import('/scripts/extensions/expressions/index.js');
        await expressions.sendExpressionCall(name, 'caring');
    }, fixture.characterName);
    const spriteImage = page.locator('#visual-novel-wrapper .expression-holder img[src="/qa-side-panel-vn-sprite.png"]');
    await expect(spriteImage).toBeVisible();
    await expect.poll(() => spriteImage.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);

    await page.evaluate(async () => {
        const sidePanels = window.SillyBunnySidePanels;
        await sidePanels.openSidePanel('floatingPrompt');
        await sidePanels.openSidePanel('cfgConfig');
    });
    const leftPanels = page.locator('.sb-side-panel[data-sb-side-panel-side="left"]:visible');
    await expect(leftPanels).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => {
        const wrapper = document.getElementById('visual-novel-wrapper');
        const sprite = document.querySelector('#visual-novel-wrapper .expression-holder:not(.hidden)');
        if (!wrapper || !sprite) return false;
        const wrapperRect = wrapper.getBoundingClientRect();
        const spriteRect = sprite.getBoundingClientRect();
        return spriteRect.left >= wrapperRect.left - 1 && spriteRect.right <= wrapperRect.right + 1;
    })).toBe(true);
    const geometry = await page.evaluate(() => {
        const panels = [...document.querySelectorAll('.sb-side-panel[data-sb-side-panel-side="left"]:not([hidden])')]
            .map(panel => panel.getBoundingClientRect());
        const chat = document.getElementById('sheld').getBoundingClientRect();
        const wrapper = document.getElementById('visual-novel-wrapper');
        const sprite = wrapper.querySelector('.expression-holder:not(.hidden)');
        const spriteImage = [...sprite.querySelectorAll('img')].find(image => new URL(image.src).pathname === '/qa-side-panel-vn-sprite.png');
        const spriteRect = sprite.getBoundingClientRect();
        const panel = document.querySelector('.sb-side-panel[data-sb-side-panel-id="floatingPrompt"]');
        const wrapperRect = wrapper.getBoundingClientRect();
        const topBarRect = document.getElementById('top-bar').getBoundingClientRect();
        return {
            panels: panels.map(rect => ({ top: rect.top, bottom: rect.bottom, height: rect.height })),
            chat: { left: chat.left, right: chat.right, top: chat.top, bottom: chat.bottom, width: chat.width },
            wrapper: { left: wrapperRect.left, right: wrapperRect.right, top: wrapperRect.top, bottom: wrapperRect.bottom, width: wrapperRect.width },
            sprite: { left: spriteRect.left, right: spriteRect.right, top: spriteRect.top, bottom: spriteRect.bottom },
            freeArea: { left: chat.left, right: chat.right, top: topBarRect.bottom, bottom: window.innerHeight },
            spriteLoaded: spriteImage?.naturalWidth > 0,
            visualNovelEnabled: document.body.classList.contains('waifuMode'),
            panelZ: Number(getComputedStyle(panel).zIndex),
            spriteZ: Number(getComputedStyle(sprite).zIndex),
        };
    });
    expect(Math.abs(geometry.panels[0].height - geometry.panels[1].height)).toBeLessThan(1);
    expect(Math.abs(geometry.panels[0].bottom - geometry.panels[1].top)).toBeLessThan(1);
    expect(Math.abs(geometry.wrapper.left - geometry.chat.left)).toBeLessThan(1);
    expect(Math.abs(geometry.wrapper.width - geometry.chat.width)).toBeLessThan(1);
    expect(Math.abs(geometry.wrapper.right - geometry.chat.right)).toBeLessThan(1);
    expect(geometry.wrapper.top).toBeGreaterThanOrEqual(geometry.freeArea.top - 1);
    expect(geometry.wrapper.bottom).toBeLessThanOrEqual(geometry.freeArea.bottom + 1);
    expect(geometry.visualNovelEnabled).toBe(true);
    expect(geometry.spriteLoaded).toBe(true);
    expect(geometry.sprite.left).toBeGreaterThanOrEqual(geometry.freeArea.left - 1);
    expect(geometry.sprite.right).toBeLessThanOrEqual(geometry.freeArea.right + 1);
    expect(geometry.sprite.top).toBeGreaterThanOrEqual(geometry.freeArea.top - 1);
    expect(geometry.sprite.bottom).toBeLessThanOrEqual(geometry.freeArea.bottom + 1);
    expect(geometry.panelZ).toBeGreaterThan(geometry.spriteZ);
});

test('real panels return focus and Escape closes Token Probabilities, CFG, then Author\'s Note', async ({ page }) => {
    await boot(page, { width: 1440, height: 900 });
    await page.evaluate(() => {
        const opener = document.createElement('button');
        opener.id = 'qa-side-panel-focus-opener';
        opener.textContent = 'Open real panel';
        document.body.append(opener);
        opener.focus();
        window.qaSidePanelOpener = opener;
    });
    await page.evaluate(() => window.SillyBunnySidePanels.openSidePanel('floatingPrompt', { opener: window.qaSidePanelOpener }));
    const authorsNote = page.locator('.sb-side-panel[data-sb-side-panel-id="floatingPrompt"]');
    await expect(authorsNote).toBeVisible();
    await expect(authorsNote.locator('#extension_floating_prompt')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(authorsNote).toBeHidden();
    await expect(page.locator('#qa-side-panel-focus-opener')).toBeFocused();

    await page.evaluate(async () => {
        await window.SillyBunnySidePanels.openSidePanel('logprobsViewer');
        await window.SillyBunnySidePanels.openSidePanel('cfgConfig');
        await window.SillyBunnySidePanels.openSidePanel('floatingPrompt');
    });
    const token = page.locator('.sb-side-panel[data-sb-side-panel-id="logprobsViewer"]');
    const cfg = page.locator('.sb-side-panel[data-sb-side-panel-id="cfgConfig"]');
    await expect(token).toBeVisible();
    await expect(cfg).toBeVisible();
    await expect(authorsNote).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(token).toBeHidden();
    await expect(cfg).toBeVisible();
    await expect(authorsNote).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(cfg).toBeHidden();
    await expect(authorsNote).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(authorsNote).toBeHidden();
});

test('Author\'s Note and CFG keep their existing metadata and settings save contracts', async ({ page }) => {
    await boot(page, { width: 1440, height: 900 });
    const saved = { settings: [], chats: [] };
    await page.route('**/api/settings/save', async route => {
        const payload = readPayload(route.request());
        saved.settings.push({ note: payload.extension_settings?.note, cfg: payload.extension_settings?.cfg });
        return route.fulfill({ json: { result: 'ok', version: Number(payload._version ?? 0) + 1 } });
    });
    await page.route('**/api/chats/save', async route => {
        const payload = readPayload(route.request());
        const metadata = payload.chat?.[0]?.chat_metadata ?? {};
        saved.chats.push(Object.fromEntries(Object.entries(metadata).filter(([key]) => key.startsWith('note_') || key.startsWith('cfg_'))));
        return route.fulfill({ json: {} });
    });

    const before = await page.evaluate(async () => {
        const core = await import('/script.js');
        const extensions = await import('/scripts/extensions.js');
        return {
            metadata: { ...core.chat_metadata },
            note: structuredClone(extensions.extension_settings.note),
            cfg: structuredClone(extensions.extension_settings.cfg),
        };
    });

    await page.locator('#option_toggle_AN').evaluate(button => button.click());
    await expect(page.locator('.sb-side-panel[data-sb-side-panel-id="floatingPrompt"]')).toBeVisible();
    await page.locator('#extension_floating_prompt').fill('Adapter chat note');
    await page.locator('#extension_floating_depth').fill('6');
    await page.locator('#extension_floating_role').selectOption('2');
    await page.locator('#extension_floating_allow_wi_scan').check();
    await page.locator('#extension_floating_interval').fill('5');
    await page.locator('#extension_floating_chara').fill('Adapter character note');
    await page.locator('#extension_use_floating_chara').check();
    await page.locator('input[name="extension_floating_char_position"][value="2"]').evaluate(input => {
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('#extension_floating_default').fill('Adapter default note');
    await page.locator('#extension_default_position_depth').evaluate(input => {
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#extension_default_depth').fill('9');
    await page.locator('#extension_default_role').selectOption('1');
    await page.locator('#extension_default_position_before').evaluate(input => {
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#extension_default_interval').fill('4');

    const positionVisibility = await page.evaluate(async () => {
        const { executeSlashCommandsWithOptions } = await import('/scripts/slash-commands.js');
        const mainDepthRow = document.querySelector('.ds-row[data-sb-editor-field="authors-note-main-depth"]');
        const mainRoleRow = document.querySelector('.ds-row[data-sb-editor-field="authors-note-main-role"]');
        await executeSlashCommandsWithOptions('/note-position before');
        const hiddenAfterSlashCommand = mainDepthRow.hidden && mainRoleRow.hidden;
        await executeSlashCommandsWithOptions('/note-position chat');
        return { hiddenAfterSlashCommand, mainDepth: mainDepthRow.hidden, mainRole: mainRoleRow.hidden };
    });
    expect(positionVisibility.hiddenAfterSlashCommand).toBe(true);
    expect(positionVisibility.mainDepth).toBe(false);
    expect(positionVisibility.mainRole).toBe(false);
    await page.locator('input[name="extension_floating_position"][value="1"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('input[name="extension_floating_position"][value="2"]')).toBeChecked();
    await expect(page.locator('.ds-row[data-sb-editor-field="authors-note-main-depth"]')).toBeHidden();
    await page.evaluate(async () => (await import('/scripts/slash-commands.js')).executeSlashCommandsWithOptions('/note-position chat'));
    await expect(page.locator('.ds-row[data-sb-editor-field="authors-note-main-depth"]')).toBeVisible();

    await page.locator('input[name="extension_floating_char_position"][value="2"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('input[name="extension_floating_char_position"][value="0"]')).toBeChecked();
    await page.locator('input[name="extension_floating_char_position"][value="2"]').evaluate(input => {
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await page.locator('#option_toggle_CFG').evaluate(button => button.click());
    await expect(page.locator('.sb-side-panel[data-sb-side-panel-id="cfgConfig"]')).toBeVisible();
    await page.locator('#chat_cfg_negative_prompt').fill('Chat negative prompt');
    await page.locator('#chat_cfg_positive_prompt').fill('Chat positive prompt');
    await page.locator('#chara_cfg_negative_prompt').fill('Character negative prompt');
    await page.locator('#global_cfg_negative_prompt').fill('Global negative prompt');
    await page.locator('#cfg_prompt_separator').fill(' | ');
    await page.locator('#cfg_prompt_insertion_depth').fill('7');
    await page.locator('input[name="cfg_prompt_combine"][value="1"]').check();
    await page.locator('#chat_cfg_guidance_scale_counter').evaluate(input => {
        input.value = '1.5';
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#chat_cfg_guidance_scale')).toHaveValue('1.5');
    await page.locator('#chat_cfg_guidance_scale').evaluate(range => {
        range.value = '1.75';
        range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#chat_cfg_guidance_scale_counter')).toHaveValue('1.75');
    await page.locator('#global_cfg_guidance_scale').evaluate(range => {
        range.value = '2.25';
        range.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await expect.poll(() => saved.chats.some(metadata => metadata.note_prompt === 'Adapter chat note'
        && metadata.note_position === 1
        && metadata.note_depth === 6
        && metadata.note_role === 2
        && metadata.note_interval === 5
        && metadata.cfg_negative_prompt === 'Chat negative prompt'
        && metadata.cfg_positive_prompt === 'Chat positive prompt'
        && metadata.cfg_guidance_scale === 1.75
        && metadata.cfg_prompt_insertion_depth === 7
        && metadata.cfg_prompt_separator === ' | '
        && metadata.cfg_prompt_combine?.includes(1))).toBe(true);
    await expect.poll(() => saved.settings.some(settings => {
        const note = settings.note;
        const cfg = settings.cfg;
        return note?.default === 'Adapter default note'
            && note.defaultPosition === 2
            && note.defaultDepth === 9
            && note.defaultRole === 1
            && note.defaultInterval === 4
            && note.allowWIScan === true
            && note.chara?.some(entry => entry.prompt === 'Adapter character note' && entry.useChara && entry.position === 2)
            && cfg?.chara?.some(entry => entry.negative_prompt === 'Character negative prompt')
            && cfg?.global?.negative_prompt === 'Global negative prompt'
            && cfg.global.guidance_scale === 2.25;
    })).toBe(true);

    expect(before.metadata.note_prompt).not.toBe('Adapter chat note');
    expect(before.note.default).not.toBe('Adapter default note');
    expect(before.cfg.global.negative_prompt).not.toBe('Global negative prompt');
});

function readPayload(request) {
    const buffer = request.postDataBuffer();
    const body = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(buffer) : buffer;
    return JSON.parse(body.toString());
}
