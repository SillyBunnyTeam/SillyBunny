import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { waitForAppReady } from './helpers/app-ready.js';
import {
    INSET, PREFERENCE_PAGES, boot, openCharacterEditor, openCharactersTab, openHosted, preferenceContent, readFrame, readPage,
    readPreferencePage, readWidePages, wideContent,
} from './helpers/settings-page-frames.js';

// The full-screen settings page and the Window dialog tier stop growing with the window: the sidebar follows the libadwaita
// split-view rule, preference pages are an AdwClamp of 1000sp and the pages of lists, editors and grids one of 1440sp (the
// tightening threshold at 2/3 of the maximum), and a Window has a 1440sp ceiling. `sp` is a pixel times the text size
// (--fontScale). A desktop switch (Customize > Interface > Desktop) turns the clamps and the ceiling off; the sidebar rule stays.

test.beforeEach(async ({ page }) => { await protectMaintainerServer(page); });
test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120_000 });

const SWITCH = '#sb-desktop-content-clamp-input';

/** Elements of the settings page that scroll sideways, and the document itself. */
function sidewaysScrollers(page) {
    return page.evaluate(() => {
        const root = document.getElementById('sb-settings-page');
        const offenders = [];
        if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) offenders.push('document');
        for (const node of [root, ...root.querySelectorAll('*')]) {
            if (['TEXTAREA', 'INPUT', 'SELECT', 'PRE', 'CODE'].includes(node.tagName) || node.getClientRects().length === 0) continue;
            if (!/(auto|scroll)/.test(getComputedStyle(node).overflowX) || node.scrollWidth - node.clientWidth <= 1) continue;
            offenders.push(`${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}.${[...node.classList].join('.')} ${node.scrollWidth}/${node.clientWidth}`);
        }
        return offenders;
    });
}

/** A page's content is `expected` wide, centred in the box that pads it. The chords of the curve lie under it, never over it, by at most 3px. */
function expectColumn(read, expected, label) {
    expect(read.error, label).toBeUndefined();
    expect(read.width, `${label} is no wider than AdwClamp makes it`).toBeLessThanOrEqual(expected + 0.5);
    expect(read.width, `${label} is within 3px of AdwClamp`).toBeGreaterThanOrEqual(expected - 3);
    expect(Math.abs(read.before - read.after), `${label} is centred: ${read.before} before, ${read.after} after`).toBeLessThanOrEqual(1);
}

test.describe('Settings content width at 3440×1440', () => {
    test.beforeEach(async ({ page }) => boot(page, { width: 3440, height: 1440 }));

    test('the sidebar stays at the start edge at 280px, and the header bar spans the pane', async ({ page }) => {
        await openHosted(page, 'right', 'interface');
        const boxes = await page.evaluate(() => {
            const box = selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return { left: rect.left, width: rect.width }; };
            return { sidebar: box('#sb-settings-sidebar'), host: box('#sb-settings-shell-host'), header: box('#sb-settings-content-header'), title: box('.sb-settings-title') };
        });
        expect(boxes.sidebar).toEqual({ left: 0, width: 280 });
        expect(boxes.header.left).toBeCloseTo(boxes.host.left, 0);
        expect(boxes.header.width).toBeCloseTo(boxes.host.width, 0);
        // The title is centred in the pane, as a header bar's title is.
        expect(boxes.title.left + boxes.title.width / 2).toBeCloseTo(boxes.host.left + boxes.host.width / 2, -1);
    });

    test('preference pages are a 1000px column, centred in a scroller that spans the pane', async ({ page }) => {
        expect(preferenceContent(3440)).toBe(1000);
        const problems = [];
        for (const entry of PREFERENCE_PAGES) {
            const read = await readPreferencePage(page, entry);
            if (read.width > 1000.5 || read.width < 997) problems.push(`${entry.id}: ${read.width}px wide`);
            if (Math.abs(read.before - read.after) > 1) problems.push(`${entry.id}: ${read.before} before, ${read.after} after`);
            if (Math.abs(read.scroller.left - read.pane.left) > 1 || Math.abs(read.scroller.right - read.pane.right) > 1) {
                problems.push(`${entry.id}: the scroller is ${read.scroller.left}-${read.scroller.right}, the pane ${read.pane.left}-${read.pane.right}`);
            }
        }
        expect(problems).toEqual([]);
        expect(await sidewaysScrollers(page)).toEqual([]);
    });

    test('Extensions (list and a detail page) and Characters Import follow the preference column', async ({ page }) => {
        const extensions = await openHosted(page, 'right', 'extensions');
        await expect.poll(() => extensions.locator('.sb-subpage-row').count()).toBeGreaterThan(0);
        let read = await readPage(page, { panel: '[data-sb-panel="extensions"]', scroller: '[data-sb-panel="extensions"] .sb-subpage-list' });
        expectColumn(read, preferenceContent(3440), 'Extensions list');
        expect(Math.abs(read.scroller.left - read.pane.left) + Math.abs(read.scroller.right - read.pane.right)).toBeLessThanOrEqual(2);
        await page.evaluate(() => [...document.querySelectorAll('[data-sb-panel="extensions"] .sb-subpage-row')].find(row => row.textContent.includes('Regex')).click());
        await expect(extensions.locator('.sb-subpage-detail[aria-hidden="false"]')).toBeVisible();
        await expect.poll(async () => (await readPage(page, { panel: '[data-sb-panel="extensions"] .sb-subpage-detail[aria-hidden="false"]', scroller: '[data-sb-panel="extensions"] .sb-subpage-detail[aria-hidden="false"]' })).error ?? '').toBe('');
        read = await readPage(page, { panel: '[data-sb-panel="extensions"] .sb-subpage-detail[aria-hidden="false"]', scroller: '[data-sb-panel="extensions"] .sb-subpage-detail[aria-hidden="false"]' });
        expectColumn(read, preferenceContent(3440), 'Extension detail page');

        await openCharactersTab(page, 'import');
        await expect(page.locator('#sb_character_import_content')).toBeVisible();
        await expect.poll(async () => (await readPage(page, { panel: '#sb_character_import_content', scroller: '#sb_character_import_panel' })).error ?? '').toBe('');
        read = await readPage(page, { panel: '#sb_character_import_content', scroller: '#sb_character_import_panel' });
        expectColumn(read, preferenceContent(3440), 'Characters Import');
        expect(Math.abs(read.scroller.left - read.pane.left) + Math.abs(read.scroller.right - read.pane.right)).toBeLessThanOrEqual(2);
        expect(await sidewaysScrollers(page)).toEqual([]);
    });

    test('pages of lists, editors and grids are a 1440px frame, centred, with their scrollbars inside it', async ({ page }) => {
        expect(wideContent(3440)).toBe(1440);
        const reads = await readWidePages(page);
        for (const [name, read] of Object.entries(reads)) expectColumn(read, wideContent(3440), name);
        expect(await sidewaysScrollers(page)).toEqual([]);
    });

    test('the page class is one attribute from the tab definition, and the two Editor tabs are told apart', async ({ page }) => {
        const classes = {};
        for (const { id, shell } of [...PREFERENCE_PAGES, { id: 'extensions', shell: 'right' }, { id: 'editor', shell: 'left' }, { id: 'agents', shell: 'left' }]) {
            await openHosted(page, shell, id);
            classes[`${shell}:${id}`] = await page.locator(`[data-sb-panel="${id}"]`).getAttribute('data-sb-page-width');
        }
        for (const tab of ['characters', 'groups', 'world-info', 'persona', 'import']) {
            await openCharactersTab(page, tab);
            classes[`characters:${tab}`] = await page.locator('#right-nav-panel').getAttribute('data-sb-page-width');
        }
        await openCharacterEditor(page);
        classes['characters:editor'] = await page.locator('#right-nav-panel').getAttribute('data-sb-page-width');
        expect(classes).toEqual({
            'right:interface': 'preference', 'left:connections': 'preference', 'left:prompting': 'preference', 'left:sampling': 'preference',
            'left:context': 'preference', 'right:appearance': 'preference', 'right:messages': 'preference', 'right:data-security': 'preference',
            'right:logs': 'preference', 'right:extensions': 'preference', 'left:editor': 'wide', 'left:agents': 'wide',
            'characters:characters': 'wide', 'characters:groups': 'wide', 'characters:world-info': 'wide', 'characters:persona': 'wide',
            'characters:import': 'preference', 'characters:editor': 'wide',
        });
    });
});

// The widths of AdwClamp at text size 1, for a page of Customize > Interface (preference) and Characters > World Info (wide), by window width.
// The room of a page is the pane (the window less the sidebar, which is clamp(180, 25%, 280)) less both 12px insets. At 3440px the room is more than
// the curve needs, so the page is as wide as its maximum.
const CLAMP_TABLE = {
    1024: { preference: 738, wide: 744 },
    1280: { preference: 890, wide: 975 },
    1366: { preference: 926, wide: 1054 },
    1440: { preference: 950, wide: 1115 },
    1600: { preference: 983, wide: 1223 },
    1920: { preference: 999, wide: 1362 },
    2560: { preference: 1000, wide: 1439 },
    3440: { preference: 1000, wide: 1440 },
};

test.describe('Settings content width follows the AdwClamp curve', () => {
    for (const [windowWidth, expected] of Object.entries(CLAMP_TABLE).filter(([width]) => Number(width) !== 3440)) {
        const width = Number(windowWidth);
        test(`at ${width}px a preference page is ${expected.preference}px and a wide page ${expected.wide}px`, async ({ page }) => {
            expect({ preference: preferenceContent(width), wide: wideContent(width) }, 'the helper follows the table').toEqual(expected);
            await boot(page, { width, height: 900 });
            const read = await readPreferencePage(page, PREFERENCE_PAGES[0]);
            expectColumn(read, expected.preference, 'Interface');
            await openCharactersTab(page, 'world-info');
            await expect(page.locator('#right-nav-panel .sb-wi-editor')).toBeVisible();
            expectColumn(await readFrame(page, { frame: '#right-nav-panel .sb-wi-editor', container: '#right-nav-panel > .scrollableInner' }), expected.wide, 'World Info');
            expect(await sidewaysScrollers(page)).toEqual([]);
        });
    }

    // The same room gives every page of its class the same width, whichever page it is.
    for (const width of [1440, 1920]) {
        test(`at ${width}px every page of a class has the same width`, async ({ page }) => {
            await boot(page, { width, height: 900 });
            const problems = [];
            for (const entry of PREFERENCE_PAGES) {
                const read = await readPreferencePage(page, entry);
                if (read.width > preferenceContent(width) + 0.5 || read.width < preferenceContent(width) - 3) problems.push(`${entry.id}: ${read.width}px wide, AdwClamp ${preferenceContent(width)}`);
                if (Math.abs(read.before - read.after) > 1) problems.push(`${entry.id}: ${read.before} before, ${read.after} after`);
            }
            expect(problems).toEqual([]);
            for (const [name, read] of Object.entries(await readWidePages(page))) expectColumn(read, wideContent(width), name);
            expect(await sidewaysScrollers(page)).toEqual([]);
        });
    }
});

test.describe('One side inset on every settings page', () => {
    test('a page the clamp does not narrow sits 12px from the pane at every desktop width, and no page steps at 1440px', async ({ page }) => {
        await boot(page, { width: 1100, height: 900 });
        const reads = {};
        // 1260px is the widest window at which a wide page still has less room than its threshold (960sp); 1436 and 1440 are the two sides of the old step.
        for (const width of [900, 1100, 1260, 1436, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            reads[width] = { wide: await readWidePages(page), preference: await readPreferencePage(page, PREFERENCE_PAGES[0]) };
        }
        const problems = [];
        for (const width of [900, 1100, 1260]) {
            for (const [name, read] of Object.entries(reads[width].wide)) {
                if (Math.abs(read.before - INSET) > 0.5 || Math.abs(read.after - INSET) > 0.5) problems.push(`${width} ${name}: ${read.before} before, ${read.after} after, not ${INSET}`);
            }
        }
        // A preference page has less room than its threshold (667sp) up to a window of about 920px.
        const { before, after } = reads[900].preference;
        if (Math.abs(before - INSET) > 0.5 || Math.abs(after - INSET) > 0.5) problems.push(`900 Interface: ${before} before, ${after} after, not ${INSET}`);
        // Four pixels more window is at most four pixels more page, on every page.
        for (const [name, read] of Object.entries(reads[1440].wide)) {
            const step = read.width - reads[1436].wide[name].width;
            if (step < 0 || step > 4.5) problems.push(`${name}: ${step}px from 1436px to 1440px`);
        }
        const interfaceStep = reads[1440].preference.width - reads[1436].preference.width;
        if (interfaceStep < 0 || interfaceStep > 4.5) problems.push(`Interface: ${interfaceStep}px from 1436px to 1440px`);
        expect(problems).toEqual([]);
    });
});

test.describe('One top space on every settings page', () => {
    // The old space under the bar followed the window height (clamp(16px, 2.2vh, 24px) less 4px) from 1440px and was 14px below it.
    for (const height of [900, 700]) {
        test(`a list or editor frame starts where a preference page starts its content, at 1436px and 1444px, ${height}px high`, async ({ page }) => {
            await boot(page, { width: 1436, height });
            // A page loads its own style sheet on the first visit, and a page that is read before that has no padding yet.
            await readWidePages(page);
            const problems = [];
            const tops = {};
            for (const width of [1436, 1444]) {
                await page.setViewportSize({ width, height });
                const preference = (await readPreferencePage(page, PREFERENCE_PAGES[0])).top;
                const frames = await readWidePages(page);
                tops[width] = Object.fromEntries(Object.entries(frames).map(([name, read]) => [name, read.top]));
                problems.push(...Object.entries(tops[width]).filter(([, top]) => Math.abs(top - preference) > 0.5)
                    .map(([name, top]) => `${width}px: ${name} starts at ${top}px, the Interface page starts at ${preference}px`));
            }
            problems.push(...Object.entries(tops[1436]).filter(([name, top]) => Math.abs(top - tops[1444][name]) > 0.5)
                .map(([name, top]) => `${name}: ${top}px at 1436px, ${tops[1444][name]}px at 1444px`));
            expect(problems).toEqual([]);
        });
    }
});

test.describe('The text size scales the maximums, the thresholds and the sidebar', () => {
    for (const fontScale of [0.8, 1.5]) {
        test(`at ${fontScale} the sidebar is ${280 * fontScale}px and the pages follow AdwClamp of ${1000 * fontScale} and ${1440 * fontScale}`, async ({ page }) => {
            await boot(page, { width: 3440, height: 1440, fontScale });
            expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fontScale').trim())).toBe(String(fontScale));
            await openHosted(page, 'right', 'interface');
            const sidebar = await page.locator('#sb-settings-sidebar').evaluate(element => element.getBoundingClientRect().width);
            expect(sidebar).toBeCloseTo(280 * fontScale, 0);
            const read = await readPreferencePage(page, { id: 'interface', shell: 'right' });
            expectColumn(read, preferenceContent(3440, fontScale), 'Interface');
            await openCharactersTab(page, 'world-info');
            await expect(page.locator('#right-nav-panel .sb-wi-editor')).toBeVisible();
            expectColumn(await readFrame(page, { frame: '#right-nav-panel .sb-wi-editor', container: '#right-nav-panel > .scrollableInner' }), wideContent(3440, fontScale), 'World Info');
            expect(await sidewaysScrollers(page)).toEqual([]);
        });
    }

    test('at 1.5 a wide page is still on the curve at 3440px, where its maximum needs 3600px', async () => {
        expect(wideContent(3440, 1.5)).toBeLessThan(1440 * 1.5);
        expect(preferenceContent(3440, 1.5)).toBe(1500);
    });

    test('at 1024px wide the sidebar is a quarter of the page, as a libadwaita split view', async ({ page }) => {
        await boot(page, { width: 1024, height: 768 });
        await openHosted(page, 'right', 'interface');
        expect(await page.locator('#sb-settings-sidebar').evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(256, 0);
    });
});

/** Opens a Window that a Popup draws, or Help, and reads its width. */
async function readWindow(page, kind) {
    if (kind === 'help') await page.evaluate(async () => (await import('/scripts/sillybunny-help/help-window.js')).openHelpWindow());
    else {
        await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            void new Popup('<h3>Data Bank</h3><p>Viewer content.</p>', POPUP_TYPE.TEXT, '', { large: true, okButton: 'Close' }).show();
        });
    }
    // A Popup is the Window itself; Help is a frame inside a dialog host.
    const dialog = page.locator('dialog[open]:not([closing])').last();
    const surfaceWidth = () => dialog.evaluate(element => (element.matches('.sb-dialog--window') ? element : element.querySelector('.sb-dialog--window'))?.getBoundingClientRect().width ?? 0);
    await expect.poll(surfaceWidth).toBeGreaterThan(0);
    let width = 0;
    await expect.poll(async () => { const next = await surfaceWidth(); const settled = next === width; width = next; return settled; }).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    return width;
}

test.describe('The Window tier has a ceiling', () => {
    // Page Width 55 (the bundled value) is 1892px at this size, 100 is the whole window less 32px, and 30 stays under the ceiling.
    for (const [chatWidth, plain] of [[55, 1440], [100, 1440], [30, 1032]]) {
        test(`at Page Width ${chatWidth} a plain Window is ${plain}px and Help is at most 1440px wide with its aside`, async ({ page }) => {
            await boot(page, { width: 3440, height: 1440, chatWidth });
            expect(await readWindow(page, 'plain')).toBeCloseTo(plain, 0);
            const help = await readWindow(page, 'help');
            expect(help).toBeLessThanOrEqual(1440.5);
            // Below the ceiling the Window follows Page Width and adds the aside: Help is wider than a plain Window.
            if (chatWidth === 30) expect(help).toBeGreaterThan(plain);
            else expect(help).toBeCloseTo(1440, 0);
        });
    }

    test('the ceiling scales with the text size', async ({ page }) => {
        await boot(page, { width: 3440, height: 1440, fontScale: 1.5, chatWidth: 100 });
        expect(await readWindow(page, 'plain')).toBeCloseTo(2160, 0);
    });

    test('the Alert and Dialog tiers keep their widths', async ({ page }) => {
        await boot(page, { width: 3440, height: 1440, chatWidth: 100 });
        const widths = await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            const read = async (content, type, value, options) => {
                void new Popup(content, type, value, options).show();
                await new Promise(resolve => setTimeout(resolve, 600));
                const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
                const width = dialog.getBoundingClientRect().width;
                dialog.querySelector('.popup-button-cancel, .popup-button-ok, .sb-dialog__close')?.click();
                await new Promise(resolve => setTimeout(resolve, 400));
                return width;
            };
            return {
                alert: await read('<h3>Delete Character</h3><p>Permanent action.</p>', POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' }),
                dialog: await read('<h3>Rename</h3><p>Enter a name.</p>', POPUP_TYPE.INPUT, 'Old', { rows: 4 }),
            };
        });
        expect(widths.alert).toBeLessThanOrEqual(372);
        expect(widths.dialog).toBe(640);
    });
});

test.describe('Limit Content Width', () => {
    test('is a Desktop switch of Interface, on by default, in the order of its siblings', async ({ page }) => {
        await boot(page, { width: 1440, height: 900 });
        const interfacePage = await openHosted(page, 'right', 'interface');
        const group = interfacePage.locator('#sb-desktop-settings-outlet');
        const row = group.locator('.ds-row', { has: page.locator(SWITCH) });
        await expect(row.locator('.ds-row-label')).toHaveText('Limit Content Width');
        await expect(row.locator('.ds-row-subtitle')).toHaveText('Clamps the contents of Settings to a specific viewport for wide monitors');
        await expect(page.locator(SWITCH)).toBeChecked();
        await expect(page.locator(SWITCH)).toHaveAttribute('role', 'switch');
        await expect(page.locator('html')).not.toHaveAttribute('data-sb-content-clamp', /.*/);
        expect(await group.locator(':scope > .ds-row, :scope > .ds-row-switch').evaluateAll(rows => rows.map(node => node.querySelector('input')?.id).filter(Boolean)))
            .toEqual(['sb-desktop-topbar-icons-only-input', 'sb-desktop-button-scale-input', 'sb-desktop-pin-characters-input', 'sb-desktop-content-clamp-input']);
    });

    test('turns the columns and the Window ceiling off with one attribute write, and keeps the sidebar rule', async ({ page }) => {
        await boot(page, { width: 3440, height: 1440 });
        await openHosted(page, 'right', 'interface');
        // The page finishes building its rows after it opens; the switch is recorded once nothing else is writing.
        await page.evaluate(() => new Promise(resolve => {
            let timer;
            const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => { observer.disconnect(); resolve(); }, 700); });
            observer.observe(document.documentElement, { attributes: true, subtree: true, childList: true });
            timer = setTimeout(() => { observer.disconnect(); resolve(); }, 700);
        }));
        // The click and the turns of the microtask queue after it: one write to the root, and nothing under it restyled (no class,
        // style or other attribute, and no node added or removed). Timers that other parts of the page run meanwhile are not the switch's.
        const mutations = await page.evaluate(async () => {
            const records = [];
            const observer = new MutationObserver(delivered => records.push(...delivered));
            observer.observe(document.documentElement, { attributes: true, subtree: true, childList: true });
            document.getElementById('sb-desktop-content-clamp-input').closest('.ds-row').click();
            for (let turn = 0; turn < 5; turn++) await Promise.resolve();
            records.push(...observer.takeRecords());
            observer.disconnect();
            return records.map(record => `${record.target === document.documentElement ? 'html' : 'subtree'}:${record.attributeName ?? record.type}`);
        });
        expect(mutations).toEqual(['html:data-sb-content-clamp']);
        await expect(page.locator('html')).toHaveAttribute('data-sb-content-clamp', 'off');
        await expect(page.locator(SWITCH)).not.toBeChecked();
        // The app writes its settings to storage after a short delay.
        await expect.poll(() => page.evaluate(() => localStorage.getItem('sb-desktop-content-clamp'))).toBe('false');

        const read = await readPreferencePage(page, { id: 'interface', shell: 'right' });
        expect(read.width).toBeCloseTo(read.pane.right - read.pane.left - 2 * INSET, 0);
        expect(read.before).toBeCloseTo(INSET, 0);
        expect(read.after).toBeCloseTo(INSET, 0);
        expect(await page.locator('#sb-settings-sidebar').evaluate(element => element.getBoundingClientRect().width)).toBe(280);
        await openCharactersTab(page, 'world-info');
        await expect(page.locator('#right-nav-panel .sb-wi-editor')).toBeVisible();
        const frame = await readFrame(page, { frame: '#right-nav-panel .sb-wi-editor', container: '#right-nav-panel > .scrollableInner' });
        expect(frame.width).toBeCloseTo(frame.container - 2 * INSET, 0);
        expect(await sidewaysScrollers(page)).toEqual([]);

        // A Window follows Page Width again: 55 is 1892px at this size, 100 is the window less 32px.
        expect(await readWindow(page, 'plain')).toBeCloseTo(1892, 0);
        await page.evaluate(() => document.documentElement.style.setProperty('--sheldWidth', '100vw'));
        expect(await readWindow(page, 'plain')).toBeCloseTo(3408, 0);
    });

    test('is kept across a reload and is in force before the app has built its pages', async ({ page }) => {
        await boot(page, { width: 1440, height: 900 });
        await openHosted(page, 'right', 'interface');
        await page.locator(SWITCH).evaluate(input => input.closest('.ds-row').click());
        await expect(page.locator('html')).toHaveAttribute('data-sb-content-clamp', 'off');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('html')).toHaveAttribute('data-sb-content-clamp', 'off');
        await waitForAppReady(page, { timeout: 60000 });
        await openHosted(page, 'right', 'interface');
        await expect(page.locator(SWITCH)).not.toBeChecked();
        await page.locator(SWITCH).evaluate(input => input.closest('.ds-row').click());
        await expect(page.locator('html')).not.toHaveAttribute('data-sb-content-clamp', /.*/);
        await expect.poll(() => page.evaluate(() => localStorage.getItem('sb-desktop-content-clamp'))).toBe('true');
    });

    test('is found by the settings search', async ({ page }) => {
        await boot(page, { width: 1440, height: 900 });
        await openHosted(page, 'right', 'interface');
        const toggle = page.locator('#sb-settings-search-toggle');
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
        await page.locator('#sb-settings-search-input').fill('Limit Content Width');
        await expect(page.locator('button[data-sb-settings-tab="interface"]')).not.toHaveClass(/sb-settings-tab--filtered/);
        await expect.poll(() => page.locator(`${SWITCH}`).evaluate(input => !input.closest('.ds-row').classList.contains('sb-settings-row--filtered'))).toBe(true);
        await expect(page.locator('button[data-sb-settings-tab="messages"]')).toHaveClass(/sb-settings-tab--filtered/);
    });
});

test.describe('The phone layout does not change', () => {
    test('the settings page has the same geometry with the switch on and off, and no Limit Content Width row', async ({ page }) => {
        await boot(page, { width: 390, height: 844 });
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
        await page.locator('button[data-sb-settings-tab="interface"]').evaluate(element => element.click());
        await expect(page.locator('[data-sb-panel="interface"]')).toHaveAttribute('aria-hidden', 'false');
        await expect(page.locator(SWITCH)).toBeHidden();
        const geometry = () => page.evaluate(() => {
            const round = value => Math.round(value * 10) / 10;
            const box = selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return [round(rect.left), round(rect.width)]; };
            const scroller = document.querySelector('[data-sb-panel="interface"] > .sb-shell-panel-scroller');
            const group = [...document.querySelectorAll('[data-sb-panel="interface"] .ds-pref-group')].find(node => node.getClientRects().length > 0).getBoundingClientRect();
            const frame = scroller.getBoundingClientRect();
            return {
                sidebar: box('#sb-settings-sidebar'), content: box('#sb-settings-content'), scroller: box('[data-sb-panel="interface"] > .sb-shell-panel-scroller'),
                before: round(group.left - frame.left), width: round(group.width), padding: getComputedStyle(scroller).paddingInline,
            };
        });
        const on = await geometry();
        expect(on.before).toBe(INSET);
        expect(on.width).toBe(on.scroller[1] - 2 * INSET);
        expect(on.padding).toBe(`${INSET}px`);
        await page.evaluate(() => document.documentElement.setAttribute('data-sb-content-clamp', 'off'));
        expect(await geometry()).toEqual(on);
    });
});

test.describe('Preset API/Sampler Linking', () => {
    test('the descriptions of the two linking switches wrap inside their rows', async ({ page }) => {
        await boot(page, { width: 1440, height: 900 });
        await page.evaluate(() => { $('#main_api').val('openai').trigger('change'); $('#chat_completion_source').val('openrouter').trigger('change'); });
        await openHosted(page, 'left', 'prompting');
        for (const [width, height] of [[1440, 900], [1024, 768]]) {
            await page.setViewportSize({ width, height });
            for (const id of ['bind_preset_to_connection_copy', 'bind_preset_to_sampling_copy']) {
                const description = page.locator(`#${id}`);
                await expect(description).toBeVisible();
                await expect.poll(() => description.evaluate(node => {
                    const column = node.closest('.ds-row-text');
                    const lineHeight = parseFloat(getComputedStyle(node).lineHeight);
                    return { clipped: node.scrollWidth > node.clientWidth + 1 || column.scrollWidth > column.clientWidth + 1, inside: node.getBoundingClientRect().right <= column.getBoundingClientRect().right + 1, lines: Math.round(node.getBoundingClientRect().height / lineHeight) };
                }), `${id} at ${width}`).toMatchObject({ clipped: false, inside: true });
            }
        }
        // At 1024px the sentence is wider than its column, so it takes more than one line.
        for (const id of ['bind_preset_to_connection_copy', 'bind_preset_to_sampling_copy']) {
            expect(await page.locator(`#${id}`).evaluate(node => node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight)), id).toBeGreaterThan(1.5);
        }
    });
});
