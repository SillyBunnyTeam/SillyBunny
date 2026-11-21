import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { waitForAppReady } from './helpers/app-ready.js';

test.setTimeout(60000);

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    await page.route(/\/api\/(?:worldinfo|avatars)\/(?:edit|create|delete|upload|save)$/, route => route.abort());
});

async function prepare(page, width) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await waitForAppReady(page, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
}

async function settleNavigation(page) {
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity));
    // The maintainer's extensions have unrelated, infinite animations; do not let them mask new tab motion.
    await page.evaluate(() => {
        for (const animation of document.getAnimations()) {
            if (animation.effect?.getTiming().iterations === Infinity) animation.cancel();
        }
    });
}

// A toggle's fill eases in over 200 ms when it becomes current, so a read that follows at once sees a mid-transition colour.
async function waitForFillAtRest(toggle) {
    await expect.poll(() => toggle.evaluate(button => button.getAnimations()
        .filter(animation => animation.transitionProperty === 'background-color' && animation.playState === 'running').length)).toBe(0);
}

test('the Home toggle is drawn current at load, without a fill that eases in', async ({ page }) => {
    await page.addInitScript(() => {
        window.__homeToggleTransitions = [];
        document.addEventListener('transitionrun', (event) => {
            if (event.target?.id === 'sb-home-toggle') window.__homeToggleTransitions.push(event.propertyName);
        }, true);
    });
    await prepare(page, 1440);
    await expect(page.locator('#sb-home-toggle')).toHaveClass(/is-current/);
    await waitForFillAtRest(page.locator('#sb-home-toggle'));

    expect(await page.evaluate(() => window.__homeToggleTransitions)).toEqual([]);
});

for (const width of [1440, 390]) {
    test(`Characters uses the Home selected-pill fill at ${width}`, async ({ page }) => {
        await prepare(page, width);
        const home = page.locator('#sb-home-toggle');
        await expect(home).toHaveClass(/is-current/);
        await waitForFillAtRest(home);
        const homeBackground = await home.evaluate(button => getComputedStyle(button).backgroundColor);

        await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
        await expect(page.locator('#sb-settings-page')).toBeVisible();
        await expect(page.locator('#sb-character-toggle')).toHaveClass(/sb-settings-active/);
        await page.mouse.move(0, 0);
        await waitForFillAtRest(page.locator('#sb-character-toggle'));
        const charactersBackground = await page.locator('#sb-character-toggle').evaluate(button => getComputedStyle(button).backgroundColor);

        expect(charactersBackground).toBe(homeBackground);
    });

    test(`Characters highlights synchronously and tab switches are motionless at ${width}`, async ({ page }) => {
        await prepare(page, width);
        const colours = await page.evaluate(() => {
            const button = document.getElementById('sb-character-toggle');
            button.click();
            const icon = getComputedStyle(button.querySelector('i'));
            const probe = document.createElement('i');
            probe.style.color = 'var(--color-primary, var(--sb-accent))';
            document.body.append(probe);
            const accent = getComputedStyle(probe).color;
            probe.remove();
            return {
                active: button.classList.contains('sb-settings-active'),
                legacy: button.classList.contains('is-open'),
                accent,
                icon: icon.color,
                label: getComputedStyle(button.querySelector('span')).color,
                transition: icon.transitionProperty,
            };
        });
        expect(colours.active).toBe(true);
        expect(colours.legacy).toBe(false);
        // An open section is a neutral fill with Accent on its icon alone, and the colour is there on the same frame as the class.
        expect(colours.icon).toBe(colours.accent);
        expect(colours.label).not.toBe(colours.accent);
        expect(colours.transition).not.toContain('color');
        await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
        await settleNavigation(page);
        for (const tab of ['groups', 'characters', 'editor', 'world-info', 'persona', 'import', 'characters']) {
            const state = await page.evaluate(async tab => {
                await window.SillyBunnyShell.openTab('characters', tab);
                const panels = [...document.querySelectorAll('#right-nav-panel .right_menu')].filter(panel => getComputedStyle(panel).display !== 'none');
                return {
                    animations: document.getAnimations().filter(animation => animation.playState === 'running'
                        && animation.effect?.target?.closest('#right-nav-panel, #sb-settings-tab-list')).map(animation => animation.effect?.target?.className),
                    panels: panels.map(panel => ({ opacity: getComputedStyle(panel).opacity, transition: getComputedStyle(panel).transitionProperty })),
                    sidebarTransition: getComputedStyle(document.querySelector('.sb-settings-tab[aria-selected="true"]')).transitionProperty,
                };
            }, tab);
            expect(state.animations, `${tab} should not start animations`).toEqual([]);
            expect(state.sidebarTransition).toBe('none');
            for (const panel of state.panels) {
                expect(panel.opacity).toBe('1');
                expect(panel.transition).not.toContain('opacity');
            }
        }
    });

    for (const tab of ['world-info', 'persona', 'import']) {
        test(`${tab} first open holds its place from the first frame and paints the loading page only after its delay at ${width}`, async ({ page }) => {
            await prepare(page, width);
            await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
            await settleNavigation(page);
            const hostId = { 'world-info': 'sb_character_world_info_panel', persona: 'sb_character_persona_panel', import: 'sb_character_import_panel' }[tab];
            await page.evaluate(({ tab, hostId }) => {
                const load = window.SillyBunnyAssets.loadStylesheetAsync;
                const gate = new Promise(resolve => { window.__p5Release = resolve; });
                window.SillyBunnyAssets.loadStylesheetAsync = async (...args) => {
                    await load(...args);
                    await gate;
                };
                window.__p5Frames = [];
                window.__p5Sampling = true;
                const host = document.getElementById(hostId);
                const start = performance.now();
                const sample = () => {
                    const status = document.querySelector('.sb-character-panel-loading');
                    window.__p5Frames.push({
                        at: performance.now() - start,
                        shown: !host.hidden,
                        waiting: Boolean(status) && !status.hidden,
                        painted: Boolean(status) && !status.hidden && getComputedStyle(status).visibility !== 'hidden',
                        height: status?.getBoundingClientRect().height ?? 0,
                    });
                    if (window.__p5Sampling) requestAnimationFrame(sample);
                };
                window.__p5Opening = window.SillyBunnyShell.openTab('characters', tab);
                requestAnimationFrame(sample);
            }, { tab, hostId });
            await page.waitForFunction(() => window.__p5Frames.some(frame => frame.painted));
            await page.evaluate(() => window.__p5Release());
            await page.evaluate(() => window.__p5Opening);
            await expect(page.locator(`#${hostId}`)).toBeVisible();
            const { frames, delay } = await page.evaluate(async () => {
                for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
                window.__p5Sampling = false;
                return { frames: window.__p5Frames, delay: (await import('/scripts/sillybunny-editor/status-page.js')).STATUS_PAGE_LOADING_DELAY };
            });
            const before = frames.filter(frame => !frame.shown);
            expect(before.length).toBeGreaterThan(delay / 40);
            // The page is there, with its size, on every frame the panel is not; it is painted only once its delay has passed.
            for (const frame of before) {
                expect(frame.waiting).toBe(true);
                expect(frame.height).toBeGreaterThan(0);
            }
            expect(before.filter(frame => frame.painted).map(frame => frame.at).filter(at => at < delay)).toEqual([]);
            expect(before.filter(frame => !frame.painted).map(frame => frame.at).filter(at => at >= delay + 150)).toEqual([]);
        });

        test(`${tab} first open has only loading then a settled final layout at ${width}`, async ({ page }) => {
            await prepare(page, width);
            await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
            await settleNavigation(page);
            const hostId = { 'world-info': 'sb_character_world_info_panel', persona: 'sb_character_persona_panel', import: 'sb_character_import_panel' }[tab];
            await page.evaluate(({ tab, hostId }) => {
                const load = window.SillyBunnyAssets.loadStylesheetAsync;
                const gate = new Promise(resolve => { window.__p2ReleaseStyles = resolve; });
                window.SillyBunnyAssets.loadStylesheetAsync = async (...args) => {
                    await load(...args);
                    await gate;
                };
                window.__p2Frames = [];
                window.__p2Sampling = true;
                const sample = () => {
                    const host = document.getElementById(hostId);
                    const loading = [...document.querySelectorAll('.sb-character-panel-loading')].some(node => !node.hidden);
                    const visible = !host.hidden;
                    const root = host.querySelector('.sb-persona-editor, .sb-wi-editor, #sb_character_import_content');
                    const rect = root?.getBoundingClientRect();
                    window.__p2Frames.push({ loading, visible, width: rect?.width, height: rect?.height, mounted: tab === 'import' ? host.dataset.mounted === 'true' : Boolean(root && !root.hidden) });
                    if (window.__p2Sampling) requestAnimationFrame(sample);
                };
                window.__p2Opening = window.SillyBunnyShell.openTab('characters', tab);
                requestAnimationFrame(sample);
            }, { tab, hostId });
            await expect(page.locator('.sb-character-panel-loading:not([hidden])')).toBeVisible();
            await expect(page.locator(`#${hostId}`)).toBeHidden();
            await page.waitForFunction(() => window.__p2Frames.length >= 3);
            await page.evaluate(() => window.__p2ReleaseStyles());
            await page.evaluate(() => window.__p2Opening);
            await expect(page.locator(`#${hostId}`)).toBeVisible();
            const frames = await page.evaluate(async () => {
                for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
                window.__p2Sampling = false;
                return window.__p2Frames;
            });
            expect(frames.some(frame => frame.loading && !frame.visible)).toBe(true);
            const visible = frames.filter(frame => frame.visible);
            expect(visible.length).toBeGreaterThan(1);
            for (const frame of frames) {
                expect(frame.visible ? !frame.loading && frame.mounted : frame.loading).toBe(true);
            }
            for (const frame of visible) {
                expect(frame.width).toBeCloseTo(visible[0].width, 1);
                expect(frame.height).toBeCloseTo(visible[0].height, 1);
            }
            await expect(page.locator('.sb-import-source-botbooru')).toHaveCount(tab === 'import' ? 1 : 0);
        });
    }
}
