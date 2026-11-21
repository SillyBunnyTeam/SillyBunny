import { expect, test } from '@playwright/test';
import { variantContextOptions } from './helpers/surface-matrix.js';
import { bootSurfaceApp, openSurface } from './helpers/surfaces/boot.js';
import { SURFACES } from './helpers/surfaces/index.js';
import { bootMiscWithChat } from './helpers/dialog-accessibility-surfaces.js';

/**
 * Keyboard and forced-colour checks that hold at every pointer type: the focus ring of header icon buttons and
 * select rows, the Tab order of dialog responses, the selected sidebar tab and the swatches under forced colours,
 * the Tab stops of inline drawers, and the composer's text size.
 */

const surfaceById = id => {
    const surface = SURFACES.find(candidate => candidate.id === id);
    if (!surface) throw new Error(`No surface ${id}`);
    return surface;
};

async function openAt(browser, { baseURL, locale, timezoneId }, id, variant) {
    const surface = surfaceById(id);
    const context = await browser.newContext({ ...variantContextOptions(variant), baseURL, locale, timezoneId });
    const page = await context.newPage();
    await bootSurfaceApp(page, baseURL, { variant, needs: surface.needs ?? [] });
    await openSurface(page, surface, { viewport: variant.viewport });
    return { context, page };
}

/** Focus by key, so the browser treats the focus as a keyboard focus and :focus-visible matches. */
async function focusByKey(page, locator) {
    await page.keyboard.press('Tab');
    await locator.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
}

for (const viewport of ['1440x900', '768x1024', '390x844']) {
    test.describe(`focus ring at ${viewport}`, () => {
        test('header icon buttons of the persona list draw the ring', async ({ browser, baseURL, locale, timezoneId }) => {
            const { context, page } = await openAt(browser, { baseURL, locale, timezoneId }, 'list.persona', { viewport });
            try {
                const buttons = page.locator('.sb-header-icon-button:visible');
                expect(await buttons.count()).toBeGreaterThan(1);
                for (let index = 0; index < await buttons.count(); index++) {
                    const button = buttons.nth(index);
                    await button.focus();
                    await page.keyboard.press('Shift+Tab');
                    await page.keyboard.press('Tab');
                    const ring = await page.evaluate(() => {
                        const el = document.activeElement;
                        return { visible: el.matches(':focus-visible'), shadow: getComputedStyle(el).boxShadow, outline: getComputedStyle(el).outlineStyle };
                    });
                    expect(ring.visible).toBe(true);
                    expect(ring.shadow !== 'none' || ring.outline !== 'none').toBe(true);
                }
            } finally {
                await context.close();
            }
        });

        test('the theme select trigger draws a ring on itself or on its row', async ({ browser, baseURL, locale, timezoneId }) => {
            const { context, page } = await openAt(browser, { baseURL, locale, timezoneId }, 'settings.customize.appearance', { viewport });
            try {
                const trigger = page.locator('.ds-select-row__trigger:visible').first();
                await focusByKey(page, trigger);
                const ring = await trigger.evaluate(el => {
                    const drawn = node => getComputedStyle(node).boxShadow !== 'none' || getComputedStyle(node).outlineStyle !== 'none';
                    return { visible: el.matches(':focus-visible'), drawn: drawn(el) || drawn(el.closest('.ds-select-row')) };
                });
                expect(ring.visible).toBe(true);
                expect(ring.drawn).toBe(true);
            } finally {
                await context.close();
            }
        });
    });
}

const VIEWPORTS = { '1440x900': { width: 1440, height: 900 }, '390x844': { width: 390, height: 844 } };

async function bootChat(browser, { baseURL, locale, timezoneId }, viewport, fontScale = 1) {
    const size = VIEWPORTS[viewport];
    const coarse = viewport === '390x844';
    const context = await browser.newContext({ viewport: size, hasTouch: coarse, isMobile: coarse, locale, timezoneId, serviceWorkers: 'block' });
    const page = await context.newPage();
    await bootMiscWithChat(page, baseURL, size, { fontScale });
    return { context, page };
}

const OPENERS = {
    alert: () => import('/scripts/sillybunny-editor/dialog.js').then(({ openAlert }) => { void openAlert({ heading: 'Delete Folder?', body: 'Body.', responses: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete', appearance: 'destructive' }] }); }),
    dialog: () => import('/scripts/sillybunny-editor/dialog.js').then(({ openDialog }) => { void openDialog({ title: 'Create', content: document.createElement('div'), responses: { cancel: {}, affirmative: { id: 'save', label: 'Save' } } }); }),
};

for (const viewport of ['1440x900', '390x844']) {
    test.describe(`dialog Tab order at ${viewport}`, () => {
        for (const kind of ['alert', 'dialog']) {
            test(`openAlert and openDialog: the ${kind} tabs in the order the responses are drawn`, async ({ browser, baseURL, locale, timezoneId }) => {
                const { context, page } = await bootChat(browser, { baseURL, locale, timezoneId }, viewport);
                try {
                    await page.evaluate(`(${OPENERS[kind].toString()})()`);
                    await expect(page.locator('dialog[open] .sb-dialog__response').first()).toBeVisible();
                    const order = await page.evaluate(() => {
                        const nodes = [...document.querySelectorAll('dialog[open] .sb-dialog__response')].filter(node => node.getClientRects().length);
                        const drawn = nodes.map(node => ({ name: node.textContent.trim(), rect: node.getBoundingClientRect() }));
                        const stacked = drawn.length > 1 && Math.abs(drawn[0].rect.top - drawn[1].rect.top) > 4;
                        const byLayout = [...drawn].sort((a, b) => stacked ? a.rect.top - b.rect.top : a.rect.left - b.rect.left).map(item => item.name);
                        return { dom: drawn.map(item => item.name), layout: byLayout };
                    });
                    expect(order.dom).toHaveLength(2);
                    expect(order.dom).toEqual(order.layout);
                } finally {
                    await context.close();
                }
            });
        }
    });
}

test.describe('forced colours at 1440x900', () => {
    test('the selected sidebar tab and the accent swatches keep an indicator and their colour', async ({ browser, baseURL, locale, timezoneId }) => {
        const { context, page } = await openAt(browser, { baseURL, locale, timezoneId }, 'settings.customize.appearance', { viewport: '1440x900', forcedColors: 'active' });
        try {
            expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
            const tabs = await page.evaluate(() => {
                const selected = document.querySelector('.sb-settings-tab[aria-selected="true"]');
                const other = document.querySelector('.sb-settings-tab:not([aria-selected="true"])');
                return { selected: getComputedStyle(selected).backgroundColor, other: getComputedStyle(other).backgroundColor };
            });
            expect(tabs.selected).not.toBe(tabs.other);
            const swatches = await page.evaluate(() => [...document.querySelectorAll('.sb-accent-preset')].map(node => getComputedStyle(node, '::before').backgroundColor));
            expect(new Set(swatches).size).toBeGreaterThan(3);
        } finally {
            await context.close();
        }
    });
});

for (const forcedColors of ['none', 'active']) {
    test(`the accent preset of the current accent is the pressed one, forced colours ${forcedColors}`, async ({ browser, baseURL, locale, timezoneId }) => {
        const { context, page } = await openAt(browser, { baseURL, locale, timezoneId }, 'settings.customize.appearance', { viewport: '1440x900', forcedColors });
        try {
            const pressed = () => page.evaluate(() => [...document.querySelectorAll('.sb-accent-preset')].filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.dataset.accent));
            const states = () => page.evaluate(() => [...document.querySelectorAll('.sb-accent-preset')].map(node => node.getAttribute('aria-pressed')));
            expect((await states()).every(value => value === 'true' || value === 'false')).toBe(true);
            await page.locator('.sb-accent-preset[data-accent="red"]').click();
            expect(await pressed()).toEqual(['red']);
            // Forced colours draw a 1px ButtonBorder outline on every preset, so the pressed one is told by a wider ring.
            const ringWidth = accent => page.locator(`.sb-accent-preset[data-accent="${accent}"]`).evaluate(node => getComputedStyle(node).outlineStyle === 'none' ? 0 : parseFloat(getComputedStyle(node).outlineWidth));
            expect(await ringWidth('red')).toBeGreaterThanOrEqual(2);
            expect(await ringWidth('blue')).toBeLessThan(2);
            // A colour that is no preset's leaves none pressed; a theme change moves the state with the accent.
            await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                power_user.quote_text_color = 'rgba(1, 2, 3, 1)';
                document.getElementById('sb-accent-primary-picker').dispatchEvent(new CustomEvent('change', { detail: { rgba: 'rgba(53, 132, 228, 1)' } }));
            });
            expect(await pressed()).toEqual(['blue']);
            await page.locator('.sb-accent-preset[data-accent="purple"]').click();
            expect(await pressed()).toEqual(['purple']);
        } finally {
            await context.close();
        }
    });
}

for (const viewport of ['1440x900', '390x844']) {
    test(`inline drawers have one Tab stop, their header, at ${viewport}`, async ({ browser, baseURL, locale, timezoneId }) => {
        const { context, page } = await openAt(browser, { baseURL, locale, timezoneId }, 'settings.backend.connections', { viewport });
        try {
            const stops = await page.evaluate(() => [...document.querySelectorAll('.inline-drawer-icon')]
                // The legacy Prompt Manager's drawer is hidden markup that the prompt editor replaces; its header takes no Tab stop on purpose.
                .filter(icon => !icon.matches('.inline-drawer-toggle') && icon.parentElement.closest('.inline-drawer-toggle, .inline-drawer-header') && !icon.closest('#sb-openai-prompt-manager'))
                .map(icon => {
                    const header = icon.parentElement.closest('.inline-drawer-toggle, .inline-drawer-header');
                    return { iconTab: icon.tabIndex, iconRole: icon.getAttribute('role'), iconHtml: icon.outerHTML.slice(0, 160), parentHtml: icon.parentElement.outerHTML.slice(0, 160), headerTab: header.tabIndex, header: `${header.tagName}.${header.className}|${header.id}|${header.closest('[id]')?.id}` };
                }));
            expect(stops.length).toBeGreaterThan(0);
            for (const stop of stops) {
                expect(stop.iconTab, stop.iconHtml + ' IN ' + stop.parentHtml).toBeLessThan(0);
                expect(stop.iconRole).not.toBe('button');
                expect(stop.headerTab, stop.header).toBeGreaterThanOrEqual(0);
            }
            // Enter on a header that the keyboard script adopts toggles its drawer once, not twice. The header may be hidden
            // (a drawer of another backend), so the key event is dispatched instead of typed.
            const adopted = page.locator('.inline-drawer-header.inline-drawer-toggle.interactable:not(.ds-row):not([aria-expanded]):has(> .inline-drawer-icon)').first();
            await expect(adopted).toHaveCount(1);
            const toggles = await adopted.evaluate(header => {
                const icon = header.querySelector(':scope > .inline-drawer-icon');
                const before = icon.classList.contains('up');
                header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
                return { before, after: icon.classList.contains('up') };
            });
            expect(toggles.after).toBe(!toggles.before);
        } finally {
            await context.close();
        }
    });
}

test('the composer follows the text size on a phone and never goes under 16px', async ({ browser, baseURL, locale, timezoneId }) => {
    // Two boots, one per text size.
    test.setTimeout(120_000);
    const sizes = {};
    for (const fontScale of [1, 1.5]) {
        const { context, page } = await bootChat(browser, { baseURL, locale, timezoneId }, '390x844', fontScale);
        try {
            sizes[fontScale] = await page.locator('#send_textarea').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
        } finally {
            await context.close();
        }
    }
    expect(sizes[1]).toBeGreaterThanOrEqual(16);
    expect(sizes[1.5]).toBeGreaterThan(sizes[1]);
});
