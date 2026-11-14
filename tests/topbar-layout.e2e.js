import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, selectSampleCharacter } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

// The top bar's three tracks, its title, and what it gives up as the width runs out: the title shortens,
// the labels drop, the title hides, then Quick Access moves into the overflow menu. The bar is the same in the labelled mode and
// in the icons-only mode (the setting turns the labels off, nothing else), on desktop and on phones.
// Run with: SILLYBUNNY_TEST_BASE_URL=http://127.0.0.1:<port> npx playwright test topbar-layout.e2e.js

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const LONG_TITLE = 'A very long custom top bar label for testing';
const DESKTOP_WIDTHS = [...Array.from({ length: 14 }, (_, index) => 769 + index * 25), 1100];
const FILLED_SLOTS = {
    'sb-shortcut-left': 'left:agents',
    'sb-shortcut-right': 'right:extensions',
    'sb-shortcut-slot3': 'left:sampling',
    'sb-shortcut-slot4': 'left:prompting',
    'sb-shortcut-slot5': 'right:background',
    'sb-shortcut-slot6': 'action:search',
};
const LABELLED_ORDER = {
    left: [
        'sb-left-shell-toggle', 'sb-right-shell-toggle', 'sb-topbar-divider-search-mobile', 'sb-topbar-search-toggle',
        'sb-topbar-divider-quick-left', 'sb-shortcut-left', 'sb-shortcut-slot3', 'sb-shortcut-slot4',
    ],
    right: [
        'sb-topbar-extension-slot', 'sb-shortcut-slot6', 'sb-shortcut-slot5', 'sb-shortcut-right', 'sb-topbar-overflow-toggle',
        'sb-topbar-divider-quick-right', 'sb-mode-toggle', 'sb-topbar-divider-mode-mobile', 'sb-home-toggle', 'sb-character-toggle',
    ],
};

async function bootBar(page, { longTitle = false, slots = null, iconsOnly = false } = {}) {
    await protectMaintainerServer(page);
    await page.addInitScript(({ longTitle: long, slots: stored, iconsOnly: icons, title }) => {
        if (long) {
            localStorage.setItem('sb-topbar-label-desktop-parts', JSON.stringify(['custom']));
            localStorage.setItem('sb-topbar-label-mobile-part', 'custom');
            localStorage.setItem('sb-topbar-label-custom-text', title);
        }
        for (const [id, target] of Object.entries(stored ?? {})) {
            localStorage.setItem(id, target);
        }
        if (icons) {
            localStorage.setItem('sb-desktop-topbar-icons-only', 'true');
            localStorage.setItem('sb-mobile-topbar-icons-only', 'true');
        }
    }, { longTitle, slots, iconsOnly, title: LONG_TITLE });
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await expect(page.locator('#sb-topbar-inner')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-sb-topbar-icons-only', String(iconsOnly));
}

async function setIconsOnly(page, iconsOnly) {
    await page.evaluate(value => {
        window.SillyBunnyShell.setTopbarIconsOnly('desktop', value);
        window.SillyBunnyShell.setTopbarIconsOnly('mobile', value);
    }, iconsOnly);
    await expect(page.locator('html')).toHaveAttribute('data-sb-topbar-icons-only', String(iconsOnly));
}

/** Everything the bar must not do, as a list of sentences; empty when the bar is sound. */
function readBarProblems() {
    const problems = [];
    const viewportWidth = document.documentElement.clientWidth;
    const inner = document.getElementById('sb-topbar-inner');
    const groups = [...inner.querySelectorAll(':scope > .sb-topbar-group')];
    const brand = inner.querySelector(':scope > .sb-topbar-brand');
    const title = document.getElementById('sb-topbar-title');
    const shown = element => element.getClientRects().length > 0;
    const name = element => element.id || element.className;

    const controls = [];
    for (const group of groups) {
        for (const child of group.children) {
            if (!shown(child) || child.classList.contains('sb-topbar-cluster-divider')) {
                continue;
            }
            for (const control of child.id === 'sb-topbar-extension-slot' ? child.children : [child]) {
                if (shown(control)) {
                    controls.push({ control, group });
                }
            }
        }
        if (group.scrollWidth > group.clientWidth + 1) {
            problems.push(`${name(group)} scrolls (${group.scrollWidth} in ${group.clientWidth})`);
        }
    }

    const pieces = [];
    for (const { control, group } of controls) {
        const rect = control.getBoundingClientRect();
        const own = group.getBoundingClientRect();
        pieces.push({ id: name(control), x: rect.x, y: rect.y, w: rect.width, h: rect.height });
        if (rect.left < -0.5 || rect.right > viewportWidth + 0.5) {
            problems.push(`${name(control)} is outside the window (${Math.round(rect.left)} to ${Math.round(rect.right)} of ${viewportWidth})`);
        }
        if (rect.left < own.left - 0.5 || rect.right > own.right + 0.5) {
            problems.push(`${name(control)} spills out of its group`);
        }
        const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (!top || !control.contains(top)) {
            problems.push(`${name(control)} is covered by ${top ? name(top) : 'nothing'}`);
        }
        if (rect.width < 30 || rect.height < 30) {
            problems.push(`${name(control)} is only ${Math.round(rect.width)}x${Math.round(rect.height)}`);
        }
    }

    const titleShown = brand instanceof HTMLElement && shown(brand);
    if (titleShown) {
        const rect = title.getBoundingClientRect();
        const brandRect = brand.getBoundingClientRect();
        const [start, end] = groups.map(group => group.getBoundingClientRect());
        pieces.push({ id: 'title', x: rect.x, y: rect.y, w: rect.width, h: rect.height });
        if (rect.left < start.right - 0.5 || rect.right > end.left + 0.5) {
            problems.push(`the title (${Math.round(rect.left)} to ${Math.round(rect.right)}) leaves its track (${Math.round(start.right)} to ${Math.round(end.left)})`);
        }
        if (brandRect.width > 0 && title.clientWidth < 30) {
            problems.push(`the title shows only ${title.clientWidth}px`);
        }
    }

    for (let first = 0; first < pieces.length; first++) {
        for (let second = first + 1; second < pieces.length; second++) {
            const a = pieces[first];
            const b = pieces[second];
            const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            if (width > 0.5 && height > 0.5) {
                problems.push(`${a.id} overlaps ${b.id}`);
            }
        }
    }

    if (document.documentElement.scrollWidth > viewportWidth) {
        problems.push('the page scrolls sideways');
    }

    return problems;
}

function readFit() {
    const data = document.documentElement.dataset;
    return {
        labels: data.sbTopbarLabels === 'off' ? 'off' : 'on',
        title: data.sbTopbarTitle === 'hidden' ? 'hidden' : 'shown',
        overflow: data.sbTopbarOverflow === 'true',
    };
}

/** The fit runs on a frame of its own after the bar's width changes. */
function settleFit(page) {
    return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}

async function expectSoundBar(page, label) {
    await expect.poll(() => page.evaluate(readBarProblems), { message: label, timeout: 5000 }).toEqual([]);
}

async function sweepWidths(page, widths, height) {
    const verdicts = [];
    for (const width of widths) {
        await page.setViewportSize({ width, height });
        await settleFit(page);
        await expectSoundBar(page, `at ${width}px`);
        verdicts.push({ width, ...await page.evaluate(readFit) });
    }
    return verdicts;
}

// The steps from the narrowest bar to the widest: Quick Access in the menu, icons without the title,
// icons with the title, labels with the title. (The title shortens by its ellipsis within each.)
const FIT_STEPS = ['overflow', 'icons, no title', 'icons, title', 'labels, title'];

function stepOf(verdict) {
    if (verdict.overflow) {
        return verdict.title === 'hidden' ? 0 : -1;
    }
    if (verdict.labels === 'off') {
        return verdict.title === 'hidden' ? 1 : 2;
    }
    return verdict.title === 'hidden' ? -1 : 3;
}

function describeVerdicts(verdicts) {
    // Verdicts run from the narrowest width up. A bar has no state outside the four steps (no labels
    // without the title, no menu with the title), and each step only ever goes further as it narrows.
    const steps = verdicts.map(stepOf);
    expect(verdicts.filter((verdict, index) => steps[index] < 0).map(verdict => verdict.width), 'widths in no step').toEqual([]);
    expect(verdicts.filter((verdict, index) => index > 0 && steps[index] < steps[index - 1]).map(verdict => verdict.width), 'widths that go back a step as the bar narrows').toEqual([]);
    return verdicts.map((verdict, index) => `${verdict.width}: ${FIT_STEPS[steps[index]] ?? 'no step'}`).join('\n');
}

test.describe('top bar on a desktop window', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    for (const iconsOnly of [false, true]) {
        const mode = iconsOnly ? 'icons-only' : 'labelled';

        test(`${mode}: nothing is clipped or overlapped with a long title from 769 to 1100px`, async ({ page }) => {
            await bootBar(page, { longTitle: true, iconsOnly });
            await expect(page.locator('#sb-topbar-title')).toHaveText(LONG_TITLE);
            const verdicts = await sweepWidths(page, DESKTOP_WIDTHS, 900);
            test.info().annotations.push({ type: 'fit', description: describeVerdicts(verdicts) });
        });

        test(`${mode}: nothing is clipped or overlapped with every Quick Access slot filled, from 769 to 1100px`, async ({ page }) => {
            await bootBar(page, { longTitle: true, iconsOnly, slots: FILLED_SLOTS });
            await expect(page.locator('#sb-topbar-title')).toHaveText(LONG_TITLE);
            const verdicts = await sweepWidths(page, DESKTOP_WIDTHS, 900);
            test.info().annotations.push({ type: 'fit', description: describeVerdicts(verdicts) });
        });

        test(`${mode}: keeps the short title and every control at 1440, 1100 and 900px`, async ({ page }) => {
            await bootBar(page, { iconsOnly });
            await sweepWidths(page, [1440, 1100, 900], 900);
            await page.setViewportSize({ width: 1440, height: 900 });
            await expectSoundBar(page, 'at 1440px');
            expect(await page.evaluate(readFit)).toEqual({ labels: iconsOnly ? 'off' : 'on', title: 'shown', overflow: false });
        });
    }

    test('centres a title that fits on the window', async ({ page }) => {
        await bootBar(page, {});
        for (const width of [1440, 1200, 1100]) {
            await page.setViewportSize({ width, height: 900 });
            await settleFit(page);
            await expectSoundBar(page, `at ${width}px`);
            const offset = await page.evaluate(() => {
                const rect = document.getElementById('sb-topbar-title').getBoundingClientRect();
                return Math.abs(rect.x + rect.width / 2 - document.documentElement.clientWidth / 2);
            });
            expect(offset, `at ${width}px`).toBeLessThan(1);
        }
    });

    test('truncates a long title with an ellipsis', async ({ page }) => {
        await bootBar(page, { longTitle: true, iconsOnly: true });
        await page.setViewportSize({ width: 900, height: 900 });
        await settleFit(page);
        await expectSoundBar(page, 'at 900px');
        const title = await page.evaluate(() => {
            const element = document.getElementById('sb-topbar-title');
            return { truncated: element.scrollWidth > element.clientWidth, textOverflow: getComputedStyle(element).textOverflow };
        });
        expect(title).toEqual({ truncated: true, textOverflow: 'ellipsis' });
    });

    test('draws the title as the Title role, at the body size and weight 700', async ({ page }) => {
        await bootBar(page, { longTitle: true });
        const result = await page.evaluate(() => {
            const probe = document.createElement('span');
            probe.style.fontSize = 'var(--sb-type-title)';
            document.body.append(probe);
            const expected = getComputedStyle(probe).fontSize;
            probe.remove();
            const style = getComputedStyle(document.getElementById('sb-topbar-title'));
            probe.style.fontSize = 'var(--mainFontSize)';
            document.body.append(probe);
            const bodySize = getComputedStyle(probe).fontSize;
            probe.remove();
            return { expected, size: style.fontSize, bodySize, weight: style.fontWeight, role: document.getElementById('sb-topbar-title').getAttribute('role') };
        });
        expect(result.size).toBe(result.expected);
        expect(result.size).toBe(result.bodySize);
        expect(result.weight).toBe('700');
        expect(result.role).toBe('button');
    });

    test('keeps the bar\'s own order of controls in both modes', async ({ page }) => {
        await bootBar(page, {});
        for (const iconsOnly of [false, true]) {
            await setIconsOnly(page, iconsOnly);
            const order = await page.evaluate(() => ({
                left: [...document.querySelectorAll('#sb-topbar-inner > .sb-topbar-group-left > *')].map(element => element.id),
                right: [...document.querySelectorAll('#sb-topbar-inner > .sb-topbar-group-right > *')].map(element => element.id),
            }));
            expect(order, `iconsOnly ${iconsOnly}`).toEqual(LABELLED_ORDER);
        }
    });

    test('has no rail of page icons in either mode', async ({ page }) => {
        await bootBar(page, {});
        for (const iconsOnly of [false, true]) {
            await setIconsOnly(page, iconsOnly);
            await expect(page.locator('.sb-topbar-pages, [data-sb-topbar-page], .sb-topbar-page-button')).toHaveCount(0);
            for (const id of ['sb-left-shell-toggle', 'sb-right-shell-toggle', 'sb-topbar-search-toggle', 'sb-mode-toggle', 'sb-home-toggle', 'sb-character-toggle']) {
                await expect(page.locator(`#${id}`)).toBeVisible();
            }
        }
    });

    test('keeps the labels in the labelled bar and shows icons alone in the icons-only bar', async ({ page }) => {
        await bootBar(page, {});
        const labels = () => page.evaluate(() => ['sb-left-shell-toggle', 'sb-right-shell-toggle', 'sb-home-toggle', 'sb-character-toggle']
            .map(id => {
                const span = document.querySelector(`#${id} > span`);
                return span && span.getClientRects().length > 0 ? span.textContent : null;
            }));
        expect(await labels()).toEqual(['Backend', 'Customize', 'Home', 'Characters']);
        await setIconsOnly(page, true);
        expect(await labels()).toEqual([null, null, null, null]);
    });

    test('draws every bar control with the 9px Control radius, flat until it is on', async ({ page }) => {
        await bootBar(page, {});
        for (const iconsOnly of [false, true]) {
            await setIconsOnly(page, iconsOnly);
            const result = await page.evaluate(() => [...document.querySelectorAll('#sb-topbar-inner .sb-proxy-button')]
                .filter(button => button.getClientRects().length > 0)
                .map(button => {
                    const style = getComputedStyle(button);
                    return { id: button.id, radius: style.borderTopLeftRadius, background: style.backgroundColor, on: button.matches('.is-open, .is-active, .is-current, .sb-settings-active') };
                }));
            expect(result.length).toBeGreaterThan(6);
            expect(result.filter(button => button.radius !== '9px').map(button => button.id)).toEqual([]);
            expect(result.filter(button => !button.on && button.background !== 'rgba(0, 0, 0, 0)').map(button => button.id), 'flat at rest').toEqual([]);
            expect(await page.evaluate(() => getComputedStyle(document.getElementById('sb-topbar-title')).borderTopLeftRadius)).toBe('9px');
        }
    });

    test('gives every bar control a tooltip and an accessible name', async ({ page }) => {
        await bootBar(page, { slots: FILLED_SLOTS });
        const result = await page.evaluate(() => [...document.querySelectorAll('#sb-topbar-inner button, #sb-topbar-title')].map(element => ({
            id: element.id,
            name: element.getAttribute('aria-label')?.trim() ?? '',
            tooltip: element.getAttribute('title')?.trim() ?? '',
            role: element.tagName === 'BUTTON' ? 'button' : element.getAttribute('role'),
        })));
        expect(result.length).toBeGreaterThan(10);
        for (const control of result) {
            expect(control.name, `${control.id} has a name`).not.toBe('');
            expect(control.tooltip, `${control.id} has a tooltip`).not.toBe('');
            expect(control.role, `${control.id} is a button`).toBe('button');
        }
    });

    test('shows an open section, an open search and the Home page as a neutral fill with the accent on the icon', async ({ page }) => {
        await bootBar(page, {});
        const read = id => page.evaluate(buttonId => {
            const probe = document.createElement('i');
            probe.style.color = 'var(--color-primary, var(--sb-accent))';
            document.body.append(probe);
            const accent = getComputedStyle(probe).color;
            probe.remove();
            const button = document.getElementById(buttonId);
            const style = getComputedStyle(button);
            const label = button.querySelector('span');
            return {
                accent,
                background: style.backgroundColor,
                icon: getComputedStyle(button.querySelector('i')).color,
                label: label && label.getClientRects().length > 0 ? getComputedStyle(label).color : null,
            };
        }, id);
        const expectNeutralFill = state => {
            const alpha = Number(state.background.match(/[,/]\s*([\d.]+)\)$/)?.[1] ?? 1);
            expect(state.background).not.toBe('rgba(0, 0, 0, 0)');
            expect(alpha, 'a neutral fill is translucent').toBeLessThan(0.3);
            expect(state.background).not.toContain(state.accent.replace('rgb(', '').replace(')', ''));
            expect(state.icon).toBe(state.accent);
            expect(state.label, 'the label stays in the body colour').not.toBe(state.accent);
        };

        const idle = await read('sb-right-shell-toggle');
        expect(idle.background).toBe('rgba(0, 0, 0, 0)');
        expect(idle.icon).not.toBe(idle.accent);

        await page.locator('#sb-right-shell-toggle').click();
        await expect(page.locator('#sb-right-shell-toggle')).toHaveClass(/\bsb-settings-active\b/);
        await page.mouse.move(0, 400);
        expectNeutralFill(await read('sb-right-shell-toggle'));
        await page.locator('#sb-settings-close').click();

        await page.locator('#sb-topbar-search-toggle').click();
        await expect(page.locator('#sb-topbar-search-toggle')).toHaveClass(/\bis-open\b/);
        await page.mouse.move(0, 400);
        expectNeutralFill(await read('sb-topbar-search-toggle'));
        await page.locator('#sb-topbar-search-toggle').click();

        await page.locator('#sb-home-toggle').click();
        await expect(page.locator('#sb-home-toggle')).toHaveClass(/\bis-current\b/);
        await page.mouse.move(0, 400);
        expectNeutralFill(await read('sb-home-toggle'));
    });

    test('lights one destination at a time, the one on screen, and leaves Search its own state', async ({ page }) => {
        await bootBar(page, {});
        const destinations = () => page.evaluate(() => ['sb-left-shell-toggle', 'sb-right-shell-toggle', 'sb-home-toggle', 'sb-character-toggle']
            .filter(id => document.getElementById(id).matches('.is-current, .is-open, .sb-settings-active, [aria-current]')));
        const closePage = async () => {
            await page.locator('#sb-settings-close').click();
            await expect(page.locator('#sb-settings-page')).toBeHidden();
        };

        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
        expect(await destinations()).toEqual(['sb-home-toggle']);

        // A chat is on screen: no destination is active.
        await selectSampleCharacter(page);
        await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/);
        expect(await destinations()).toEqual([]);
        await page.locator('#sb-right-shell-toggle').click();
        await expect(page.locator('#sb-settings-page')).toBeVisible();
        expect(await destinations(), 'a page over a chat').toEqual(['sb-right-shell-toggle']);
        await closePage();
        expect(await destinations(), 'back on the chat').toEqual([]);

        await page.locator('#sb-home-toggle').click();
        await expect(page.locator('#sb-home-toggle')).toHaveAttribute('aria-current', 'page');
        expect(await destinations()).toEqual(['sb-home-toggle']);

        // A section page over Home takes the fill from Home, for each of the three sections.
        for (const id of ['sb-left-shell-toggle', 'sb-right-shell-toggle', 'sb-character-toggle']) {
            await page.locator(`#${id}`).click();
            await expect(page.locator('#sb-settings-page')).toBeVisible();
            await expect(page.locator(`#${id}`)).toHaveClass(/\bsb-settings-active\b/);
            expect(await destinations(), `${id} over Home`).toEqual([id]);
            await expect(page.locator('#sb-home-toggle')).not.toHaveAttribute('aria-current', /.*/);
            await closePage();
            await expect(page.locator('#sb-home-toggle')).toHaveAttribute('aria-current', 'page');
            expect(await destinations(), `Home after ${id}`).toEqual(['sb-home-toggle']);
        }

        // Search is a toggle: it is on beside the destination and does not move it.
        await page.locator('#sb-topbar-search-toggle').click();
        await expect(page.locator('#sb-topbar-search-toggle')).toHaveClass(/\bis-open\b/);
        expect(await destinations()).toEqual(['sb-home-toggle']);

        // A result of the search that opens a settings page makes that page the destination.
        await page.locator('#sb-universal-search input').fill('Thumbnail Quality');
        await page.locator('.sb-search-result').first().click();
        await expect(page.locator('#sb-settings-page')).toBeVisible();
        expect(await destinations(), 'a page opened from the search').toHaveLength(1);
        await expect(page.locator('#sb-home-toggle')).not.toHaveAttribute('aria-current', /.*/);
        await closePage();
        await expect(page.locator('#sb-home-toggle')).toHaveAttribute('aria-current', 'page');
    });

    test('moves Quick Access into an overflow menu once the icons-only bar does not fit', async ({ page }) => {
        await bootBar(page, { slots: FILLED_SLOTS, iconsOnly: true });
        // Three adopted extension buttons with a text label: they keep their place, so the room they
        // take is what the Quick Access buttons have to give up.
        await page.evaluate(() => {
            for (const index of [1, 2, 3]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'menu_button';
                button.id = `sb-e2e-ext-button-${index}`;
                button.innerHTML = '<i class="fa-solid fa-flask"></i> Extension';
                document.getElementById('top-settings-holder').appendChild(button);
            }
        });
        await expect(page.locator('#sb-topbar-extension-slot #sb-e2e-ext-button-3')).toBeAttached();
        await page.setViewportSize({ width: 769, height: 900 });
        await settleFit(page);
        await expect.poll(() => page.evaluate(readFit)).toMatchObject({ overflow: true, labels: 'off' });
        await expectSoundBar(page, 'with the overflow button');

        for (const id of Object.keys(FILLED_SLOTS)) {
            await expect(page.locator(`#${id}`)).toBeHidden();
        }
        await expect(page.locator('#sb-topbar-divider-quick-left')).toBeHidden();
        const toggle = page.locator('#sb-topbar-overflow-toggle');
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-label', 'Quick Access');
        await expect(toggle).toHaveAttribute('title', 'Quick Access');
        await toggle.click();
        await expect(page.getByRole('menu', { name: 'Quick Access' })).toBeVisible();
        const items = page.getByRole('menuitem');
        await expect(items).toHaveCount(6);
        await expect(items.filter({ hasText: 'Extensions' })).toHaveCount(1);
        await items.filter({ hasText: 'Sampling' }).click();
        await expect(page.locator('button[data-sb-settings-tab="sampling"]')).toHaveAttribute('aria-selected', 'true');
    });

    test('keeps Quick Access in the bar while the labelled bar fits', async ({ page }) => {
        await bootBar(page, {});
        await expect(page.locator('#sb-topbar-overflow-toggle')).toBeHidden();
        await expect(page.locator('#sb-shortcut-left')).toBeVisible();
        await expect(page.locator('#sb-shortcut-right')).toBeVisible();
    });

    test('keeps both stored icons-only settings as the user left them', async ({ page }) => {
        await bootBar(page, { iconsOnly: true });
        await page.setViewportSize({ width: 800, height: 900 });
        await expectSoundBar(page, 'at 800px');
        await page.setViewportSize({ width: 1440, height: 900 });
        await expectSoundBar(page, 'at 1440px');
        const stored = await page.evaluate(() => ({
            desktop: localStorage.getItem('sb-desktop-topbar-icons-only'),
            mobile: localStorage.getItem('sb-mobile-topbar-icons-only'),
            legacy: localStorage.getItem('sb-topbar-icons-only'),
        }));
        expect(stored).toEqual({ desktop: 'true', mobile: 'true', legacy: null });

        await setIconsOnly(page, false);
        await page.setViewportSize({ width: 800, height: 900 });
        await settleFit(page);
        await expectSoundBar(page, 'at 800px');
        await expect.poll(() => page.evaluate(() => localStorage.getItem('sb-desktop-topbar-icons-only'))).toBe('false');
    });
});

test.describe('top bar on a touch screen in landscape (#975)', () => {
    test.use({ viewport: { width: 820, height: 360 }, hasTouch: true, isMobile: true });

    for (const iconsOnly of [false, true]) {
        test(`${iconsOnly ? 'icons-only' : 'labelled'}: no button overlaps a long title at 820x360`, async ({ page }) => {
            await bootBar(page, { longTitle: true, iconsOnly });
            await expect(page.locator('#sb-topbar-title')).toHaveText(LONG_TITLE);
            await expectSoundBar(page, 'at 820x360');
            const overlaps = await page.evaluate(() => {
                const title = document.getElementById('sb-topbar-title').getBoundingClientRect();
                return [...document.querySelectorAll('#sb-topbar-inner .sb-proxy-button')]
                    .filter(button => button.getClientRects().length > 0)
                    .filter(button => {
                        const rect = button.getBoundingClientRect();
                        return rect.right > title.left + 0.5 && rect.left < title.right - 0.5 && rect.bottom > title.top + 0.5 && rect.top < title.bottom - 0.5;
                    })
                    .map(button => button.id);
            });
            expect(overlaps).toEqual([]);
            for (const width of [844, 820, 800, 769]) {
                await page.setViewportSize({ width, height: 360 });
                await expectSoundBar(page, `at ${width}x360`);
            }
        });
    }
});

test.describe('top bar on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    for (const iconsOnly of [false, true]) {
        test(`${iconsOnly ? 'icons-only' : 'labelled'}: shows the same bar, a truncated title and every control from 320 to 768px`, async ({ page }) => {
            await bootBar(page, { longTitle: true, iconsOnly });
            await expect(page.locator('#sb-topbar-title')).toHaveText(LONG_TITLE);
            await sweepWidths(page, [768, 600, 450, 414, 390, 375, 360, 340, 320], 844);
            await page.setViewportSize({ width: 390, height: 844 });
            await expectSoundBar(page, 'at 390px');
            const bar = await page.evaluate(() => ({
                order: {
                    left: [...document.querySelectorAll('#sb-topbar-inner > .sb-topbar-group-left > *')].map(element => element.id),
                    right: [...document.querySelectorAll('#sb-topbar-inner > .sb-topbar-group-right > *')].map(element => element.id),
                },
                visible: [...document.querySelectorAll('#sb-topbar-inner .sb-proxy-button')].filter(button => button.getClientRects().length > 0).map(button => button.id),
                radius: [...document.querySelectorAll('#sb-topbar-inner .sb-proxy-button')].filter(button => button.getClientRects().length > 0).map(button => getComputedStyle(button).borderTopLeftRadius),
                title: document.getElementById('sb-topbar-title').getClientRects().length > 0,
            }));
            expect(bar.order).toEqual(LABELLED_ORDER);
            expect(bar.visible).toEqual(['sb-left-shell-toggle', 'sb-right-shell-toggle', 'sb-topbar-search-toggle', 'sb-mode-toggle', 'sb-home-toggle', 'sb-character-toggle']);
            expect(new Set(bar.radius)).toEqual(new Set(['9px']));
            expect(bar.title).toBe(true);
        });
    }

    test('has no rail of page icons and keeps Backend on the bar with the icons-only setting on', async ({ page }) => {
        await bootBar(page, { iconsOnly: true });
        await expect(page.locator('.sb-topbar-pages, [data-sb-topbar-page]')).toHaveCount(0);
        await expect(page.locator('#sb-left-shell-toggle')).toBeVisible();
        await expect(page.locator('#sb-topbar-title')).toBeVisible();
    });

    test('hides the title when too little of it would show, at the narrowest phone', async ({ page }) => {
        await bootBar(page, { longTitle: true });
        await page.setViewportSize({ width: 320, height: 568 });
        await expectSoundBar(page, 'at 320px');
        const title = await page.evaluate(() => ({ shown: document.getElementById('sb-topbar-title').getClientRects().length > 0, width: document.getElementById('sb-topbar-title').clientWidth }));
        expect(!title.shown || title.width >= 30).toBe(true);
    });
});
