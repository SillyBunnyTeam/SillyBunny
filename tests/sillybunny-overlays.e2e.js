import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
});

test.describe.configure({ timeout: 90_000 });

function chatFixtures(currentChatId) {
    const oldTimestamp = Date.now() - (60 * 24 * 60 * 60 * 1000);
    return [
        { file_name: currentChatId, last_mes: Date.now(), chat_items: 2, message_count: 2, file_size: '2 KB', preview_message: 'Current chat' },
        ...Array.from({ length: 16 }, (_, index) => ({
            file_name: index === 0 ? 'QA History Rename' : `QA History Chat ${String(index).padStart(2, '0')}`,
            last_mes: oldTimestamp + index * 1000,
            chat_items: index + 1,
            message_count: index + 1,
            preview_message: `History preview ${index}`,
            file_size: `${index + 1} KB`,
        })),
    ];
}

async function prepareChat(page) {
    await openQuietChatForSmoke(page);
    await page.evaluate(() => window.toastr?.remove());
    const context = await page.evaluate(() => {
        const app = window.SillyTavern.getContext();
        return {
            currentChatId: String(app.getCurrentChatId?.() ?? app.chatId ?? '').replace(/\.jsonl$/i, ''),
            characterId: app.characterId,
        };
    });
    if (!context.currentChatId || context.characterId === undefined) throw new Error('Chat overlay tests need an active character chat.');

    const fixtures = chatFixtures(context.currentChatId);
    const deleteRequests = [];
    const renameRequests = [];
    const exportRequests = [];
    const chatLoadRequests = [];
    await page.route('**/api/characters/chats', route => route.fulfill({ json: fixtures }));
    await page.route('**/api/chats/search', async route => {
        const query = String(route.request().postDataJSON().query ?? '').trim().toLowerCase();
        const matches = query
            ? fixtures.filter(chat => `${chat.file_name} ${chat.preview_message}`.toLowerCase().includes(query))
            : fixtures;
        return route.fulfill({ json: matches });
    });
    await page.route('**/api/chats/get', async route => {
        chatLoadRequests.push(route.request().postDataJSON());
        return route.fulfill({ json: [
            { chat_metadata: {}, name: 'Seraphina', is_user: false, is_system: false, send_date: '2026-10-23', mes: 'Loaded history fixture' },
        ] });
    });
    await page.route('**/api/chats/save', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/export', async route => {
        exportRequests.push(route.request().postDataJSON());
        return route.fulfill({ json: { message: 'QA export complete', result: 'mock chat export' } });
    });
    await page.route('**/api/chats/delete', async route => {
        const payload = route.request().postDataJSON();
        deleteRequests.push(payload);
        const deletedName = payload.chatfile.replace(/\.jsonl$/i, '');
        const index = fixtures.findIndex(chat => chat.file_name === deletedName);
        if (index >= 0) fixtures.splice(index, 1);
        return route.fulfill({ json: {} });
    });
    await page.route('**/api/chats/rename', async route => {
        const payload = route.request().postDataJSON();
        renameRequests.push(payload);
        const sanitizedFileName = payload.renamed_file.replace(/\.jsonl$/i, '');
        const index = fixtures.findIndex(chat => chat.file_name === payload.original_file.replace(/\.jsonl$/i, ''));
        if (index >= 0) fixtures[index].file_name = sanitizedFileName;
        return route.fulfill({ json: { sanitizedFileName } });
    });
    return { context, fixtures, deleteRequests, renameRequests, exportRequests, chatLoadRequests };
}

async function openChatActions(page, width) {
    if (width <= 768) {
        await page.locator('.sb-bottom-chat-chip').click();
        return page.locator('#sb-bottom-chat-sheet .sb-bottom-chat-sheet-actions');
    }
    return page.locator('#sb-bottom-chat-bar .sb-bottom-chat-management-actions');
}

function chatHistoryFocusTarget(page, width) {
    if (width <= 768) return page.locator('.sb-bottom-chat-chip');
    return page.locator('#sb-bottom-chat-bar .sb-bottom-chat-management-actions').getByRole('button', { name: 'View chat files', exact: true });
}

function massDeleteFrame(page, width) {
    const selector = width <= 768
        ? '.sb-dialog-host[data-tier="dialog"]:has(.sb-dialog__page.sb-chat-mass-delete)'
        : '.sb-dialog-host[data-tier="window"]:has(.sb-dialog.sb-chat-mass-delete)';
    return page.locator(selector);
}

async function snapshotLegacyChatTree(page) {
    return page.locator('#select_chat_popup').evaluate(root => {
        const visit = node => ({
            tag: node.tagName,
            id: node.id,
            classes: node.className,
            children: node.id === 'select_chat_div' ? [] : [...node.children].map(visit),
        });
        return visit(root);
    });
}

for (const width of [1440, 390]) {
    test.describe(`${width}px SillyBunny chat overlays`, () => {
        test.use({ viewport: { width, height: 844 }, hasTouch: width === 390, isMobile: width === 390 });

        test('mass delete preserves its Dialog tier, trailing checks and a Cancel-default destructive alert', async ({ page }) => {
            const { context, deleteRequests } = await prepareChat(page);
            const actions = await openChatActions(page, width);
            await actions.getByRole('button', { name: 'Mass delete chats', exact: true }).click();

            const frame = massDeleteFrame(page, width);
            await expect(frame).toBeVisible();
            await expect(frame.locator('#sb-chat-delete-title')).toBeHidden();
            const rows = frame.locator('.sb-chat-delete-row');
            await expect(rows).toHaveCount(17);
            const current = rows.filter({ has: page.locator(`input[value=${JSON.stringify(context.currentChatId)}]`) });
            await expect(current.locator('input[type="checkbox"]')).toBeDisabled();
            const selectAll = frame.locator('[data-sb-editor-field="mass-delete-select-all"]');
            await expect(selectAll).toBeVisible();
            await expect(frame.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
            await expect(frame.getByRole('button', { name: 'Delete older', exact: true })).toBeVisible();
            await rows.last().scrollIntoViewIfNeeded();
            await expect(rows.last()).toBeInViewport();
            const first = rows.filter({ hasText: 'QA History Chat 01' }).first();
            const rowGeometry = await first.evaluate(row => {
                const label = row.querySelector('.ds-row-label').getBoundingClientRect();
                const checkbox = row.querySelector('input[type="checkbox"]').getBoundingClientRect();
                return { labelRight: label.right, checkboxLeft: checkbox.left };
            });
            expect(rowGeometry.checkboxLeft).toBeGreaterThan(rowGeometry.labelRight);
            await first.click();
            await frame.getByRole('button', { name: 'Delete selected', exact: true }).click();

            const confirm = page.locator('dialog[role="alertdialog"]');
            await expect(confirm).toBeVisible();
            await expect(confirm.locator('[data-response="cancel"]')).toBeFocused();
            await page.keyboard.press('Enter');
            await expect(confirm).toHaveCount(0);
            expect(deleteRequests).toHaveLength(0);

            await actions.getByRole('button', { name: 'Mass delete chats', exact: true }).click();
            const reopened = massDeleteFrame(page, width);
            await reopened.locator('.sb-chat-delete-row').filter({ hasText: 'QA History Chat 01' }).click();
            await reopened.getByRole('button', { name: 'Delete selected', exact: true }).click();
            await page.locator('dialog[role="alertdialog"] [data-response="delete"]').click();
            await expect.poll(() => deleteRequests.length).toBe(1);
            expect(deleteRequests[0].chatfile).toBe('QA History Chat 01.jsonl');

            await actions.getByRole('button', { name: 'Mass delete chats', exact: true }).click();
            const olderFrame = massDeleteFrame(page, width);
            await expect(olderFrame).toBeVisible();
            await olderFrame.getByRole('button', { name: 'Delete older', exact: true }).click();
            const olderConfirm = page.locator('dialog[role="alertdialog"]');
            await expect(olderConfirm).toBeVisible();
            await expect(olderConfirm.locator('[data-response="cancel"]')).toBeFocused();
            await olderConfirm.locator('[data-response="delete"]').click();
            await expect.poll(() => deleteRequests.length).toBe(16);
            expect(deleteRequests.slice(1).every(request => request.chatfile !== `${context.currentChatId}.jsonl`)).toBe(true);
        });

        test('Chat History moves its live controls into a searchable Window and keeps file handlers', async ({ page }) => {
            const { renameRequests, deleteRequests, exportRequests } = await prepareChat(page);
            const actions = await openChatActions(page, width);
            await actions.getByRole('button', { name: 'View chat files', exact: true }).click();

            const frame = page.locator('.sb-dialog-host[data-tier="window"]:has(.sb-chat-history-dialog)');
            await expect(frame).toBeVisible();
            await expect(frame.locator('.sb-dialog__title')).toContainText('Chat History');
            await expect(frame.locator('.sb-dialog__subtitle')).toContainText('Seraphina');
            const search = frame.getByRole('searchbox', { name: 'Search', exact: true });
            await expect(search).toBeVisible();
            const searchMetrics = await page.evaluate(() => {
                const tagSearchHost = document.createElement('div');
                tagSearchHost.id = 'tag_view_list';
                const tagSearch = document.createElement('input');
                tagSearch.className = 'text_pole sb-dialog__entry';
                tagSearchHost.append(tagSearch);
                document.body.append(tagSearchHost);
                const read = node => {
                    const style = getComputedStyle(node);
                    return [style.height, style.paddingInline, style.borderRadius, style.backgroundColor];
                };
                const tagMetrics = read(tagSearch);
                tagSearchHost.remove();
                return { tagMetrics, chatMetrics: read(document.querySelector('.sb-chat-history-dialog .sb-dialog__search-input')) };
            });
            expect(searchMetrics.chatMetrics).toEqual(searchMetrics.tagMetrics);
            const historyRows = frame.locator('#select_chat_div .select_chat_block');
            const currentRow = frame.locator('#select_chat_div .select_chat_block[highlight="true"]');
            await expect(currentRow).toHaveAttribute('aria-current', 'true');
            await page.mouse.move(10, 10);
            const rowBackgrounds = await historyRows.evaluateAll(rows => rows.map(row => getComputedStyle(row).backgroundColor));
            expect(rowBackgrounds.every(background => background === rowBackgrounds[0])).toBe(true);
            const rowData = await historyRows.filter({ hasText: 'QA History Chat 01' }).first().evaluate(row => ({
                title: row.querySelector('.select_chat_block_filename')?.textContent,
                date: row.querySelector('.chat_messages_date')?.textContent?.trim(),
                size: row.querySelector('.chat_file_size')?.textContent?.trim(),
                messageCount: row.querySelector('.chat_messages_num')?.textContent?.trim(),
                preview: row.querySelector('.select_chat_block_mes')?.textContent,
                actionNames: [...row.querySelectorAll('.sb-chat-history-row-actions > *')].map(action => action.getAttribute('aria-label') || action.title),
            }));
            const rowTypeMetrics = await page.evaluate(() => {
                const tagHost = document.createElement('div');
                tagHost.className = 'sb-tag-manager';
                tagHost.innerHTML = '<div class="tag_view_item"><span class="ds-entity-row__title">Tag title</span><span class="ds-entity-row__subtitle">Tag subtitle</span></div>';
                const swipeHost = document.createElement('div');
                swipeHost.innerHTML = '<div class="swipe_picker_block"><span class="select_chat_block_filename">Swipe title</span><span class="select_chat_info">Swipe metadata</span><span class="select_chat_block_mes">Swipe preview</span></div>';
                document.body.append(tagHost, swipeHost);
                const read = node => {
                    const style = getComputedStyle(node);
                    return { size: style.fontSize, weight: style.fontWeight };
                };
                const chatRow = document.querySelector('.sb-chat-history-row');
                const metrics = {
                    chatTitle: read(chatRow.querySelector('.sb-chat-history-row-title .select_chat_block_filename')),
                    chatMetadata: read(chatRow.querySelector('.select_chat_info')),
                    chatPreview: read(chatRow.querySelector('.select_chat_block_mes')),
                    tagTitle: read(tagHost.querySelector('.ds-entity-row__title')),
                    tagSubtitle: read(tagHost.querySelector('.ds-entity-row__subtitle')),
                    swipeTitle: read(swipeHost.querySelector('.select_chat_block_filename')),
                    swipeMetadata: read(swipeHost.querySelector('.select_chat_info')),
                    swipePreview: read(swipeHost.querySelector('.select_chat_block_mes')),
                };
                tagHost.remove();
                swipeHost.remove();
                return metrics;
            });
            expect(rowTypeMetrics.chatTitle).toEqual(rowTypeMetrics.tagTitle);
            expect(rowTypeMetrics.tagTitle).toEqual({ size: '13.5px', weight: '600' });
            expect(rowTypeMetrics.tagSubtitle).toEqual({ size: '11.25px', weight: '400' });
            expect(rowTypeMetrics.chatMetadata).toEqual(rowTypeMetrics.tagSubtitle);
            expect(rowTypeMetrics.chatPreview).toEqual(rowTypeMetrics.tagSubtitle);
            expect(rowTypeMetrics.swipeTitle).toEqual({ size: '13.2px', weight: '700' });
            expect(rowTypeMetrics.swipePreview.size).toBe('12.9px');
            expect(rowData.title).toContain('QA History Chat 01');
            expect(rowData.date).toBeTruthy();
            expect(rowData.size).toBe('2 KB');
            expect(rowData.size).not.toMatch(/[(),]/);
            expect(rowData.messageCount).toBe('2 💬');
            expect(rowData.messageCount).not.toMatch(/[(),]/);
            expect(rowData.preview).toBe('History preview 1');
            expect(rowData.actionNames).toEqual(['Rename chat file', 'Export JSONL chat file', 'Delete chat file']);
            const banner = frame.locator('.sb-chat-history-banner');
            await page.evaluate(() => {
                document.querySelector('#chat_cleanup_status').textContent = 'Auto-labeling chats…';
                document.querySelector('#chat_tools_cancel').classList.remove('displayNone');
            });
            await expect(banner).toBeVisible();
            await expect(banner.locator('#chat_cleanup_status')).toHaveAttribute('aria-live', 'polite');
            await frame.getByRole('button', { name: 'Menu', exact: true }).click();
            for (const name of ['Import Chat', 'Backups', 'Label current', 'Label dated', 'Chat cleanup tools', 'Help']) {
                await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
            }
            await frame.getByRole('menuitem', { name: 'Chat cleanup tools', exact: true }).click();
            const cleanup = frame.locator('.sb-dialog__page.sb-chat-history-cleanup-page');
            await expect(cleanup).toBeVisible();
            await expect(cleanup.locator('.sb-dialog__title')).toHaveText('Chat cleanup tools');
            await expect(banner).toBeVisible();
            const cleanupFooter = cleanup.locator(':scope > .sb-dialog__bottom-bar');
            await expect(cleanupFooter.locator('#chat_cleanup_preview')).toBeVisible();
            await expect(cleanupFooter.locator('#chat_cleanup_run')).toHaveClass(/is-destructive/);
            await expect(cleanup.locator('#chat_cleanup_age')).toBeVisible();
            await expect(cleanup.locator('#chat_cleanup_unit')).toBeVisible();
            await expect(cleanup.locator('.ds-chat-history-unit-row .ds-select-row__arrow')).toBeVisible();
            await expect(cleanup.locator('#chat_cleanup_keep')).toBeVisible();
            const ageStyles = await cleanup.locator('#chat_cleanup_age').evaluate(node => {
                const style = getComputedStyle(node);
                return { height: style.height, background: style.backgroundColor, appearance: style.appearance };
            });
            expect(ageStyles.height).toBe('34px');
            expect(ageStyles.appearance).toBe('textfield');
            const datedOnly = cleanup.locator('.chat_cleanup_checkbox');
            await expect(datedOnly.getByRole('switch', { name: 'Dated only', exact: true })).toBeChecked();
            const switchGeometry = await datedOnly.evaluate(row => {
                const label = row.querySelector('.ds-row-label').getBoundingClientRect();
                const control = row.querySelector('input').getBoundingClientRect();
                return { labelRight: label.right, controlLeft: control.left };
            });
            expect(switchGeometry.controlLeft).toBeGreaterThan(switchGeometry.labelRight);
            await datedOnly.getByRole('switch', { name: 'Dated only', exact: true }).uncheck();
            await expect(page.locator('#chat_cleanup_only_dated')).not.toBeChecked();
            await cleanup.getByRole('button', { name: 'Back', exact: true }).click();
            await expect(cleanup).toHaveCount(0);

            const lastRow = frame.locator('#select_chat_div .select_chat_block_wrapper').last();
            await lastRow.scrollIntoViewIfNeeded();
            await expect(lastRow).toBeInViewport();
            await expect(frame.locator('#select_chat_search')).toBeAttached();
            await expect(frame.locator('#shadow_select_chat_popup')).toHaveCount(0);

            await search.fill('QA History Rename');
            const filteredRows = frame.locator('#select_chat_div .select_chat_block_wrapper');
            await expect(filteredRows).toHaveCount(1);
            const renameRow = frame.locator('#select_chat_div .select_chat_block_wrapper').filter({ hasText: 'QA History Rename' });
            await renameRow.getByRole('button', { name: 'Export JSONL chat file', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Export JSONL chat file', exact: true }).click();
            await expect.poll(() => exportRequests.length).toBe(1);
            expect(exportRequests[0]).toMatchObject({ file: 'QA History Rename.jsonl', format: 'jsonl' });
            await renameRow.getByRole('button', { name: 'Export JSONL chat file', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Download chat as plain text document', exact: true }).click();
            await expect.poll(() => exportRequests.length).toBe(2);
            expect(exportRequests[1]).toMatchObject({ file: 'QA History Rename.jsonl', format: 'txt' });
            await renameRow.locator('.renameChatButton').click();
            const renamePopup = page.locator('dialog.popup[open]');
            await expect(renamePopup).toBeVisible();
            const nameInput = renamePopup.locator('.popup-input');
            await nameInput.fill('QA History Renamed');
            await renamePopup.locator('.popup-button-ok').click();
            await expect.poll(() => renameRequests.length).toBe(1);
            expect(renameRequests[0].original_file).toBe('QA History Rename.jsonl');
            expect(renameRequests[0].renamed_file).toBe('QA History Renamed.jsonl');
            await expect(search).toHaveValue('');
            await expect(filteredRows).toHaveCount(17);

            const deleteRow = frame.locator('#select_chat_div .select_chat_block_wrapper').filter({ hasText: 'QA History Renamed' });
            await deleteRow.locator('.PastChat_cross').click();
            const confirm = page.locator('dialog[role="alertdialog"]');
            await expect(confirm).toBeVisible();
            await expect(confirm.locator('[data-response="cancel"]')).toBeFocused();
            await page.keyboard.press('Enter');
            await expect(confirm).toHaveCount(0);
            expect(deleteRequests).toHaveLength(0);
            await deleteRow.locator('.PastChat_cross').evaluate(node => node.click());
            await page.locator('dialog[role="alertdialog"] [data-response="delete"]').click();
            await expect.poll(() => deleteRequests.length).toBe(1);
            expect(deleteRequests[0].chatfile).toBe('QA History Renamed.jsonl');
        });

        test('Chat History restores its complete legacy tree after cleanup navigation and reopen', async ({ page }) => {
            const { fixtures } = await prepareChat(page);
            const focusTarget = chatHistoryFocusTarget(page, width);
            const expectedTree = await snapshotLegacyChatTree(page);

            const openCleanupAndReturn = async () => {
                const actions = await openChatActions(page, width);
                const opener = actions.getByRole('button', { name: 'View chat files', exact: true });
                await opener.click();
                const frame = page.locator('.sb-dialog-host[data-tier="window"]:has(.sb-chat-history-dialog)');
                await expect(frame).toBeVisible();
                await frame.locator('.sb-chat-history-menu').click();
                await frame.getByRole('menuitem', { name: 'Chat cleanup tools', exact: true }).click();
                const cleanup = frame.locator('.sb-dialog__page.sb-chat-history-cleanup-page');
                await cleanup.locator('#chat_cleanup_preview').click();
                await cleanup.getByRole('button', { name: 'Back', exact: true }).click();
                await frame.locator('.sb-dialog__close').click();
                await expect(frame).toHaveCount(0);
                await expect(focusTarget).toBeFocused();
            };

            await openCleanupAndReturn();
            await expect.poll(() => snapshotLegacyChatTree(page)).toEqual(expectedTree);
            await openCleanupAndReturn();
            await expect.poll(() => snapshotLegacyChatTree(page)).toEqual(expectedTree);
            expect(fixtures.length).toBeGreaterThan(0);
        });

        test('Chat History toggles the Backups view and restores the chat list', async ({ page }) => {
            await page.route('**/api/backups/chat/get', route => route.fulfill({ json: [] }));
            await prepareChat(page);
            const actions = await openChatActions(page, width);
            await actions.getByRole('button', { name: 'View chat files', exact: true }).click();
            let frame = page.locator('.sb-dialog-host[data-tier="window"]:has(.sb-chat-history-dialog)');
            await expect(frame).toBeVisible();
            await frame.locator('.sb-chat-history-menu').click();
            await frame.getByRole('menuitem', { name: 'Backups', exact: true }).click();
            await expect(frame.locator('#chat_backups_list')).toBeVisible();
            await expect(frame.locator('#select_chat_div')).toBeHidden();
            await expect(frame.locator('.sb-chat-history-list-page')).toHaveClass(/chatBackupsOpen/);
            await frame.locator('.sb-chat-history-menu').click();
            await frame.getByRole('menuitem', { name: 'Backups', exact: true }).click();
            await expect(frame.locator('#chat_backups_list')).toBeHidden();
            await expect(frame.locator('#select_chat_div')).toBeVisible();
            await expect(frame.locator('.sb-chat-history-list-page')).not.toHaveClass(/chatBackupsOpen/);
            await frame.locator('.sb-dialog__close').click();
            await expect(frame).toHaveCount(0);
            const reopenedActions = await openChatActions(page, width);
            await reopenedActions.getByRole('button', { name: 'View chat files', exact: true }).click();
            frame = page.locator('.sb-dialog-host[data-tier="window"]:has(.sb-chat-history-dialog)');
            await frame.locator('.sb-chat-history-menu').click();
            await page.getByRole('menuitem', { name: 'Backups', exact: true }).click();
            await expect(frame.locator('#chat_backups_list')).toBeVisible();
        });

        test('Chat History covers its navigation, labeling, cleanup, import, and cancel handlers', async ({ page }) => {
            const { fixtures, chatLoadRequests } = await prepareChat(page);
            let releaseGeneration;
            let generationRequests = 0;
            await page.route('**/api/backends/chat-completions/generate', async route => {
                generationRequests += 1;
                await new Promise(resolve => { releaseGeneration = resolve; });
                await route.abort().catch(() => {});
            });

            let actions = await openChatActions(page, width);
            await actions.getByRole('button', { name: 'View chat files', exact: true }).click();
            let frame = page.locator('.sb-dialog-host[data-tier="window"]:has(.sb-chat-history-dialog)');
            await expect(frame).toBeVisible();

            const loadsBeforeNewChat = chatLoadRequests.length;
            await frame.locator('.sb-chat-history-new-chat').click();
            await expect.poll(() => chatLoadRequests.length).toBeGreaterThan(loadsBeforeNewChat);
            await expect(frame).toHaveCount(0);

            actions = await openChatActions(page, width);
            await actions.getByRole('button', { name: 'View chat files', exact: true }).click();
            frame = page.locator('.sb-dialog-host[data-tier="window"]:has(.sb-chat-history-dialog)');
            await expect(frame).toBeVisible();

            await frame.locator('.sb-chat-history-menu').click();
            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('menuitem', { name: 'Import Chat', exact: true }).click();
            await chooserPromise;

            await frame.locator('.sb-chat-history-menu').click();
            await page.getByRole('menuitem', { name: 'Label current', exact: true }).click();
            await expect.poll(() => generationRequests).toBe(1);
            await expect(frame.locator('.sb-chat-history-banner')).toBeVisible();
            await frame.locator('#chat_tools_cancel').click();
            releaseGeneration?.();
            await expect(frame.locator('#chat_tools_cancel')).toHaveClass(/displayNone/);

            fixtures[1].file_name = '2026-01-01@00h00m00s000ms';
            await frame.locator('.sb-chat-history-menu').click();
            await page.getByRole('menuitem', { name: 'Label dated', exact: true }).click();
            await page.locator('dialog.popup[open]').last().locator('.popup-button-ok').click();
            await expect.poll(() => generationRequests).toBe(2);
            await expect(frame.locator('.sb-chat-history-banner')).toBeVisible();
            await frame.locator('#chat_tools_cancel').click();
            releaseGeneration?.();

            await frame.locator('.sb-chat-history-menu').click();
            await page.getByRole('menuitem', { name: 'Chat cleanup tools', exact: true }).click();
            const cleanup = frame.locator('.sb-dialog__page.sb-chat-history-cleanup-page');
            await cleanup.locator('#chat_cleanup_age').fill('30');
            await cleanup.locator('#chat_cleanup_keep').fill('0');
            await cleanup.getByRole('switch', { name: 'Dated only', exact: true }).uncheck();
            fixtures.slice(1).forEach(chat => { chat.last_mes = Date.now() - (120 * 24 * 60 * 60 * 1000); });
            await cleanup.locator('#chat_cleanup_preview').click();
            const previewTitle = page.getByText('Cleanup preview', { exact: true }).last();
            await expect(previewTitle).toBeVisible();
            await page.getByRole('button', { name: 'Back', exact: true }).last().click();
            await cleanup.locator('#chat_cleanup_run').click();
            const confirmation = page.locator('dialog.popup[open]:visible').last();
            await expect(confirmation.locator('.popup-button-cancel')).toBeFocused();
            await confirmation.locator('.popup-button-cancel').click();
            expect(fixtures.length).toBeGreaterThan(0);
        });

        test('selecting a saved chat loads it and closes Chat History', async ({ page }) => {
            const { chatLoadRequests } = await prepareChat(page);
            const actions = await openChatActions(page, width);
            await actions.getByRole('button', { name: 'View chat files', exact: true }).click();
            const frame = page.locator('.sb-dialog-host[data-tier="window"]:has(.sb-chat-history-dialog)');
            await expect(frame).toBeVisible();

            const selectedChat = 'QA History Chat 02';
            await frame.locator('.select_chat_block').filter({ hasText: selectedChat }).click();
            await expect.poll(() => chatLoadRequests.length).toBe(1);
            expect(chatLoadRequests[0].file_name).toBe(selectedChat);
            await expect.poll(() => page.evaluate(() => {
                const app = window.SillyTavern.getContext();
                return String(app.getCurrentChatId?.() ?? app.chatId ?? '').replace(/\.jsonl$/i, '');
            })).toBe(selectedChat);
            await expect(frame).toHaveCount(0);
        });

        test('Chat History shows shared empty states for an empty list and an empty search', async ({ page }) => {
            const { fixtures } = await prepareChat(page);
            fixtures.splice(0);
            const actions = await openChatActions(page, width);
            await actions.getByRole('button', { name: 'View chat files', exact: true }).click();

            const frame = page.locator('.sb-dialog-host[data-tier="window"]:has(.sb-chat-history-dialog)');
            await expect(frame).toBeVisible();
            const statusPage = frame.locator('#select_chat_div .sb-status-page');
            await expect(statusPage).toContainText('TODO(copy)');

            await frame.getByRole('searchbox', { name: 'Search', exact: true }).fill('missing');
            await expect(statusPage).toContainText('No results');
            await expect(statusPage).not.toContainText('TODO(copy)');
            await frame.locator('.sb-dialog__close').click();
            await expect(frame).toHaveCount(0);
            await expect(page.locator('#select_chat_popup').locator('xpath=..')).toHaveAttribute('id', 'shadow_select_chat_popup');
        });
    });
}

function characterFixture() {
    const data = {
        name: 'QA Overlay Character', description: '', personality: '', scenario: '', first_mes: 'QA greeting', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '',
        character_version: '', extensions: { fav: false, talkativeness: 0.5 },
    };
    return { ...data, avatar: 'qa-overlay-character.png', chat: 'qa-overlay-chat', spec: 'chara_card_v2', spec_version: '2.0', data };
}

async function prepareCharacterList(page) {
    const character = characterFixture();
    await page.route('**/api/characters/all', route => route.fulfill({ json: [character] }));
    await page.route('**/api/characters/get', route => route.fulfill({ json: character }));
    await page.route('**/api/characters/chats', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/get', route => route.fulfill({ json: [] }));
    await page.route('**/api/groups/all', route => route.fulfill({ json: [] }));
    const settingsSaves = [];
    await page.route('**/api/settings/save', async route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        settingsSaves.push(payload);
        return route.fulfill({ json: { result: 'ok', version: (payload._version ?? 0) + 1 } });
    });
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60_000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.evaluate(async () => {
        const app = await import('/script.js');
        const state = await import('/scripts/sillybunny-character-list-state.js');
        const { power_user } = await import('/scripts/power-user.js');
        power_user.bogus_folders = false;
        power_user.charListGrid = false;
        document.body.classList.remove('charListGrid');
        await state.switchCharacterListView('characters');
        for (const type of ['fav', 'folder', 'group']) app.entitiesFilter.setFilterData(type, 'UNDEFINED', true);
        app.entitiesFilter.setFilterData('tag', { selected: [], excluded: [] }, true);
        app.entitiesFilter.setFilterData('search', '', true);
        const tags = await import('/scripts/tags.js');
        tags.tags.push(
            { id: 'qa-overlay-tag', name: 'QA Overlay Tag', color: 'rgb(90, 160, 220)', color2: '' },
            { id: 'qa-overlay-added-tag', name: 'QA Added Tag', color: 'rgb(100, 170, 230)', color2: '' },
        );
        tags.tag_map['qa-overlay-character.png'] = ['qa-overlay-tag'];
        await app.printCharacters(false);
        await window.SillyBunnyShell.openTab('characters', 'characters');
    });
    await expect(page.locator('.sb-character-list .character_select')).toBeVisible();
    return { settingsSaves };
}

for (const width of [1440, 390]) {
    test.describe(`${width}px bulk tag editor`, () => {
        test.use({ viewport: { width, height: 844 }, hasTouch: width === 390, isMobile: width === 390 });

        test('bulk tag edits open inside the shared Dialog and retain source controls', async ({ page }) => {
            const { settingsSaves } = await prepareCharacterList(page);
            const list = page.locator('.sb-character-list[data-mounted="true"]');
            await list.locator('.sb-character-list__header [data-action-id="more"]').click();
            await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
            await list.locator('.character_select .ch_name').click();
            await list.locator('.sb-selection-action[data-action-id="tag"]').click();

            const frame = page.locator('.sb-dialog-host[data-tier="dialog"]:has(.sb-bulk-tag-dialog)');
            await expect(frame).toBeVisible();
            await expect(frame.locator('#bulk_tag_popup')).toContainText('Modify tags of 1 characters');
            await expect(frame.locator('#bulkTagInput')).toBeVisible();
            await expect(frame.locator('#bulkTagList')).toBeVisible();
            await expect(frame.locator('#bulk_tag_popup_reset')).toBeVisible();
            await expect(frame.locator('#bulk_tag_popup_remove_mutual')).toBeVisible();
            await expect(frame.locator('#bulk_tag_popup_import_existing_tags')).toBeVisible();
            await expect(frame.locator('.sb-dialog__close')).toBeVisible();

            const tagMap = () => page.evaluate(async () => (await import('/scripts/tags.js')).tag_map['qa-overlay-character.png']);
            const tagInput = frame.locator('#bulkTagInput');
            await tagInput.fill('QA Added Tag');
            const newTag = page.locator('.ui-autocomplete:visible .ui-menu-item').filter({ hasText: 'QA Added Tag' }).first();
            await expect(newTag).toBeVisible();
            await newTag.click();
            await expect.poll(tagMap).toEqual(expect.arrayContaining(['qa-overlay-tag', 'qa-overlay-added-tag']));
            await expect.poll(() => settingsSaves.some(payload => payload.tag_map?.['qa-overlay-character.png']?.includes('qa-overlay-added-tag'))).toBe(true);

            await tagInput.press('Escape');
            await frame.locator('#bulkTagList .tag[id="qa-overlay-tag"] .tag_remove').click();
            await expect.poll(tagMap).toEqual(['qa-overlay-added-tag']);
            await expect.poll(() => settingsSaves.some(payload => {
                const tags = payload.tag_map?.['qa-overlay-character.png'];
                return tags?.length === 1 && tags[0] === 'qa-overlay-added-tag';
            })).toBe(true);
            await frame.locator('.sb-dialog__close').click();
            await expect(frame).toHaveCount(0);
            await expect(page.locator('#bulk_tag_popup')).toHaveCount(0);
        });
    });
}
