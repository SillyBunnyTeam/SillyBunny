import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.setTimeout(60000);

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    await page.route(/\/api\/(?:worldinfo|avatars)\/(?:edit|create|delete|upload|save)$/, route => route.abort());
});

async function prepare(page, width) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
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

for (const width of [1440, 390]) {
    test(`Characters highlights synchronously and tab switches are motionless at ${width}`, async ({ page }) => {
        await prepare(page, width);
        const colours = await page.evaluate(() => {
            const button = document.getElementById('sb-character-toggle');
            button.click();
            const icon = getComputedStyle(button.querySelector('i'));
            return {
                active: button.classList.contains('sb-settings-active'),
                legacy: button.classList.contains('is-open'),
                icon: icon.color,
                label: getComputedStyle(button.querySelector('span')).color,
                transition: icon.transitionProperty,
            };
        });
        expect(colours.active).toBe(true);
        expect(colours.legacy).toBe(false);
        expect(colours.icon).toBe(colours.label);
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
