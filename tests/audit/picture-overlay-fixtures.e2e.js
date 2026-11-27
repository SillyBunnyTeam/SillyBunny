import { expect, test } from '@playwright/test';
import { LEGACY_THEMES, THEMES, variantContextOptions } from '../helpers/surface-matrix.js';
import { bootSurfaceApp, openSurface } from '../helpers/surfaces/boot.js';
import { surfaceById } from '../helpers/surfaces/index.js';

// The picture overlays that need the registry's seeded fixtures (a group, a quick reply set), so they run under the audit config:
//   ~/bin/e2e -c playwright.audit.config.js audit/picture-overlay-fixtures.e2e.js
// The rest of the family is held by tests/picture-overlays.e2e.js.

test.describe.configure({ timeout: 240_000 });

const THEME_IDS = [...THEMES, ...LEGACY_THEMES].map(theme => theme.id);

async function bootAndOpen(browser, baseURL, surfaceId, variant) {
    const surface = surfaceById(surfaceId);
    const storageState = test.info().project.use.storageState;
    const context = await browser.newContext({ ...variantContextOptions(variant), baseURL, locale: 'en-US', timezoneId: 'UTC', ...(storageState ? { storageState } : {}) });
    const page = await context.newPage();
    await bootSurfaceApp(page, baseURL, { variant, needs: surface.needs });
    await openSurface(page, surface, { viewport: variant.viewport });
    return { page, context };
}

/** The opaque Window layer, as the page computes it, and what a moving window paints. */
function readSurfacePaint(page, selector) {
    return page.evaluate((root) => {
        const probe = document.createElement('div');
        probe.style.backgroundColor = 'var(--sb-layer-window)';
        document.body.append(probe);
        const layer = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const style = getComputedStyle(document.querySelector(root));
        const alpha = /\/\s*([\d.]+)\s*\)$/.exec(style.backgroundColor)?.[1] ?? (/^rgba/.test(style.backgroundColor) ? style.backgroundColor.split(',')[3].replace(')', '').trim() : '1');
        return { background: style.backgroundColor, alpha: Number(alpha), layer, backdrop: style.backdropFilter, webkitBackdrop: style.webkitBackdropFilter };
    }, selector);
}

const PANELS = [
    { id: 'panel.moving.gallery', root: '#gallery' },
    { id: 'panel.moving.quick-reply-popout', root: '#qr--popout' },
    { id: 'panel.moving.group-members-popout', root: '#groupMemberListPopout' },
    { id: 'panel.moving.summary-popout', root: '#summaryExtensionPopout' },
];

for (const panel of PANELS) {
    for (const theme of THEME_IDS) {
        test(`${panel.id} paints the opaque Window layer in ${theme}, so the chat does not show through`, async ({ browser, baseURL }) => {
            const { page, context } = await bootAndOpen(browser, baseURL, panel.id, { viewport: '390x844', theme });
            try {
                const paint = await readSurfacePaint(page, panel.root);
                expect(paint.alpha, `the background ${paint.background} is opaque`).toBe(1);
                expect(paint.background, 'and it is the Window layer').toBe(paint.layer);
                expect(paint.backdrop === 'none' || paint.backdrop === '', 'with no blur behind it').toBe(true);
            } finally {
                await context.close();
            }
        });
    }
}

const VISUAL_NOVEL_VIEWPORTS = ['1440x900', '1024x600', '900x700'];

for (const viewport of VISUAL_NOVEL_VIEWPORTS) {
    test(`Visual Novel sprites stand in the free area above the chat and cover neither it nor the composer at ${viewport}`, async ({ browser, baseURL }) => {
        const { page, context } = await bootAndOpen(browser, baseURL, 'panel.moving.visual-novel', { viewport, theme: 'libadwaita' });
        try {
            const measured = await page.evaluate(() => {
                const box = (element) => {
                    const { left, top, right, bottom } = element.getBoundingClientRect();
                    return { left, top, right, bottom };
                };
                const sheld = document.getElementById('sheld');
                const composer = document.getElementById('send_form');
                const holders = [...document.querySelectorAll('#visual-novel-wrapper .expression-holder:not(.hidden)')];
                const composerBox = box(composer);
                const hit = document.elementFromPoint((composerBox.left + composerBox.right) / 2, (composerBox.top + composerBox.bottom) / 2);
                return {
                    viewport: { width: innerWidth, height: innerHeight },
                    topBar: box(document.getElementById('top-bar')),
                    wrapper: box(document.getElementById('visual-novel-wrapper')),
                    chat: box(sheld),
                    composer: composerBox,
                    holders: holders.map(holder => ({ holder: box(holder), image: box(holder.querySelector('img')) })),
                    composerHit: hit ? { id: hit.id, inSprites: Boolean(hit.closest('#visual-novel-wrapper')) } : null,
                };
            });
            expect(measured.holders.length, 'a sprite shows for every member of the group').toBeGreaterThanOrEqual(2);
            expect(measured.wrapper.top, 'the sprite area starts under the top bar').toBeGreaterThanOrEqual(measured.topBar.bottom - 0.75);
            expect(measured.wrapper.bottom, 'and ends where the chat panel starts').toBeLessThanOrEqual(measured.chat.top + 0.75);
            for (const { holder, image } of measured.holders) {
                expect(holder.top).toBeGreaterThanOrEqual(measured.wrapper.top - 0.75);
                expect(holder.bottom, 'a sprite does not reach into the chat panel').toBeLessThanOrEqual(measured.chat.top + 0.75);
                expect(image.bottom).toBeLessThanOrEqual(measured.chat.top + 0.75);
                expect(image.top).toBeGreaterThanOrEqual(measured.topBar.bottom - 0.75);
            }
            expect(measured.composerHit?.inSprites, 'a press on the composer reaches the composer and not a sprite').toBe(false);
        } finally {
            await context.close();
        }
    });
}
