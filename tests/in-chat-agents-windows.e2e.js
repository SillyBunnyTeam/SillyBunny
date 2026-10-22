import { expect, test } from '@playwright/test';
import { openEditorAgents } from './helpers/in-chat-agents-editor.js';
import { seedCompanionPanel } from './helpers/in-chat-agents-companion-panel.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

async function setupWindowSurface(page, baseURL, width) {
    const driver = await openEditorAgents(page, baseURL, width);
    await protectMaintainerServer(page);
    await page.route(/\/api\/.*(?:generate|completion|chat\/completions?)/i, route => route.abort());
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    return driver;
}

async function expectWindowScroll(dialog, selector) {
    const body = dialog.locator('.popup-content');
    await expect.poll(() => body.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await body.evaluate(node => node.scrollTop = node.scrollHeight);
    await expect.poll(() => dialog.locator(selector).evaluate(node => {
        const bodyRect = node.closest('.popup-content').getBoundingClientRect();
        return node.getBoundingClientRect().bottom <= bodyRect.bottom + 1;
    })).toBe(true);
}

for (const width of [1440, 390]) {
    test.describe(`${width}px in-chat agent windows`, () => {
        test('transform history is a scrollable Window viewer with header Close', async ({ page, baseURL }) => {
            const driver = await setupWindowSurface(page, baseURL, width);
            await page.locator('#sb-settings-close').click();
            await page.evaluate(async () => {
                const app = await import('/script.js');
                const runner = await import('/scripts/extensions/in-chat-agents/agent-runner.js');
                const beforeText = `${Array.from({ length: 160 }, (_, index) => `Before ${index + 1}`).join('\n')}\n`;
                const afterText = `${Array.from({ length: 160 }, (_, index) => `After ${index + 1}`).join('\n')}\nlast history sentinel`;
                const message = {
                    name: 'QA Assistant',
                    is_user: false,
                    mes: afterText,
                    extra: {
                        [runner.PROMPT_TRANSFORM_HISTORY_KEY]: [{
                            agentName: 'History fixture',
                            mode: 'replace',
                            beforeText,
                            afterText,
                            order: 1,
                            modelLabel: 'QA model',
                            timestamp: '2026-10-22T00:00:00.000Z',
                        }],
                    },
                };
                app.chat.splice(0, app.chat.length, message);
                const element = document.createElement('div');
                element.className = 'mes';
                element.setAttribute('mesid', '0');
                element.innerHTML = '<span class="tokenCounterDisplay"></span><div class="mes_view_agent_changes" style="display:none"></div>';
                document.getElementById('chat').append(element);
                app.updateMessageMetaBadges(element, message);
            });

            await page.locator('.mes[mesid="0"] .agent-transform-badge').click();
            const dialog = page.locator('dialog[open]');
            await expect(dialog).toHaveClass(/sb-dialog--window/);
            await expect(dialog.locator('.popup-button-close')).toBeVisible();
            await expect(dialog.locator('.popup-button-ok')).toBeHidden();
            await expect(dialog.locator('.ica-transform-history-entry')).toHaveCount(1);
            await expect(dialog.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
            await expect(dialog.getByRole('button', { name: 'Redo', exact: true })).toBeVisible();
            await expect(dialog.locator('.ica-transform-diff')).toContainText('last history sentinel');
            await expectWindowScroll(dialog, '.ica-transform-diff');
            await dialog.locator('.popup-button-close').click();
            await expect(dialog).toHaveCount(0);
            expect(driver.saves()).toHaveLength(0);
            expect(driver.errors).toEqual([]);
        });

        test('post-main review keeps both explicit responses and never calls a model on Skip', async ({ page, baseURL }) => {
            const driver = await setupWindowSurface(page, baseURL, width);
            await page.locator('#sb-settings-close').click();
            await page.evaluate(async () => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const { eventSource, event_types } = await import('/scripts/events.js');
                const runner = await import('/scripts/extensions/in-chat-agents/agent-runner.js');
                const agent = store.getAgentById('editor-pre');
                agent.enabled = true;
                agent.phase = 'pre';
                agent.preProcess.mode = 'intercept';
                agent.preProcess.interceptTiming = 'post-main-generation';
                store.setGlobalSettings({ enabled: true, postMainInterceptShowMessageFirst: true });
                runner.initAgentRunner();
                await eventSource.emit(event_types.GENERATION_STARTED, 'normal', {}, false);
                const eventData = {
                    type: 'normal',
                    text: `${Array.from({ length: 140 }, (_, index) => `Main output ${index + 1}`).join('\n')}\nlast review sentinel`,
                };
                window.__postMainReviewEvent = eventData;
                eventSource.emit(event_types.MAIN_GENERATION_OUTPUT_READY, eventData);
            });

            const dialog = page.locator('dialog[open]');
            await expect(dialog).toHaveClass(/sb-dialog--window/);
            await expect(dialog.locator('.sb-dialog__title')).toHaveText('Review the main output before it is shown in chat.');
            await expect(dialog.locator('.popup-button-close')).toBeHidden();
            await expect(dialog.getByText('Skip intercept', { exact: true })).toBeVisible();
            await expect(dialog.getByText('Continue intercept', { exact: true })).toBeVisible();
            await expect(dialog.locator('.ica--post-main-intercept-review-output')).toContainText('last review sentinel');
            await expectWindowScroll(dialog, '.ica--post-main-intercept-review-output');
            await dialog.getByText('Skip intercept', { exact: true }).click();
            await expect(dialog).toHaveCount(0);
            expect(await page.evaluate(() => window.__postMainReviewEvent.text)).toContain('last review sentinel');
            expect(driver.writes.filter(write => /generate|completion/i.test(write.path))).toEqual([]);
            expect(driver.saves()).toHaveLength(0);
            expect(driver.errors).toEqual([]);
        });

        test('companion note editor keeps Save and Cancel semantics in a Window frame', async ({ page, baseURL }) => {
            const driver = await setupWindowSurface(page, baseURL, width);
            await seedCompanionPanel(page);
            await page.locator('#sb-settings-close').click();
            const card = page.locator('#chat .ica--companion-card').first();
            await card.getByRole('button', { name: 'Edit companion note', exact: true }).click();
            const dialog = page.locator('dialog[open]');
            await expect(dialog).toHaveClass(/sb-dialog--window/);
            await expect(dialog.locator('.sb-dialog__title')).toHaveText('Edit companion note');
            await expect(dialog.locator('.popup-button-cancel')).toHaveText('Cancel');
            await expect(dialog.locator('.popup-button-ok')).toHaveText('Save Note');
            await expect(dialog.locator('.popup-button-close')).toBeHidden();
            const updated = `${Array.from({ length: 30 }, (_, index) => `Edited note ${index + 1}`).join('\n')}\nlast note sentinel`;
            await dialog.locator('.ica--companion-edit-popup textarea').fill(updated);
            await dialog.locator('.popup-button-ok').click();
            await expect(dialog).toHaveCount(0);
            expect(await page.evaluate(async () => {
                const app = await import('/script.js');
                return app.chat[0].extra.inChatAgentCompanionResults['qa-note'].content;
            })).toBe(updated);
            expect(driver.writes.filter(write => /generate|completion/i.test(write.path))).toEqual([]);
            expect(driver.errors).toEqual([]);
        });
    });
}
