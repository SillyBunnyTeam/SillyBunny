/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- A modal and a non-modal surface, and a floating and a sheet layout, take different checks. */
import { expect, test } from '@playwright/test';
import { dialog as archiveDialog, isCollapsed, rows, waitForDetail } from './helpers/chats-archive.js';
import { a11yShot, settleTransitions, tabUntil, walkTabOrder } from './helpers/dialog-accessibility.js';
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
 * Opening: where a step before the trigger is programmatic, the surface says why. Real `<button>`
 * triggers are pressed with Space, because Enter activates them twice (see the `Enter` test below).
 */

// Elements that shorten their text with an ellipsis on purpose (a title, or the value shown in a select row).
// Everything else must show its full label.
const ELLIPSIZING = ['.sb-dialog__title', '.sb-dialog__subtitle', '.ds-select-row__trigger'];

const NO_FOCUS_RING = 'Defect: a focused .menu_button (including the Popup OK and Cancel buttons) has outline-style none and box-shadow none. A rule matching .menu_button:not(.sb-status-page__action):not(.disabled)...:focus-visible sets box-shadow: none, so the only cue is a 1px accent border at 40% alpha and a 4% fill step.';
const FLAT_CONTROLS = 'Defect: under forced colours, flat controls (header icon buttons, .menu_button actions, menu items, sidebar rows) have no border and no fill, so their boundary disappears.';
const NO_FORCED_RING = 'Defect: under forced colours, rows and menu items show focus only through a box-shadow ring, which forced colours removes, and there is no outline fallback.';

/**
 * Cases that fail today because of a product defect, keyed `surface|width|check`. Each runs under
 * `test.fail()`, so the suite stays green and a fix shows up as an unexpected pass.
 */
const KNOWN_DEFECTS = new Map([
    ...[1440, 390].flatMap(width => [
        [`popup-alert|${width}|focus`, NO_FOCUS_RING],
        [`open-alert|${width}|focus`, NO_FOCUS_RING],
        [`popup-dialog|${width}|focus`, NO_FOCUS_RING],
        [`tag-manager|${width}|focus`, NO_FOCUS_RING],
        [`open-alert|${width}|escape`, 'Defect: after Cancel or Escape on the Clear cookies & cache alert, the focus is on the document, not the trigger. The trigger button is disabled while the alert is open, and the browser cannot restore focus to a disabled element.'],
        [`tag-manager|${width}|tab`, 'Defect: pushing a page in the Tag Manager (Enter on a tag row) leaves the focus on the document. The row that held it is hidden, and nothing moves the focus into the new page.'],
        [`tag-manager|${width}|forced-controls`, FLAT_CONTROLS],
        [`side-panel|${width}|escape`, 'Defect: closing Author\'s Note with Escape leaves the focus on the document. The panel returns it to the Options menu item that opened it, and that menu is already closed.'],
        [`side-panel|${width}|forced-controls`, `${FLAT_CONTROLS} The Position segmented control also shows no segment boundary or selected state, and a switch shows an empty pill.`],
        [`side-panel|${width}|scale-labels`, 'Defect: at 200% text the Position segmented control and the Insertion Frequency row label break words mid-word ("Bef/ore", "Dep/th", "Frequ/ency"), because the segments and the label column get a fixed narrow share of the panel.'],
        [`chat-archive|${width}|forced-controls`, `${FLAT_CONTROLS} ${NO_FORCED_RING}`],
    ]),
    ['menu-sheet|390|forced-controls', `${FLAT_CONTROLS} ${NO_FORCED_RING}`],
    ['chat-archive|390|scale-layout', 'Defect: at 200% text the selection header (Cancel, count title, Select All, Close) does not fit 390px. The count title collapses to nothing and the Close button sits partly past the right edge of the viewport.'],
]);

// Reads that the boot makes, so the guard lets them through to the isolated test server.
// --- Checks ---------------------------------------------------------------------------------------------

const defectFor = (surface, viewport, check) => KNOWN_DEFECTS.get(`${surface.id}|${viewport.width}|${check}`);

function markKnownDefect(surface, viewport, check) {
    const reason = defectFor(surface, viewport, check);
    test.fail(Boolean(reason), reason);
}

const insideOnly = stops => stops.filter(stop => stop.kind === 'element' && stop.inside);
const outsideLabels = stops => stops.filter(stop => stop.kind === 'element' && !stop.inside).map(stop => stop.label);
const focusStateOf = (page, surface) => page.evaluate(selector => window.sbA11y.focusState(selector), surface.rootSelector);

function focusProblems(stops, { forcedColours = false } = {}) {
    return insideOnly(stops)
        .filter(stop => !(forcedColours ? stop.outline : stop.outline || stop.shadow))
        .map(stop => `${stop.label} outline ${stop.outlineDetail}, shadow ${stop.shadowDetail}`);
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
                    markKnownDefect(surface, viewport, 'tab');
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
                    markKnownDefect(surface, viewport, 'focus');
                    const context = await surface.boot(page, baseURL, viewport, { motion: false });
                    await surface.open(page, context);
                    const { stops } = await walkSurface(page, surface);
                    expect(insideOnly(stops).length, 'focusable stops').toBeGreaterThan(0);
                    expect(focusProblems(stops)).toEqual([]);
                });

                test('keyboard: Escape closes or pops one level and focus returns to the opener', async ({ page, baseURL }) => {
                    markKnownDefect(surface, viewport, 'escape');
                    const context = await surface.boot(page, baseURL, viewport, { motion: false });
                    const opener = await surface.open(page, context);
                    await pressEscapeSteps(page, surface, context, opener);
                    await expect(surface.isOpen(page)).toHaveCount(0);
                });

                test('keyboard with motion: Escape closes through the closing animation and focus returns', async ({ page, baseURL }) => {
                    markKnownDefect(surface, viewport, 'escape');
                    const context = await surface.boot(page, baseURL, viewport, { motion: true });
                    const opener = await surface.open(page, context);
                    await pressEscapeSteps(page, surface, context, opener);
                    await expect(surface.isOpen(page)).toHaveCount(0);
                });

                if (surface.destructive) {
                    test('keyboard: Return with Cancel focused does not confirm', async ({ page, baseURL }) => {
                        markKnownDefect(surface, viewport, 'return');
                        const context = await surface.boot(page, baseURL, viewport, { motion: false });
                        await surface.open(page, context);
                        await expect(surface.cancel(page), 'Cancel has the focus on open').toBeFocused();
                        await pressKey(page, 'Enter');
                        await expect(surface.isOpen(page)).toHaveCount(0);
                        expect(await surface.wasConfirmed(page, context)).toBe(false);
                    });
                }

                test('forced colours: frame boundary, text and selection checks stay visible', async ({ page, baseURL }) => {
                    markKnownDefect(surface, viewport, 'forced');
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
                    markKnownDefect(surface, viewport, 'forced-controls');
                    const context = await surface.boot(page, baseURL, viewport, { motion: false });
                    await page.emulateMedia({ forcedColors: 'active' });
                    await surface.open(page, context);
                    for (const state of surface.states) {
                        await state.enter(page, context);
                        await settleTransitions(page);
                        const report = await page.evaluate(([root, frame]) => window.sbA11y.forcedColours(root, frame), [surface.rootSelector, surface.frameSelector]);
                        expect.soft(report.controls, `${state.name}: control boundaries or fills`).toEqual([]);
                        const { stops } = await walkSurface(page, surface);
                        expect.soft(focusProblems(stops, { forcedColours: true }), `${state.name}: focus indicator`).toEqual([]);
                    }
                });

                test('200% text: no label is clipped', async ({ page, baseURL }) => {
                    markKnownDefect(surface, viewport, 'scale-labels');
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
                    markKnownDefect(surface, viewport, 'scale-layout');
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

test.describe('Enter on a real button', () => {
    test('activates it once', async ({ page, baseURL }) => {
        test.fail(true, 'Defect: keyboard.js turns Enter on any .interactable into a click(), and a real <button> also clicks natively, so one press clicks twice. The second click lands on whatever took focus in between, such as the Cancel button of the dialog the first click opened.');
        await bootMisc(page, baseURL, DESKTOP, { motion: false });
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
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
