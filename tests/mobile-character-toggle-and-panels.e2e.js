import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

async function boot(page, viewport) {
    await protectMaintainerServer(page);
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
}

test.describe('round 1 character opening measurements', () => {
    test.use({ hasTouch: true, isMobile: true, reducedMotion: 'no-preference' });
    for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }, { width: 412, height: 915 }]) {
        test(`round 1 character opening measurement ${viewport.width}`, async ({ page }) => {
            await boot(page, viewport);
            if (viewport.width === 360) {
                await page.evaluate(async () => {
                    const app = await import('/script.js');
                    app.characters.splice(0, app.characters.length);
                    await app.printCharacters(false);
                });
            }
            if (viewport.width === 390) {
                await page.evaluate(async () => {
                    const { registerAuthorsNotePanel } = await import('/scripts/sillybunny-editor/adapters/side-panels.js');
                    const controller = registerAuthorsNotePanel();
                    await controller.open({ opener: document.getElementById('sb-character-toggle') });
                });
                await expect(page.locator('.sb-side-panel:visible')).toHaveCount(1);
            }
            await page.evaluate(() => {
                const chat = document.getElementById('chat');
                for (let index = chat?.children.length ?? 0; index < 40; index++) {
                    const message = document.createElement('div');
                    message.className = 'mes sb-mes-sized';
                    message.innerHTML = '<div class="mes_text">QA chat history message with enough text to produce a stable layout width and height.</div>';
                    chat?.prepend(message);
                }
                window.__round1CharacterFrames = [];
                window.__round1CharacterMutations = [];
                window.__round1CharacterResizeCount = 0;
                const sheet = document.getElementById('right-nav-panel');
                if (sheet) {
                    new MutationObserver(mutations => window.__round1CharacterMutations.push(mutations.map(mutation => ({ attributeName: mutation.attributeName, value: sheet.getAttribute(mutation.attributeName) }))))
                        .observe(sheet, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
                }
                const resizeObserver = new ResizeObserver(() => { window.__round1CharacterResizeCount++; });
                for (const element of [sheet, document.querySelector('.sb-character-list__header'), document.querySelector('.sb-character-list__box'), document.querySelector('#character_search_bar')].filter(Boolean)) resizeObserver.observe(element);
                window.__round1CharacterSample = () => {
                    const selectors = {
                        sheet: '#right-nav-panel',
                        list: '.sb-character-list',
                        header: '.sb-character-list__header',
                        firstRows: '.sb-character-list__box .ds-entity-row:nth-child(-n+3)',
                        search: '#character_search_bar',
                    };
                    const rect = element => {
                        if (!element) return null;
                        const box = element.getBoundingClientRect();
                        return { x: box.x, y: box.y, width: box.width, height: box.height };
                    };
                    window.__round1CharacterFrames.push({
                        time: performance.now(),
                        sheet: rect(document.querySelector(selectors.sheet)),
                        list: rect(document.querySelector(selectors.list)),
                        header: rect(document.querySelector(selectors.header)),
                        rows: [...document.querySelectorAll(selectors.firstRows)].map(rect),
                        search: rect(document.querySelector(selectors.search)),
                        scrollTop: document.scrollingElement?.scrollTop ?? null,
                        visualViewport: window.visualViewport ? { offsetTop: window.visualViewport.offsetTop, offsetLeft: window.visualViewport.offsetLeft, width: window.visualViewport.width, height: window.visualViewport.height } : null,
                    });
                    if (performance.now() - window.__round1CharacterStart < 1700) requestAnimationFrame(window.__round1CharacterSample);
                    else window.__round1CharacterDone = true;
                };
                window.__round1CharacterStart = performance.now();
                window.__round1CharacterDone = false;
                requestAnimationFrame(window.__round1CharacterSample);
            });
            const orphanBefore = await page.locator('#sb-mobile-chat-search').evaluate(element => element.getClientRects().length > 0);
            expect(orphanBefore).toBe(false);
            await page.locator('#sb-character-toggle').tap();
            await page.waitForFunction(() => window.__round1CharacterDone);
            const result = await page.evaluate(() => ({ frames: window.__round1CharacterFrames, mutations: window.__round1CharacterMutations, resizeCount: window.__round1CharacterResizeCount }));
            await test.info().attach(`character-opening-${viewport.width}`, { body: JSON.stringify(result), contentType: 'application/json' });
            const visible = result.frames.filter(frame => frame.list?.width > 0 && frame.list?.height > 0);
            expect(visible.length).toBeGreaterThan(3);
            expect(result.resizeCount).toBeGreaterThan(0);
            const firstVisible = visible[0];
            const settled = visible.filter(frame => frame.time >= firstVisible.time + 700 && frame.header);
            expect(settled.length).toBeGreaterThan(10);
            const geometryTargets = [
                ['sheet', frame => frame.sheet],
                ['header', frame => frame.header],
                settled.some(frame => frame.rows[0]) ? ['first row', frame => frame.rows[0]] : null,
            ].filter(Boolean);
            for (const [name, readGeometry] of geometryTargets) {
                const geometry = settled.map(readGeometry).filter(Boolean);
                expect(geometry.length, `${name} has enough settled samples`).toBeGreaterThan(10);
                const deltas = geometry.slice(1).map((next, index) => ({
                    x: next.x - geometry[index].x,
                    y: next.y - geometry[index].y,
                    width: next.width - geometry[index].width,
                    height: next.height - geometry[index].height,
                }));
                const largestFrameDelta = Math.max(...deltas.flatMap(delta => Object.values(delta).map(Math.abs)));
                expect(largestFrameDelta, `${name} moves after the opening travel`).toBeLessThanOrEqual(1);
                for (const property of ['x', 'y', 'width', 'height']) {
                    const changes = deltas.map(delta => delta[property]).filter(change => Math.abs(change) > 0.05);
                    const reversals = changes.slice(1).filter((change, index) => Math.sign(change) !== Math.sign(changes[index])).length;
                    expect(reversals, `${name} oscillates on ${property}`).toBe(0);
                }
            }
            expect(await page.locator('#sb-mobile-chat-search').evaluate(element => element.getClientRects().length > 0)).toBe(false);
        });
    }
});

test.describe('mobile chat tools lifecycle', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'no-preference' });

    test('restores its close button across button and Escape reopen cycles', async ({ page }) => {
        await boot(page, { width: 390, height: 844 });
        const tools = page.locator('#sb-mobile-chat-tools');
        const close = page.locator('#sb-mobile-chat-close');
        const openTools = async () => {
            await page.evaluate(() => window.SillyBunnyShell.openChatTools());
            await expect(tools).toHaveClass(/sb-chat-tools-open/);
            await expect(close).toBeVisible();
        };
        const expectClosed = async () => {
            await expect(tools).toBeHidden();
            await expect(page.locator('#sb-mobile-chat-search')).toBeHidden();
        };

        await openTools();
        await close.click();
        await expectClosed();
        await openTools();
        await page.keyboard.press('Escape');
        await expectClosed();
        await openTools();
        await close.click();
        await expectClosed();
    });
});

test('round 1 Toggle Panels measurement', async ({ page }) => {
    await boot(page, { width: 1440, height: 900 });
    const state = async () => page.evaluate(() => ({
        topBar: getComputedStyle(document.getElementById('top-bar')).display,
        settingsHolder: getComputedStyle(document.getElementById('top-settings-holder')).display,
        chatRadius: document.getElementById('chat').style.borderRadius,
        chatSearch: [...document.querySelectorAll('#sb-mobile-chat-search, #sb-mobile-chat-tools-panel input[type="search"], input[placeholder="Search this chat..."]')].map(element => ({ id: element.id, visible: element.getClientRects().length > 0, value: element.value })),
        chatTools: document.getElementById('sb-mobile-chat-tools')?.className,
        searchDetails: (() => {
            const element = document.querySelector('#sb-mobile-chat-search');
            if (!element) return null;
            const ancestors = [];
            for (let ancestor = element.parentElement; ancestor && ancestors.length < 5; ancestor = ancestor.parentElement) ancestors.push({ id: ancestor.id, className: ancestor.className, hidden: ancestor.hidden, display: getComputedStyle(ancestor).display, visibility: getComputedStyle(ancestor).visibility });
            return { parent: element.parentElement?.outerHTML.slice(0, 500), ancestors };
        })(),
    }));
    await page.locator('#option_settings').evaluate(element => element.click());
    const on = await state();
    await page.locator('#option_settings').evaluate(element => element.click());
    const off = await state();
    await test.info().attach('toggle-panels', { body: JSON.stringify({ on, off }), contentType: 'application/json' });
    expect(on.chatSearch.some(item => item.visible), JSON.stringify({ on, off })).toBe(false);
    expect(off.chatSearch.some(item => item.visible), JSON.stringify({ on, off })).toBe(false);
});
