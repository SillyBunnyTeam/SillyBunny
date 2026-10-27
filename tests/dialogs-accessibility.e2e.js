/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- A modal and a non-modal surface, and a floating and a sheet layout, take different checks. */
import { expect, test } from '@playwright/test';
import { dialog as archiveDialog, isCollapsed, rows, waitForDetail } from './helpers/chats-archive.js';
import { a11yShot, expectSingleFocusRing, settleTransitions, tabUntil, walkTabOrder } from './helpers/dialog-accessibility.js';
import { DESKTOP, SURFACES, TEXT_SCALE, bootMisc, openArchiveList, pressKey } from './helpers/dialog-accessibility-surfaces.js';

/**
 * Accessibility checks for the dialog frame, the Chat Archive, action-menu sheets and side panels:
 * keyboard only, forced colours and 200% text. Run with SILLYBUNNY_A11Y_SHOTS=<dir> to keep screenshots.
 *
 * Motion is off (`reduced_motion` true and `prefers-reduced-motion: reduce`) everywhere except the
 * `with motion` test, because a running transition makes a computed colour or box a half-way value, and
 * a closing dialog keeps `[open]` until its animation ends. The `with motion` test covers that closing path.
 *
 * Text size: the app scales text through `power_user.font_scale`, which sets `--fontScale` and so
 * `--mainFontSize`. The settings slider stops at 1.5, but the stored value is applied as it is, so the
 * 200% checks set it to 2 in the intercepted settings. A root `font-size: 200%` changes nothing in the
 * dialogs, because their text does not use rem.
 *
 * Opening: where a step before the trigger is programmatic, the surface says why. Triggers are pressed
 * with Enter, the way a keyboard user does; the `Enter` tests below cover the double click that once
 * made that unsafe for a real `<button>`.
 */

// Elements that shorten their text with an ellipsis on purpose (a title, or the value shown in a select row).
// Everything else must show its full label.
const ELLIPSIZING = ['.sb-dialog__title', '.sb-dialog__subtitle', '.ds-select-row__trigger'];

// --- Checks ---------------------------------------------------------------------------------------------

/** The alpha of a computed colour string such as `rgb(0, 0, 0)` or `color(srgb 0 0 0 / 0.5)`. */
function alphaOf(colour) {
    const slash = colour.match(/\/\s*([\d.]+%?)\s*\)$/);
    if (slash) return slash[1].endsWith('%') ? parseFloat(slash[1]) / 100 : parseFloat(slash[1]);
    const legacy = colour.match(/^rgba\(([^)]+)\)$/);
    return legacy && legacy[1].split(',').length > 3 ? parseFloat(legacy[1].split(',')[3]) : 1;
}

const insideOnly = stops => stops.filter(stop => stop.kind === 'element' && stop.inside);
const outsideLabels = stops => stops.filter(stop => stop.kind === 'element' && !stop.inside).map(stop => stop.label);
const focusStateOf = (page, surface) => page.evaluate(selector => window.sbA11y.focusState(selector), surface.rootSelector);

function focusProblems(stops, { forcedColours = false } = {}) {
    const shown = insideOnly(stops);
    const missing = shown
        .filter(stop => !(forcedColours ? stop.outline : stop.outline || stop.shadow))
        .map(stop => `${stop.label} outline ${stop.outlineDetail}, shadow ${stop.shadowDetail}`);
    // Forced colours paint no shadow, so two rings only exist in the normal rendering.
    const doubled = forcedColours ? [] : shown
        .filter(stop => stop.outline && stop.insetRing)
        .map(stop => `${stop.label} draws an outline (${stop.outlineDetail}) and a shadow ring (${stop.shadowDetail})`);
    // A ring in the colour of the control's own fill is invisible, as on a checked segment filled with Highlight.
    const hidden = shown
        .filter(stop => stop.outlineOnFill)
        .map(stop => `${stop.label} outline ${stop.outlineDetail} has the colour of its fill ${stop.fillDetail}`);
    return [...missing, ...doubled, ...hidden];
}

/** Tab through a modal until the focus wraps; through a panel until it leaves. */
function walkSurface(page, surface) {
    return surface.modal
        ? walkTabOrder(page, surface.rootSelector)
        : walkTabOrder(page, surface.rootSelector, { untilOutside: true });
}

async function expectTabStaysInside(page, surface) {
    const forward = await walkSurface(page, surface);
    expect(forward.wrapped, 'Tab wraps inside the modal').toBe(true);
    expect(outsideLabels(forward.stops), 'Tab reached the page behind').toEqual([]);
    const backward = await walkTabOrder(page, surface.rootSelector, { backwards: true });
    expect(backward.wrapped, 'Shift+Tab wraps inside the modal').toBe(true);
    expect(outsideLabels(backward.stops), 'Shift+Tab reached the page behind').toEqual([]);
}

async function pressEscapeSteps(page, surface, context, opener) {
    if (surface.pushPage) await surface.pushPage(page);
    for (const step of surface.escapes) {
        await pressKey(page, 'Escape');
        if (step.closes) await expect(surface.isOpen(page)).toHaveCount(0);
        await step.check(page, context);
        const target = step.closes ? opener : step.focus(page);
        const active = await page.evaluate(() => window.sbA11y.focusState('body'));
        await expect(target, `focus after Escape is on ${active.label ?? 'the document'}`).toBeFocused();
    }
}

for (const surface of SURFACES) {
    test.describe(`${surface.title}`, () => {
        for (const viewport of surface.viewports) {
            const size = `${viewport.width}×${viewport.height}`;

            test.describe(size, () => {
                test('keyboard: opens with focus inside, and Tab and Shift+Tab stay inside a modal', async ({ page, baseURL }) => {
                    const context = await surface.boot(page, baseURL, viewport, { motion: false });
                    await surface.open(page, context);
                    const initial = await focusStateOf(page, surface);
                    expect.soft(initial.inside, `initial focus is ${initial.label ?? 'the document'}`).toBe(true);
                    if (!surface.modal) {
                        const forward = await walkSurface(page, surface);
                        expect(forward.leftRoot, 'Tab leaves a non-modal panel').toBe(true);
                        await pressKey(page, 'Shift+Tab');
                        expect((await focusStateOf(page, surface)).inside, 'Shift+Tab returns into the panel').toBe(true);
                        return;
                    }
                    await expectTabStaysInside(page, surface);
                    if (surface.pushPage) {
                        await surface.pushPage(page);
                        const onPage = await focusStateOf(page, surface);
                        expect.soft(onPage.inside, `focus after the page is pushed is ${onPage.label ?? 'the document'}`).toBe(true);
                        await expectTabStaysInside(page, surface);
                    }
                });

                test('keyboard: every Tab stop shows a focus indicator', async ({ page, baseURL }) => {
                    const context = await surface.boot(page, baseURL, viewport, { motion: false });
                    await surface.open(page, context);
                    const { stops } = await walkSurface(page, surface);
                    expect(insideOnly(stops).length, 'focusable stops').toBeGreaterThan(0);
                    expect(focusProblems(stops)).toEqual([]);
                });

                test('keyboard: Escape closes or pops one level and focus returns to the opener', async ({ page, baseURL }) => {
                    const context = await surface.boot(page, baseURL, viewport, { motion: false });
                    const opener = await surface.open(page, context);
                    await pressEscapeSteps(page, surface, context, opener);
                    await expect(surface.isOpen(page)).toHaveCount(0);
                });

                test('keyboard with motion: Escape closes through the closing animation and focus returns', async ({ page, baseURL }) => {
                    const context = await surface.boot(page, baseURL, viewport, { motion: true });
                    const opener = await surface.open(page, context);
                    await pressEscapeSteps(page, surface, context, opener);
                    await expect(surface.isOpen(page)).toHaveCount(0);
                });

                if (surface.destructive) {
                    test('keyboard: Return with Cancel focused does not confirm', async ({ page, baseURL }) => {
                        const context = await surface.boot(page, baseURL, viewport, { motion: false });
                        await surface.open(page, context);
                        await expect(surface.cancel(page), 'Cancel has the focus on open').toBeFocused();
                        await pressKey(page, 'Enter');
                        await expect(surface.isOpen(page)).toHaveCount(0);
                        expect(await surface.wasConfirmed(page, context)).toBe(false);
                    });
                }

                test('forced colours: frame boundary, text and selection checks stay visible', async ({ page, baseURL }) => {
                    const context = await surface.boot(page, baseURL, viewport, { motion: false });
                    await page.emulateMedia({ forcedColors: 'active' });
                    await surface.open(page, context);
                    for (const state of surface.states) {
                        await state.enter(page, context);
                        await settleTransitions(page);
                        await a11yShot(page, `forced-colours-${surface.id}-${viewport.width}-${state.name}`);
                        const report = await page.evaluate(([root, frame]) => window.sbA11y.forcedColours(root, frame), [surface.rootSelector, surface.frameSelector]);
                        expect.soft(report.frame, `${state.name}: frame boundary`).toEqual([]);
                        expect.soft(report.text, `${state.name}: transparent text`).toEqual([]);
                        if (state.name === 'selection') {
                            const checks = await page.evaluate(selector => window.sbA11y.selectionChecks(selector), surface.rootSelector);
                            const checked = checks.find(check => check.checked);
                            const unchecked = checks.find(check => !check.checked);
                            expect(checked, 'a checked selection check').toBeDefined();
                            expect(unchecked, 'an unchecked selection check').toBeDefined();
                            expect.soft(unchecked.boundary, 'unchecked check has a boundary').toBe(true);
                            expect.soft(checked.boundary, 'checked check has a boundary').toBe(true);
                            expect.soft(checked.fill, 'checked fill differs from unchecked').not.toBe(unchecked.fill);
                            expect.soft(checked.glyphFill, 'check glyph differs from its fill').not.toBe(checked.fill);
                        }
                    }
                });

                test('forced colours: buttons, switches and the focus ring stay visible', async ({ page, baseURL }) => {
                    const context = await surface.boot(page, baseURL, viewport, { motion: false });
                    await page.emulateMedia({ forcedColors: 'active' });
                    await surface.open(page, context);
                    for (const state of surface.states) {
                        await state.enter(page, context);
                        await settleTransitions(page);
                        const report = await page.evaluate(([root, frame]) => window.sbA11y.forcedColours(root, frame), [surface.rootSelector, surface.frameSelector]);
                        expect.soft(report.controls, `${state.name}: control boundaries or fills`).toEqual([]);
                        expect.soft(report.selected, `${state.name}: selected segment`).toEqual([]);
                        const { stops } = await walkSurface(page, surface);
                        expect.soft(focusProblems(stops, { forcedColours: true }), `${state.name}: focus indicator`).toEqual([]);
                    }
                });

                test('200% text: no label is clipped', async ({ page, baseURL }) => {
                    const context = await surface.boot(page, baseURL, viewport, { motion: false, fontScale: TEXT_SCALE });
                    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fontScale').trim()), 'the app applied the text scale').toBe(String(TEXT_SCALE));
                    await surface.open(page, context);
                    for (const state of surface.states) {
                        await state.enter(page, context);
                        await settleTransitions(page);
                        await a11yShot(page, `text-200-${surface.id}-${viewport.width}-${state.name}`);
                        const report = await page.evaluate(([root, ellipsizing]) => window.sbA11y.scale(root, ellipsizing), [surface.rootSelector, ELLIPSIZING]);
                        expect.soft(report.clipped, `${state.name}: clipped labels`).toEqual([]);
                    }
                });

                test('200% text: header controls, responses and the last content stay usable', async ({ page, baseURL }) => {
                    const context = await surface.boot(page, baseURL, viewport, { motion: false, fontScale: TEXT_SCALE });
                    await surface.open(page, context);
                    for (const state of surface.states) {
                        await state.enter(page, context);
                        await settleTransitions(page);
                        const report = await page.evaluate(([root, ellipsizing]) => window.sbA11y.scale(root, ellipsizing), [surface.rootSelector, ELLIPSIZING]);
                        expect.soft(report.insideViewport, `${state.name}: frame inside the viewport`).toBe(true);
                        expect.soft(report.overlaps, `${state.name}: overlapping header controls`).toEqual([]);
                        expect.soft(report.responseCount, `${state.name}: responses found`).toBeGreaterThan(0);
                        expect.soft(report.responses, `${state.name}: responses visible`).toEqual([]);
                        const last = await page.evaluate(selector => window.sbA11y.lastContent(selector), surface.rootSelector);
                        expect.soft(last.problems, `${state.name}: last content reachable`).toEqual([]);
                        await a11yShot(page, `text-200-${surface.id}-${viewport.width}-${state.name}-end`);
                    }
                });
            });
        }
    });
}

test.describe('One focus ring on a .menu_button', () => {
    test('a Presets action button shows one ring, not an outline beside the shared ring', async ({ page, baseURL }) => {
        await bootMisc(page, baseURL, DESKTOP, { motion: false });
        await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'prompting'));
        const action = page.locator('#sb-settings-page .sb-action-btn:visible').first();
        await expect(action).toBeVisible();
        await expect(action).toHaveClass(/menu_button/);
        await expectSingleFocusRing(page, action);
    });
});

test.describe('Forced colours keep a focus indicator on controls that hide their outline', () => {
    test('the composer buttons and the Options and Extensions menu rows', async ({ page, baseURL }) => {
        await bootMisc(page, baseURL, DESKTOP, { motion: false });
        await page.emulateMedia({ forcedColors: 'active' });
        const indicatorOf = control => control.evaluate(element => {
            const style = getComputedStyle(element);
            return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), colour: style.outlineColor };
        });
        const expectIndicator = async (control, name) => {
            await page.keyboard.press('Shift');
            await control.focus();
            await expect(control, `${name} has the focus`).toBeFocused();
            const indicator = await indicatorOf(control);
            expect(indicator.style, `${name} outline style`).not.toBe('none');
            expect(indicator.width, `${name} outline width`).toBeGreaterThan(0);
            expect(alphaOf(indicator.colour), `${name} outline colour ${indicator.colour}`).toBeGreaterThan(0);
        };
        await expectIndicator(page.locator('#send_form .menu_button:not(#send_but):visible').first(), '#send_form .menu_button');
        await page.locator('#options_button').click();
        await expectIndicator(page.locator('#options .options-content a:visible').first(), '#options row');
        await page.keyboard.press('Escape');
        await page.locator('#extensionsMenuButton').click();
        await expectIndicator(page.locator('#extensionsMenu > .extension_container > div:visible').first(), '#extensionsMenu row');
    });
});

test.describe('Enter on a real button', () => {
    const openDataSecurity = async (page, baseURL) => {
        await bootMisc(page, baseURL, DESKTOP, { motion: false });
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
    };

    test('activates it once', async ({ page, baseURL }) => {
        await openDataSecurity(page, baseURL);
        const trigger = page.locator('#clear_cookies_cache_button');
        await expect(trigger).toBeVisible();
        await page.waitForFunction(() => document.getElementById('clear_cookies_cache_button')?.dataset.sbCookiesCacheBound === 'true');
        await page.evaluate(() => {
            window.sbA11yClicks = 0;
            document.addEventListener('click', () => { window.sbA11yClicks++; }, true);
        });
        await trigger.focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => page.evaluate(() => window.sbA11yClicks)).toBe(1);
    });

    test('Change Password opens exactly one popup', async ({ page, baseURL }) => {
        await openDataSecurity(page, baseURL);
        const accountButton = page.locator('#account_button');
        await expect(accountButton).toBeVisible();
        await accountButton.focus();
        await page.keyboard.press('Enter');
        const changePassword = page.locator('dialog[open] .userChangePasswordButton');
        await expect(changePassword).toBeVisible();
        await changePassword.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('dialog[open] input[name="confirm"]')).toHaveCount(1);
        // A second click would land on the new popup or open another one, so give it time to arrive.
        await settleTransitions(page);
        await expect(page.locator('dialog[open] input[name="confirm"]')).toHaveCount(1);
        await expect(page.locator('dialog[open]:not([closing])')).toHaveCount(2);
    });

    test('Clear cookies and cache opens its alert and leaves it open', async ({ page, baseURL }) => {
        await openDataSecurity(page, baseURL);
        const trigger = page.locator('#clear_cookies_cache_button');
        await expect(trigger).toBeVisible();
        await page.waitForFunction(() => document.getElementById('clear_cookies_cache_button')?.dataset.sbCookiesCacheBound === 'true');
        await trigger.focus();
        await page.keyboard.press('Enter');
        const alert = page.getByRole('alertdialog');
        await expect(alert).toBeVisible();
        await settleTransitions(page);
        await expect(alert).toBeVisible();
        await expect(page.locator('dialog[open]:not([closing])')).toHaveCount(1);
    });

    test('an element that is only an .interactable still activates once', async ({ page, baseURL }) => {
        await bootMisc(page, baseURL, DESKTOP, { motion: false });
        const trigger = page.locator('#options_button');
        await expect(trigger).toHaveJSProperty('tagName', 'DIV');
        await page.evaluate(() => {
            window.sbA11yClicks = 0;
            document.addEventListener('click', event => { if (event.target.id === 'options_button') window.sbA11yClicks++; }, true);
        });
        await trigger.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#options')).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.sbA11yClicks)).toBe(1);
    });
});

test.describe('Chat Archive keyboard navigation', () => {
    const archive = SURFACES.find(surface => surface.id === 'chat-archive');

    for (const viewport of archive.viewports) {
        test(`${viewport.width}×${viewport.height}: sidebar and list arrows, Enter opens a chat, Back returns to its row, selection mode`, async ({ page, baseURL }) => {
            const context = await archive.boot(page, baseURL, viewport, { motion: false });
            const opener = await archive.open(page, context);

            const locations = page.locator('.sbca-location');
            await tabUntil(page, '.sbca-location');
            await expect(locations.first()).toBeFocused();
            await pressKey(page, 'ArrowDown');
            await expect(locations.nth(1)).toBeFocused();
            await pressKey(page, 'End');
            await expect(locations.last()).toBeFocused();
            await pressKey(page, 'Home');
            await expect(locations.first()).toBeFocused();

            const collapsed = await isCollapsed(page);
            await openArchiveList(page);
            await tabUntil(page, '.sbca-row');
            const reached = await page.evaluate(() => [...document.querySelectorAll('.sbca-row')].indexOf(document.activeElement));
            expect(reached, 'Tab reached a row').toBeGreaterThanOrEqual(0);
            await pressKey(page, 'ArrowDown');
            await expect(rows(page).nth(reached + 1)).toBeFocused();
            await pressKey(page, 'ArrowUp');
            await expect(rows(page).nth(reached)).toBeFocused();

            const key = await rows(page).nth(reached).getAttribute('data-sbca-key');
            await pressKey(page, 'Enter');
            await waitForDetail(page);
            await settleTransitions(page);
            await page.locator('.sbca-dialog .sb-dialog__back').last().focus();
            await page.keyboard.press('Space');
            await expect.poll(() => page.evaluate(() => document.activeElement?.dataset?.sbcaKey ?? '')).toBe(key);

            const menuButton = page.locator('.sbca-dialog .sb-dialog__header:visible .sb-dialog__menu').last();
            await menuButton.focus();
            await page.keyboard.press('Space');
            const select = page.getByRole('menuitem', { name: 'Select Chats' });
            await expect(select).toBeVisible();
            await select.focus();
            await pressKey(page, 'Enter');
            await expect(page.locator('.sbca-dialog .sb-dialog__header.is-selection-mode')).toBeVisible();
            await settleTransitions(page);
            await rows(page).first().focus();
            await pressKey(page, 'Enter');
            await expect(page.locator('.sbca-row .sb-selection-check:checked')).toHaveCount(1);
            await pressKey(page, 'Escape');
            await expect(page.locator('.sbca-row .sb-selection-check')).toHaveCount(0);
            await expect(archiveDialog(page)).toBeVisible();

            await pressKey(page, 'Escape');
            if (collapsed) {
                await expect(page.locator('.sbca-location').first()).toBeVisible();
                await pressKey(page, 'Escape');
            }
            await expect(archiveDialog(page)).toBeHidden();
            await expect(opener).toBeFocused();
        });
    }
});

test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    await a11yShot(page, `failed-${testInfo.titlePath.slice(1).join('-').replace(/\W+/g, '-').slice(0, 120)}`);
});
