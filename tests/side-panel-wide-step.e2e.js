/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- The mode of a width (docked or sheet) selects which geometry is asserted. */
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

// A docked panel has one rule at every width above the phone layout, 1280px included: the chat keeps its Page Width,
// moves only as far as the panels need, and the panels become a sheet only when the chat would be under 360px.
// In the phone layout (768px and under) a panel never docks: it is a sheet, as an overlay split view collapses at its breakpoint.
test.use({ contextOptions: { reducedMotion: 'reduce' } });
// A sweep resizes the window about 45 times, which takes WebKit longer than the default timeout.
test.describe.configure({ timeout: 120_000 });

const MIN_CHAT_WIDTH = 360;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 420;

// Every 20 to 50px, with a 1px sweep through 1280px, where the chat must not step.
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

async function boot(page, { width, height = 900, pageWidth, sides, home = false }) {
    await protectMaintainerServer(page);
    // A context that sets its own size (`test.use`) keeps it: Firefox never settles a resize before the first navigation in a mobile context.
    const size = page.viewportSize();
    if (size?.width !== width || size?.height !== height) await page.setViewportSize({ width, height });
    await openQuietChatForSmoke(page, { selectCharacter: !home });
    if (home) await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
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

async function setWidth(page, width, height = 900) {
    await page.setViewportSize({ width, height });
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
            visiblePanels: [...document.querySelectorAll('.sb-side-panel')].filter(panel => !panel.hidden && panel.getClientRects().length > 0).map(panel => panel.dataset.sbSidePanelId),
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

// Rows of the layout that one left panel gives below 1280px, where the chat keeps its Page Width: chat left, chat width, panel width.
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

// 768px is the phone layout, so it is a sheet there at every Page Width, and the panel docks again from 769px where the chat has room for it.
for (const pageWidth of [30, 55, 100]) {
    test(`a side panel is a sheet at 768px and under and docks above it where the chat fits, at Page Width ${pageWidth}`, async ({ page }) => {
        await boot(page, { width: 800, pageWidth, sides: ['left'] });
        const problems = [];
        for (const width of [800, 769, 768, 700, 641, 600, 700, 769]) {
            await setWidth(page, width);
            const read = await readLayout(page);
            const expected = width <= 768 ? { mode: 'sheet' } : expectedLayout({ width, pageWidth, sides: ['left'] });
            const failures = [
                [read.mode !== expected.mode, `${read.mode}, expected ${expected.mode}`],
                [read.visiblePanels.length !== 1, `${read.visiblePanels.length} panels shown`],
                [read.overflow > 0, `scrolls sideways by ${read.overflow}`],
                // A sheet leaves the chat as the layout of its width has it: the full window in the phone layout.
                [width <= 768 && (Math.abs(read.width - width) > 1 || Math.abs(read.left) > 1), `chat ${read.width}px wide at ${read.left}`],
            ];
            problems.push(...failures.filter(([failed]) => failed).map(([, text]) => `${width}: ${text}`));
        }
        expect(problems).toEqual([]);
    });
}

test('two panels leave one sheet in the phone layout, and the first stays closed when the window widens', async ({ page }) => {
    await boot(page, { width: 1100, pageWidth: 55, sides: ['left', 'right'] });
    await setWidth(page, 1100);
    const both = await readLayout(page);
    expect(both.mode).toBe('docked');
    expect(both.visiblePanels).toEqual(['qa-side-panel-left', 'qa-side-panel-right']);
    await setWidth(page, 768);
    const phone = await readLayout(page);
    expect(phone.mode).toBe('sheet');
    expect(phone.visiblePanels).toEqual(['qa-side-panel-right']);
    await setWidth(page, 1100);
    const wide = await readLayout(page);
    expect(wide.mode).toBe('docked');
    expect(wide.visiblePanels).toEqual(['qa-side-panel-right']);
});

// Home is wider than the chat: min(max(1120px, Page Width), window - 32px). A panel docks against it above the phone layout.
test('a docked panel on Home takes its share of the Home width and is a sheet at 768px and under', async ({ page }) => {
    await boot(page, { width: 1440, pageWidth: 55, sides: ['left'], home: true });
    const problems = [];
    for (const width of [1440, 1280, 1100, 900, 769, 768, 700]) {
        await setWidth(page, width);
        const read = await readLayout(page);
        if (width <= 768) {
            if (read.mode !== 'sheet') problems.push(`${width}: ${read.mode}, expected sheet`);
            continue;
        }
        const home = Math.min(Math.max(1120, width * 0.55), width - 32);
        const expected = expectedLayout({ width, pageWidth: 100 * home / width, sides: ['left'] });
        if (read.mode !== 'docked') problems.push(`${width}: ${read.mode}, expected docked`);
        else if (Math.abs(read.width - expected.chat) > 1 || Math.abs(read.left - expected.left) > 1) problems.push(`${width}: chat ${read.width}px wide at ${read.left}, expected ${expected.chat} at ${expected.left}`);
    }
    expect(problems).toEqual([]);
});

// A phone held sideways is wider than 768px, so it is not in the phone layout: LAYOUT_MOBILE_QUERY is (max-width: 768px) and
// has no height in it. What a touch screen that is 450px tall or less gets is the compact bottom bar (the shell's mobile UI
// mode), which is a different query, so a panel docks there as it does on a desktop window, and is a sheet only when the chat
// would be under 360px. A sheet 50dvh high would leave under 200px of a 390px screen.
for (const touch of [false, true]) {
    test.describe(`a landscape phone, 844x390, ${touch ? 'with' : 'without'} a touch screen`, () => {
        test.use({ viewport: { width: 844, height: 390 }, ...(touch ? { hasTouch: true, isMobile: true } : {}) });

        test('is outside the phone layout, and a panel docks beside the chat at its Page Width', async ({ page }) => {
            await boot(page, { width: 844, height: 390, pageWidth: 55, sides: ['left'] });
            await setWidth(page, 844, 390);
            const queries = await page.evaluate(() => ({
                phoneLayout: matchMedia('(max-width: 768px)').matches,
                compactBar: matchMedia('(max-width: 768px), (pointer: coarse) and (max-height: 450px)').matches,
                mode: document.documentElement.dataset.sbMobileUiMode,
            }));
            const read = await readLayout(page);
            const expected = expectedLayout({ width: 844, pageWidth: 55, sides: ['left'] });
            expect(queries.phoneLayout).toBe(false);
            expect(queries.compactBar).toBe(touch);
            expect(queries.mode).toBe(touch ? 'mobile' : 'desktop');
            expect(expected.mode).toBe('docked');
            expect(read.mode).toBe('docked');
            expect(read.width).toBeCloseTo(expected.chat, 0);
            expect(read.left).toBeCloseTo(expected.left, 0);
        });
    });
}
