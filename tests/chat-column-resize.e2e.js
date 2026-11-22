import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, selectSampleCharacter } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

// A window resize is never animated, as libadwaita does not animate a layout on a resize: the chat column has the width
// of its new window within two frames, with animations on. The one animation that the column has is the way back from Home.
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
    expect(await page.evaluate(() => window.qaWidthTransitions)).toEqual([250]);

    // The animation has ended, and the column is at its own width.
    await expect.poll(() => page.evaluate(() => document.getElementById('sheld').getAnimations().length)).toBe(0);
    expect(await widthAfterTwoFrames(page, 1100)).toBeCloseTo(0.55 * 1100, 0);
    expect(await widthAfterTwoFrames(page, 900)).toBeCloseTo(0.55 * 900, 0);
});
