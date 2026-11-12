import { expect, test } from '@playwright/test';
import { openEditorAgents } from './helpers/in-chat-agents-editor.js';
import { seedCompanionPanel } from './helpers/in-chat-agents-companion-panel.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

const appearance = node => {
    const style = getComputedStyle(node);
    return { fill: style.backgroundColor, border: style.border, radius: style.borderRadius };
};

for (const width of [1440, 390]) {
    test.describe(`${width}px companion panel`, () => {
        test.use({ hasTouch: width === 390, isMobile: width === 390 });

        test('uses shell cards and flat circular actions without browser button fills', async ({ page, baseURL }) => {
            const driver = await openEditorAgents(page, baseURL, width);
            await seedCompanionPanel(page);
            const reference = await driver.root.locator('.ica-agents-box').first().evaluate(appearance);
            await page.evaluate(() => window.$('#themes').val('Libadwaita Light').trigger('change'));
            await expect(page.locator('html')).toHaveAttribute('data-sb-surface-tone', 'light');
            const lightReference = await driver.root.locator('.ica-agents-box').first().evaluate(appearance);
            await page.evaluate(() => window.$('#themes').val('Libadwaita').trigger('change'));
            await expect(page.locator('html')).toHaveAttribute('data-sb-surface-tone', 'dark');
            await page.locator('#sb-settings-close').click();
            await page.locator('#ica_tracker_panel_wand_item').evaluate(node => node.click());
            const panel = page.locator('#ica--tracker-panel');
            await expect(panel).toHaveClass(/is-open/);
            await page.mouse.move(1, 1);
            const buttons = panel.locator('.ica--cdash-action');
            for (const button of await buttons.all()) {
                const style = await button.evaluate(node => {
                    const css = getComputedStyle(node);
                    return { fill: css.backgroundColor, border: css.borderWidth, shadow: css.boxShadow, width: node.offsetWidth, height: node.offsetHeight, title: node.title || node.getAttribute('data-sttt--title') };
                });
                expect.soft(style.fill).toBe('rgba(0, 0, 0, 0)');
                expect.soft(style.border).toBe('0px');
                expect.soft(style.shadow).toBe('none');
                expect.soft(style.title).toBeTruthy();
                expect.soft(style.width).toBe(style.height);
                expect.soft(style.width).toBeGreaterThanOrEqual(width === 390 ? 44 : 40);
            }
            expect(await panel.locator('[data-action="panel-close"]').evaluate(node => node.offsetWidth)).toBe(width === 390 ? 44 : 40);
            for (const card of await panel.locator('.ica--tpanel-agent').all()) expect(await card.evaluate(appearance)).toEqual(reference);
            expect(await page.locator('.ica--companion-card').evaluate(appearance)).toEqual(reference);
            const surface = await panel.evaluate(node => ({ blur: getComputedStyle(node).backdropFilter, overflow: node.scrollWidth - node.clientWidth }));
            expect(surface.blur).toBe('none');
            expect(surface.overflow).toBeLessThanOrEqual(1);
            await page.evaluate(() => window.$('#themes').val('Libadwaita Light').trigger('change'));
            await expect(page.locator('html')).toHaveAttribute('data-sb-surface-tone', 'light');
            for (const card of await panel.locator('.ica--tpanel-agent').all()) expect(await card.evaluate(appearance)).toEqual(lightReference);
            expect(await page.locator('.ica--companion-card').evaluate(appearance)).toEqual(lightReference);
            await page.evaluate(() => window.$('#themes').val('Libadwaita').trigger('change'));
            await expect(page.locator('html')).toHaveAttribute('data-sb-surface-tone', 'dark');
            await page.evaluate(async () => {
                (await import('/scripts/extensions/in-chat-agents/agent-store.js')).getAgentById('qa-scene').sourceTemplateId = 'tpl-chat-only-companion';
                (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).refreshCompanionPanel();
            });
            const input = panel.locator('[data-role="chat-only-input"]');
            await input.fill('QA aside without a model request');
            await expect(input).toHaveValue('QA aside without a model request');
            expect(await input.evaluate(node => getComputedStyle(node).color)).toBe(await panel.evaluate(node => getComputedStyle(node).color));
            await page.evaluate(() => {
                const root = document.documentElement;
                root.style.setProperty('--mainFontSize', `${parseFloat(getComputedStyle(root).getPropertyValue('--mainFontSize')) * 2}px`);
            });
            expect(await panel.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
            await page.evaluate(() => document.documentElement.style.removeProperty('--mainFontSize'));
            const lock = panel.locator('[data-action="panel-lock"]');
            await lock.click();
            await page.mouse.move(1, 1);
            await expect(lock).toHaveAttribute('aria-pressed', 'true');
            expect(await lock.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
            await page.emulateMedia({ forcedColors: 'active' });
            await panel.locator('[data-action="panel-close"]').focus();
            await page.keyboard.press('Tab');
            await page.keyboard.press('Shift+Tab');
            expect(await panel.locator('[data-action="panel-close"]').evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('none');
            await panel.locator('[data-action="panel-close"]').click();
            await expect(panel).not.toHaveClass(/is-open/);
            await expect(page.locator('#ica--tracker-panel-handle')).toBeVisible();
            expect(driver.errors).toEqual([]);
            expect(driver.saves()).toHaveLength(0);
            expect(driver.writes.filter(write => /\/generate(?:[-/]|$)|\/(?:chat\/)?completions?$/.test(write.path))).toEqual([]);
        });

        test('destructive companion actions default to Cancel and ignore Return', async ({ page, baseURL }) => {
            const driver = await openEditorAgents(page, baseURL, width);
            await seedCompanionPanel(page);
            await page.locator('#sb-settings-close').click();
            const card = page.locator('.ica--companion-card').first();
            await card.locator('[data-action="delete"]').click();
            const deleteDialog = page.locator('dialog[open]').last();
            await expect(deleteDialog.locator('.popup-button-cancel')).toBeFocused();
            await page.keyboard.press('Enter');
            await expect(deleteDialog).toHaveCount(0);
            await expect(card).toBeVisible();

            await page.evaluate(async () => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const app = await import('/script.js');
                const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                store.getAgentById('qa-scene').sourceTemplateId = 'tpl-memory-shard-companion';
                app.chat.splice(0, app.chat.length, ...Array.from({ length: 3 }, (_, index) => ({
                    is_user: false,
                    is_system: false,
                    name: 'QA Assistant',
                    mes: `Message ${index}`,
                    extra: { inChatAgentCompanionResults: {
                        'qa-scene': { status: 'done', agentName: 'Memory Shard', content: `State ${index}` },
                    } },
                })));
                panel.refreshCompanionPanel();
            });
            await page.locator('#ica_tracker_panel_wand_item').evaluate(node => node.click());
            const trackerPanel = page.locator('#ica--tracker-panel');
            await expect(trackerPanel).toHaveClass(/is-open/);
            await trackerPanel.locator('[data-action="panel-hide-before"]').click();
            const hideDialog = page.locator('dialog[open]').last();
            await expect(hideDialog.locator('.popup-button-cancel')).toBeFocused();
            await page.keyboard.press('Enter');
            await expect(hideDialog).toHaveCount(0);
            expect(driver.saves()).toHaveLength(0);
        });
    });
}
