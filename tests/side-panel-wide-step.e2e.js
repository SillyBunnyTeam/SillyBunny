/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- The mode of a width (docked or sheet) selects which geometry is asserted. */
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

// A docked panel has one rule at every width above the phone layout, 1280px included: the chat keeps its Page Width,
// moves only as far as the panels need, and the panels become a sheet only when the chat would be under 360px.
// The phone layout (768px and under) is the full window, so a panel takes its share of that.
test.use({ contextOptions: { reducedMotion: 'reduce' } });
// A sweep resizes the window about 45 times, which takes WebKit longer than the default timeout.
test.describe.configure({ timeout: 120_000 });

const MIN_CHAT_WIDTH = 360;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 420;

// Every 20 to 50px, with a 1px sweep through the 1280px step that the chat used to take below it.
const WIDTHS = [
    1500, 1440, 1400, 1360, 1320, 1300,
    ...Array.from({ length: 21 }, (_, index) => 1290 - index),
    1260, 1240, 1220, 1200, 1180, 1160, 1140, 1120, 1100, 1060, 1020, 980, 940, 900, 860, 820, 790, 769,
];

/** What the docking rule gives at a width: the panel width, the chat's width and left edge, or a sheet. */
function expectedLayout({ width, pageWidth, sides }) {
    const configured = (width * pageWidth) / 100;
    const panel = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, (width - configured) / 2));
    const start = sides.includes('left') ? panel : 0;
    const end = sides.includes('right') ? panel : 0;
    const chat = Math.min(configured, width - start - end);
    if (chat < MIN_CHAT_WIDTH) return { mode: 'sheet', configured };
    const centred = (width - configured) / 2;
    const left = chat < configured ? start : Math.min(Math.max(centred, start), width - end - configured);
    return { mode: 'docked', configured, panel, chat, left, centred, start, end };
}

async function boot(page, { width, pageWidth, sides }) {
    await protectMaintainerServer(page);
    await page.setViewportSize({ width, height: 900 });
    await openQuietChatForSmoke(page);
    await page.addStyleTag({ content: '#sheld { transition: none !important; }' });
    await page.evaluate(async ({ pageWidth, sides }) => {
        document.documentElement.style.setProperty('--sheldWidth', `${pageWidth}vw`);
        const sidePanels = await import('/scripts/sillybunny-editor/side-panel.js');
        const panels = sides.map(side => {
            const source = document.createElement('section');
            source.id = `qa-side-panel-${side}`;
            source.textContent = 'Panel';
            document.getElementById('movingDivs').append(source);
            return sidePanels.registerSidePanel({ id: source.id, element: source, title: `Test Panel ${side}`, defaultSide: side });
        });
        for (const panel of panels) await panel.open({});
    }, { pageWidth, sides });
}

async function setWidth(page, width) {
    await page.setViewportSize({ width, height: 900 });
    // The layout runs a frame after the resize, and the shell's own resize runs it once more.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))));
}

function readLayout(page) {
    return page.evaluate(() => {
        const root = document.documentElement;
        const px = name => Number.parseFloat(root.style.getPropertyValue(name));
        const shell = document.getElementById('sheld').getBoundingClientRect();
        const body = document.body.classList;
        return {
            mode: body.contains('sb-has-docked-panel') ? 'docked' : body.contains('sb-has-side-panel-sheet') ? 'sheet' : 'none',
            width: shell.width,
            left: shell.left,
            variableWidth: px('--sb-chat-width'),
            variableOffset: px('--sb-chat-offset'),
            panel: px('--sb-side-panel-width'),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
    });
}

const SIDES = { one: ['left'], two: ['left', 'right'] };

for (const pageWidth of [30, 55, 100]) {
    for (const [name, sides] of Object.entries(SIDES)) {
        test(`${name} docked panel${sides.length > 1 ? 's' : ''} at Page Width ${pageWidth} keep the chat at its width, move it only as far as needed and change nothing at 1280px`, async ({ page }) => {
            await boot(page, { width: WIDTHS[0], pageWidth, sides });
            const problems = [];
            const docked = [];
            let previous = null;
            for (const width of WIDTHS) {
                await setWidth(page, width);
                const read = await readLayout(page);
                const expected = expectedLayout({ width, pageWidth, sides });
                if (read.overflow > 0) problems.push(`${width}: scrolls sideways by ${read.overflow}`);
                if (expected.mode === 'sheet' && sides.length > 1) {
                    // Two panels that do not fit leave one: the first closes, the last lays out alone, and the first stays closed when the window widens again.
                    const alone = expectedLayout({ width, pageWidth, sides: ['right'] });
                    if (read.mode !== alone.mode) problems.push(`${width}: ${read.mode} after the first panel closed, expected ${alone.mode}`);
                    break;
                }
                if (read.mode !== expected.mode) problems.push(`${width}: ${read.mode}, expected ${expected.mode}`);
                if (expected.mode === 'sheet') {
                    previous = null;
                    continue;
                }
                docked.push(width);
                if (Math.abs(read.width - expected.chat) > 1) problems.push(`${width}: chat ${read.width}px wide, expected ${expected.chat}`);
                if (Math.abs(read.left - expected.left) > 1) problems.push(`${width}: chat starts at ${read.left}px, expected ${expected.left}`);
                if (Math.abs(read.variableWidth - read.width) > 1 || Math.abs(read.variableOffset - read.left) > 1) problems.push(`${width}: the shell is not where the layout put it`);
                if (Math.abs(read.panel - expected.panel) > 1) problems.push(`${width}: panel ${read.panel}px wide, expected ${expected.panel}`);
                // The chat keeps the width it is given while it fits beside the panels.
                if (expected.chat === expected.configured && Math.abs(read.width - expected.configured) > 1) problems.push(`${width}: Page Width not kept`);
                // It moves only as far as the panels need: centred when that clears them, otherwise against the one it is pushed by.
                const clears = expected.centred >= expected.start && expected.centred + expected.configured <= width - expected.end;
                if (clears && Math.abs(read.left - expected.centred) > 1) problems.push(`${width}: moved from the centre without need`);
                if (!clears && expected.chat === expected.configured) {
                    const touchesStart = Math.abs(read.left - expected.start) <= 1;
                    const touchesEnd = Math.abs(read.left + read.width - (width - expected.end)) <= 1;
                    if (!touchesStart && !touchesEnd) problems.push(`${width}: moved past the panel it clears`);
                }
                // One step of the window moves the chat by at most one step, so nothing jumps, least of all at 1280px.
                if (previous) {
                    const step = previous.width - width;
                    if (Math.abs(read.width - previous.read.width) > step + 1 || Math.abs(read.left - previous.read.left) > step + 1) {
                        problems.push(`${width}: chat steps ${read.width - previous.read.width}px wide and ${read.left - previous.read.left}px across for a ${step}px step`);
                    }
                }
                previous = { width, read };
            }
            expect(problems).toEqual([]);
            // A sweep that never docks would test nothing, and the sweep reaches both sides of 1280px.
            expect(docked).toContain(1290);
            expect(docked).toContain(1279);
        });
    }
}

// Rows of the layout one left panel gives, at the widths where the chat used to take the rest of the window below 1280px: chat left, chat width, panel width.
const ONE_PANEL_ROWS = [
    { pageWidth: 30, width: 1279, left: 447.7, chat: 383.7, panel: 420 },
    { pageWidth: 30, width: 1200, left: 420, chat: 360, panel: 420 },
    { pageWidth: 55, width: 1279, left: 287.8, chat: 703.4, panel: 287.8 },
    { pageWidth: 55, width: 1100, left: 280, chat: 605, panel: 280 },
    { pageWidth: 55, width: 1000, left: 280, chat: 550, panel: 280 },
    { pageWidth: 100, width: 1279, left: 280, chat: 999, panel: 280 },
    { pageWidth: 100, width: 1100, left: 280, chat: 820, panel: 280 },
];

for (const row of ONE_PANEL_ROWS) {
    test(`one docked panel at Page Width ${row.pageWidth} and ${row.width}px leaves the chat ${row.chat}px wide`, async ({ page }) => {
        await boot(page, { width: row.width, pageWidth: row.pageWidth, sides: ['left'] });
        await setWidth(page, row.width);
        const read = await readLayout(page);
        expect(read.mode).toBe('docked');
        expect(read.width).toBeCloseTo(row.chat, 0);
        expect(read.left).toBeCloseTo(row.left, 0);
        expect(read.panel).toBeCloseTo(row.panel, 0);
    });
}

test('the panel becomes a sheet where the chat would be under 360px, and the chat does not jump there at Page Width 30', async ({ page }) => {
    await boot(page, { width: 1204, pageWidth: 30, sides: ['left'] });
    await setWidth(page, 1204);
    const docked = await readLayout(page);
    await setWidth(page, 1196);
    const sheet = await readLayout(page);
    expect(docked.mode).toBe('docked');
    expect(docked.width).toBeGreaterThanOrEqual(MIN_CHAT_WIDTH);
    expect(sheet.mode).toBe('sheet');
    // A sheet leaves the chat where its Page Width puts it.
    expect(sheet.width).toBeCloseTo(0.3 * 1196, 0);
    expect(Math.abs(sheet.width - docked.width)).toBeLessThan(10);
    expect(Math.abs(sheet.left - docked.left)).toBeLessThan(10);
    // The panel docks again when the window widens.
    await setWidth(page, 1204);
    expect((await readLayout(page)).mode).toBe('docked');
});

test('the phone layout keeps the chat as wide as the window less the panel', async ({ page }) => {
    await boot(page, { width: 769, pageWidth: 55, sides: ['left'] });
    await setWidth(page, 769);
    const wide = await readLayout(page);
    expect(wide.width).toBeCloseTo(0.55 * 769, 0);
    for (const width of [768, 700]) {
        await setWidth(page, width);
        const read = await readLayout(page);
        expect(read.mode).toBe('docked');
        expect(read.width).toBeCloseTo(width - MIN_PANEL_WIDTH, 0);
        expect(read.left).toBeCloseTo(MIN_PANEL_WIDTH, 0);
    }
});
