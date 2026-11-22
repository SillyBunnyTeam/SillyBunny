import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, selectSampleCharacter } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

// A window resize is never animated, as libadwaita does not animate a layout on a resize: the chat column has the box
// of its new window within two frames, with animations on. The column animates only when something else changes it: the way
// back from Home, and a panel that docks beside it.
test.use({ contextOptions: { reducedMotion: 'no-preference' } });

const HOME_WIDTH = 1120;
const WIDTHS = [1400, 1300, 1200, 1100, 1000, 900, 800];

async function boot(page, { width, pageWidth, home }) {
    await protectMaintainerServer(page);
    await page.setViewportSize({ width, height: 900 });
    await openQuietChatForSmoke(page, { selectCharacter: !home });
    await page.evaluate(pageWidth => {
        // The saved setting can be on in a shared data root; this spec is about the default, animations on.
        document.body.classList.remove('reduced-motion');
        document.documentElement.style.setProperty('--sheldWidth', `${pageWidth}vw`);
    }, pageWidth);
    if (home) await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
}

/** The width of the column in the second frame after a resize, the first frame that can show a width that trails. */
async function widthAfterTwoFrames(page, width) {
    await page.setViewportSize({ width, height: 900 });
    return page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.getElementById('sheld').getBoundingClientRect().width)));
    }));
}

/** The shared duration of a layout transition, in milliseconds, from the token that the transitions are written with. */
function normalDuration(page) {
    return page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sb-duration-normal')));
}

/** Registers one panel on the left, as the panel specs do, and returns the function that opens it. */
async function registerPanel(page) {
    await page.evaluate(async () => {
        const source = document.createElement('section');
        source.id = 'qa-resize-panel';
        source.textContent = 'Panel';
        document.getElementById('movingDivs').append(source);
        const sidePanels = await import('/scripts/sillybunny-editor/side-panel.js');
        window.qaResizePanel = sidePanels.registerSidePanel({ id: 'qa-resize-panel', element: source, title: 'Test Panel', defaultSide: 'left' });
    });
}

/** The box of the column in the second frame after a resize. */
async function boxAfterTwoFrames(page, width) {
    await page.setViewportSize({ width, height: 900 });
    return page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const box = document.getElementById('sheld').getBoundingClientRect();
            resolve({ width: box.width, left: box.left });
        }));
    }));
}

/** Records the width transitions that the column has the moment Home ends. */
function watchHomeEnd(page) {
    return page.evaluate(() => {
        const shell = document.getElementById('sheld');
        window.qaWidthTransitions = [];
        const observer = new MutationObserver(() => {
            if (shell.hasAttribute('data-sb-home')) return;
            observer.disconnect();
            window.qaWidthTransitions = shell.getAnimations()
                .filter(animation => animation.transitionProperty === 'width')
                .map(animation => animation.effect.getComputedTiming().duration);
        });
        observer.observe(shell, { attributes: true, attributeFilter: ['data-sb-home'] });
    });
}

async function sweep(page, expectedWidth) {
    const reads = [];
    for (const width of WIDTHS) reads.push({ width, read: await widthAfterTwoFrames(page, width), expected: expectedWidth(width) });
    return reads.filter(({ read, expected }) => Math.abs(read - expected) > 1).map(({ width, read, expected }) => `${width}: ${read}px, expected ${expected}`);
}

for (const pageWidth of [30, 55]) {
    test(`the chat column has the width of its window within two frames, with animations on, at Page Width ${pageWidth}`, async ({ page }) => {
        await boot(page, { width: WIDTHS[0], pageWidth, home: false });
        expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: no-preference)').matches && !document.body.classList.contains('reduced-motion'))).toBe(true);
        expect(await sweep(page, width => (width * pageWidth) / 100)).toEqual([]);
    });
}

test('the Home column has the width of its window within two frames, with animations on', async ({ page }) => {
    await boot(page, { width: WIDTHS[0], pageWidth: 55, home: true });
    expect(await sweep(page, width => Math.min(Math.max(HOME_WIDTH, width * 0.55), width - 32))).toEqual([]);
});

test('leaving Home animates the column once, and the next resize does not', async ({ page }) => {
    await boot(page, { width: 1440, pageWidth: 55, home: true });
    await watchHomeEnd(page);
    await selectSampleCharacter(page);
    await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/);
    expect(await page.evaluate(() => window.qaWidthTransitions)).toEqual([await normalDuration(page)]);

    // The animation has ended, and the column is at its own width.
    await expect.poll(() => page.evaluate(() => document.getElementById('sheld').getAnimations().length)).toBe(0);
    expect(await widthAfterTwoFrames(page, 1100)).toBeCloseTo(0.55 * 1100, 0);
    expect(await widthAfterTwoFrames(page, 900)).toBeCloseTo(0.55 * 900, 0);
});

test.describe('beside a docked panel', () => {
    test('the column has its box within two frames of a resize, with animations on', async ({ page }) => {
        await boot(page, { width: WIDTHS[0], pageWidth: 55, home: false });
        await registerPanel(page);
        await page.evaluate(() => window.qaResizePanel.open({}));
        await expect(page.locator('body')).toHaveClass(/sb-has-docked-panel/);
        // The panel's own opening has ended, so what the sweep sees is the resize.
        await expect.poll(() => page.evaluate(() => document.getElementById('sheld').getAnimations().length)).toBe(0);
        // A resize that takes the browser longer than a transition to report would hide a transition in the boxes, so the
        // transitions that start are counted as well.
        await page.evaluate(() => {
            window.qaTransitions = [];
            document.getElementById('sheld').addEventListener('transitionrun', event => window.qaTransitions.push(event.propertyName));
        });
        const problems = [];
        for (const width of WIDTHS) {
            const box = await boxAfterTwoFrames(page, width);
            // One panel on the left takes the gutter, 280px to 420px, and the chat keeps its Page Width beside it.
            const expected = { width: 0.55 * width, left: Math.min(Math.max(0.225 * width, 280), 420) };
            problems.push(...[
                [Math.abs(box.width - expected.width) > 1, `${box.width}px wide, expected ${expected.width}`],
                [Math.abs(box.left - expected.left) > 1, `starts at ${box.left}px, expected ${expected.left}`],
            ].filter(([failed]) => failed).map(([, text]) => `${width}: ${text}`));
        }
        expect(problems).toEqual([]);
        expect(await page.evaluate(() => window.qaTransitions)).toEqual([]);
    });

    test('a panel that docks moves the column with a transition, and the next resize does not', async ({ page }) => {
        // At 1000px and Page Width 55 the chat is centred 225px from the edge and the panel takes 280px, so docking moves it 55px.
        await boot(page, { width: 1000, pageWidth: 55, home: false });
        await registerPanel(page);
        await page.evaluate(() => {
            window.qaTransitions = [];
            document.getElementById('sheld').addEventListener('transitionrun', event => window.qaTransitions.push(event.propertyName));
        });
        await page.evaluate(() => window.qaResizePanel.open({}));
        await expect(page.locator('body')).toHaveClass(/sb-has-docked-panel/);
        await expect.poll(() => page.evaluate(() => window.qaTransitions)).toContain('transform');
        await expect.poll(() => page.evaluate(() => document.getElementById('sheld').getAnimations().length)).toBe(0);
        expect(await page.evaluate(() => window.qaTransitions.length)).toBeGreaterThan(0);

        await page.evaluate(() => { window.qaTransitions.length = 0; });
        const box = await boxAfterTwoFrames(page, 900);
        expect(box.width).toBeCloseTo(0.55 * 900, 0);
        expect(box.left).toBeCloseTo(280, 0);
        expect(await page.evaluate(() => window.qaTransitions)).toEqual([]);
    });

    test('a panel that leaves moves the column back with a transition, and the next resize does not', async ({ page }) => {
        await boot(page, { width: 1000, pageWidth: 55, home: false });
        await registerPanel(page);
        await page.evaluate(() => window.qaResizePanel.open({}));
        await expect(page.locator('body')).toHaveClass(/sb-has-docked-panel/);
        await expect.poll(() => page.evaluate(() => document.getElementById('sheld').getAnimations().length)).toBe(0);
        await page.evaluate(() => {
            window.qaTransitions = [];
            document.getElementById('sheld').addEventListener('transitionrun', event => window.qaTransitions.push(event.propertyName));
            window.qaResizePanel.close();
        });
        await expect(page.locator('body')).not.toHaveClass(/sb-has-docked-panel/);
        await expect.poll(() => page.evaluate(() => window.qaTransitions)).toContain('transform');
        await expect.poll(() => page.evaluate(() => document.getElementById('sheld').getAnimations().length)).toBe(0);

        await page.evaluate(() => { window.qaTransitions.length = 0; });
        const box = await boxAfterTwoFrames(page, 900);
        expect(box.width).toBeCloseTo(0.55 * 900, 0);
        expect(await page.evaluate(() => window.qaTransitions)).toEqual([]);
    });
});
