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
        { file_name: currentChatId, last_mes: Date.now(), chat_items: 2, preview_message: 'Current chat' },
        ...Array.from({ length: 16 }, (_, index) => ({
            file_name: index === 0 ? 'QA History Rename' : `QA History Chat ${String(index).padStart(2, '0')}`,
            last_mes: oldTimestamp + index * 1000,
            chat_items: index + 1,
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

for (const width of [1440, 390]) {
    test.describe(`${width}px SillyBunny chat overlays`, () => {
        test.use({ viewport: { width, height: 844 }, hasTouch: width === 390, isMobile: width === 390 });

        test('mass delete uses a Window, trailing checks and a Cancel-default destructive alert', async ({ page }) => {
            const { context, deleteRequests } = await prepareChat(page);
            const actions = await openChatActions(page, width);
            await actions.getByRole('button', { name: 'Mass delete chats', exact: true }).click();

            const frame = page.locator('.sb-dialog-host[data-tier="window"]:has(.sb-chat-mass-delete)');
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
            const reopened = page.locator('.sb-dialog-host[data-tier="window"]:has(.sb-chat-mass-delete)');
            await reopened.locator('.sb-chat-delete-row').filter({ hasText: 'QA History Chat 01' }).click();
            await reopened.getByRole('button', { name: 'Delete selected', exact: true }).click();
            await page.locator('dialog[role="alertdialog"] [data-response="delete"]').click();
            await expect.poll(() => deleteRequests.length).toBe(1);
            expect(deleteRequests[0].chatfile).toBe('QA History Chat 01.jsonl');

            await actions.getByRole('button', { name: 'Mass delete chats', exact: true }).click();
            const olderFrame = page.locator('.sb-dialog-host[data-tier="window"]:has(.sb-chat-mass-delete)');
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
            const search = frame.getByRole('searchbox', { name: 'Search', exact: true });
            await expect(search).toBeVisible();
            const datedOnly = frame.locator('.chat_cleanup_checkbox');
            await expect(datedOnly.getByRole('switch', { name: 'Dated only', exact: true })).toBeChecked();
            const switchGeometry = await datedOnly.evaluate(row => {
                const label = row.querySelector('.ds-row-label').getBoundingClientRect();
                const control = row.querySelector('input').getBoundingClientRect();
                return { labelRight: label.right, controlLeft: control.left };
            });
            expect(switchGeometry.controlLeft).toBeGreaterThan(switchGeometry.labelRight);
            await datedOnly.getByRole('switch', { name: 'Dated only', exact: true }).uncheck();
            await expect(page.locator('#chat_cleanup_only_dated')).not.toBeChecked();

            const lastRow = frame.locator('#select_chat_div .select_chat_block_wrapper').last();
            await lastRow.scrollIntoViewIfNeeded();
            await expect(lastRow).toBeInViewport();
            await expect(frame.locator('#select_chat_search')).toBeAttached();
            await expect(frame.locator('#shadow_select_chat_popup')).toHaveCount(0);

            await search.fill('QA History Rename');
            const filteredRows = frame.locator('#select_chat_div .select_chat_block_wrapper');
            await expect(filteredRows).toHaveCount(1);
            const renameRow = frame.locator('#select_chat_div .select_chat_block_wrapper').filter({ hasText: 'QA History Rename' });
            await renameRow.locator('.exportRawChatButton').click();
            await expect.poll(() => exportRequests.length).toBe(1);
            expect(exportRequests[0]).toMatchObject({ file: 'QA History Rename.jsonl', format: 'jsonl' });
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
            // The legacy skull spins continuously on hover, so dispatch its production click handler without the stability wait.
            await deleteRow.locator('.PastChat_cross').evaluate(node => node.click());
            await page.locator('dialog[role="alertdialog"] [data-response="delete"]').click();
            await expect.poll(() => deleteRequests.length).toBe(1);
            expect(deleteRequests[0].chatfile).toBe('QA History Renamed.jsonl');
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
