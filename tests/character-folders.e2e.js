import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { visiblePageClose } from './helpers/dialog-pages.js';
import { expectSharedDialogEntryStyles } from './helpers/dialog-entry-parity.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

function readPayload(request) {
    const body = request.postDataBuffer();
    if (!body) return {};
    const decoded = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(body) : body;
    return JSON.parse(decoded.toString());
}

function makeCharacters(count) {
    return Array.from({ length: count }, (_, index) => {
        const name = `Folder QA ${index}`;
        const data = { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], extensions: { fav: false, talkativeness: 0.5 } };
        return { ...data, avatar: `folder-qa-${index}.png`, chat: `folder-qa-chat-${index}`, create_date: `2026-10-0${index + 1}`, date_added: index + 1, spec: 'chara_card_v2', spec_version: '2.0', data };
    });
}

/**
 * Routes the startup settings through `edit`, so the app loads them exactly as it would from disk.
 * @returns {{ saved: object[] }} Settings payloads the page tried to save.
 */
async function routeSettings(page, edit) {
    const state = { saved: [] };
    await page.route('**/api/settings/get', async route => {
        const payload = await fetchJsonOrSkip(route);
        if (!payload) return;
        const settings = JSON.parse(payload.settings);
        edit(settings);
        return route.fulfill({ json: { ...payload, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/settings/save', route => {
        const payload = readPayload(route.request());
        state.saved.push(payload);
        return route.fulfill({ json: { result: 'ok', version: (payload._version ?? 0) + 1 } });
    });
    return state;
}

async function routeCharacters(page, characters) {
    await page.route('**/api/characters/all', route => route.fulfill({ json: characters }));
    await page.route('**/api/characters/get', route => route.fulfill({ json: characters.find(character => character.avatar === readPayload(route.request()).avatar_url) }));
    await page.route('**/api/characters/chats', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/get', route => route.fulfill({ json: [] }));
}

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
});

async function waitForApp(page) {
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
}

async function openCharacters(page) {
    await page.evaluate(async () => window.SillyBunnyShell.openTab('characters', 'characters'));
    const list = page.locator('.sb-character-list[data-mounted="true"]');
    await expect(list).toBeVisible();
    return list;
}

function clearListFilters(settings) {
    settings.power_user ??= {};
    settings.power_user.charListGrid = false;
    settings.accountStorage = Object.fromEntries(Object.entries(settings.accountStorage ?? {})
        .filter(([key]) => !/^(CharacterList|GroupList)_/.test(key)));
}

for (const { label, width } of [{ label: 'desktop', width: 1440 }, { label: 'mobile', width: 390 }]) {
    test.describe(`Character folders on ${label}`, () => {
        test.use({ viewport: { width, height: 844 }, hasTouch: width === 390, isMobile: width === 390 });

        test('Manager create, editor assignment, bulk move, search expansion, and delete preserve characters', async ({ page }) => {
            const characters = makeCharacters(3);
            const settingsState = await routeSettings(page, settings => {
                clearListFilters(settings);
                settings.power_user.sb_folders = {
                    version: 1,
                    migratedFromTags: true,
                    characters: { folders: [], members: {} },
                    groups: { folders: [], members: {} },
                };
            });
            await routeCharacters(page, characters);
            await page.route('**/api/characters/edit', route => route.fulfill({ body: 'ok' }));
            await page.goto('/');
            await waitForApp(page);
            let list = await openCharacters(page);

            await list.locator('[data-action-id="more"]').click();
            await page.getByRole('menuitem', { name: 'Manage Folders', exact: true }).click();
            const manager = page.locator('.sb-dialog-host[open]:has(> .sb-folder-manager)');
            await expect(manager).toBeVisible();
            const createFolder = async name => {
                const addFolder = manager.getByRole('button', { name: 'New Folder', exact: true });
                if (page.viewportSize().width > 450) {
                    await addFolder.focus();
                    await page.keyboard.press('Enter');
                } else {
                    await addFolder.click();
                }
                const input = page.locator('.sb-custom-popover:visible, .sb-action-sheet:visible').getByRole('textbox', { name: 'New Folder', exact: true });
                // The popover moves focus to its entry on a later frame. Typing and Tab before that frame run would
                // have focus pulled back to the entry afterwards, which a user cannot outpace.
                await expect(input).toBeFocused();
                await input.fill(name);
                if (page.viewportSize().width > 450) {
                    const create = page.locator('.sb-custom-popover:visible').getByRole('button', { name: 'Create', exact: true });
                    await page.keyboard.press('Tab');
                    await expect(create).toBeFocused();
                    await page.keyboard.press('Shift+Tab');
                    await expect(input).toBeFocused();
                    await page.keyboard.press('Tab');
                    await page.keyboard.press('Space');
                } else {
                    await input.press('Enter');
                }
            };
            await createFolder('QA Folder');
            const folderId = await page.evaluate(async () => (await import('/scripts/sillybunny-folders.js')).getFolders('characters')[0].id);
            await expect(manager.locator(`[data-folder-id="${folderId}"]`)).toBeVisible();
            await manager.getByRole('button', { name: 'Search', exact: true }).click();
            const managerSearch = manager.getByRole('searchbox', { name: 'Search', exact: true });
            await expectSharedDialogEntryStyles(managerSearch);
            await managerSearch.fill('no-folder-matches-this');
            await expect(manager.locator('.sb-folder-manager__folder-row:not([hidden])')).toHaveCount(0);
            await expect(manager.getByRole('heading', { name: 'No results', exact: true })).toBeVisible();
            await managerSearch.fill('QA Folder');
            await expect(manager.locator(`[data-folder-id="${folderId}"]`)).toBeVisible();
            await expect(manager.locator('.sb-folder-manager__folder-row:not([hidden])')).toHaveCount(1);
            await managerSearch.press('Escape');
            await managerSearch.press('Escape');
            const folderRow = manager.locator(`[data-folder-id="${folderId}"]`);
            await folderRow.locator('.sb-folder-manager__dot').click();
            await expect(manager.locator('.sb-dialog__back').last()).toBeVisible();
            await manager.locator('.sb-dialog__back').last().click();
            await folderRow.focus();
            await page.keyboard.press('Enter');
            await expect(manager.locator('.sb-dialog__back').last()).toBeVisible();
            await manager.locator('.sb-dialog__back').last().click();
            await createFolder('QA Delete Folder');
            const deleteFolderId = await page.evaluate(async () => (await import('/scripts/sillybunny-folders.js')).getFolders('characters').find(folder => folder.name === 'QA Delete Folder').id);
            const deleteFolderRow = manager.locator(`[data-folder-id="${deleteFolderId}"]`);
            await deleteFolderRow.locator('.sb-folder-manager__row-menu').click();
            await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
            const cancelDelete = page.locator('.sb-dialog-host[role="alertdialog"][open]');
            await expect(cancelDelete).toContainText('Delete Folder?');
            await cancelDelete.getByRole('button', { name: 'Cancel', exact: true }).click();
            await expect(deleteFolderRow).toBeVisible();
            await deleteFolderRow.locator('.sb-folder-manager__row-menu').click();
            await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
            const confirmDelete = page.locator('.sb-dialog-host[role="alertdialog"][open]');
            await expect(confirmDelete.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
            await expect(confirmDelete).toContainText('The characters in this folder stay in your library.');
            await confirmDelete.getByRole('button', { name: 'Delete', exact: true }).click();
            await expect.poll(() => page.evaluate(async id => (await import('/scripts/sillybunny-folders.js')).getFolders('characters').some(folder => folder.id === id), deleteFolderId)).toBe(false);

            await manager.locator(`[data-folder-id="${folderId}"] .sb-folder-manager__count`).click();
            await expect(manager.locator('.sb-dialog__back').last()).toBeVisible();
            await manager.locator('.sb-folder-manager__add-member').click();
            const picker = page.locator('.sb-picker:visible, .sb-picker-sheet:visible').last();
            await expect(picker).toBeVisible();
            await picker.locator('.sb-picker__search').fill('Folder QA 2');
            await picker.getByRole('option', { name: /Folder QA 2/ }).click();
            await expect(manager.locator('.sb-folder-manager__member-row')).toHaveCount(1);
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-folders.js')).getFolderId('characters', 'folder-qa-2.png'))).toBe(folderId);
            await manager.locator('.sb-folder-manager__remove').click();
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-folders.js')).getFolderId('characters', 'folder-qa-2.png'))).toBeNull();
            await manager.locator('.sb-dialog__back').last().click();

            await (await visiblePageClose(manager)).click();

            let firstRow = list.locator('[data-sb-list-key="character:folder-qa-0.png"]');
            await firstRow.getByRole('button', { name: 'Edit', exact: true }).click();
            await expect(page.locator('#character_folder')).toBeVisible();
            await page.locator('#character_folder').selectOption(folderId);
            await expect(page.locator('#sb_character_editor_save')).toBeEnabled();
            await page.locator('#sb_character_editor_save').click();
            await expect.poll(() => page.evaluate(async () => {
                const folders = await import('/scripts/sillybunny-folders.js');
                return folders.getFolderId('characters', 'folder-qa-0.png');
            })).toBe(folderId);
            await expect.poll(() => settingsState.saved.at(-1)?.power_user?.sb_folders?.characters?.members?.['folder-qa-0.png']).toBe(folderId);
            await page.locator('#sb_character_editor_back').click();

            let folderHeader = list.locator(`[data-sb-list-key="folder:characters:${folderId}"]`);
            await folderHeader.click();
            await expect(folderHeader).toHaveAttribute('aria-expanded', 'false');
            await expect(list.locator('.character_select')).toHaveCount(2);
            await expect.poll(() => settingsState.saved.at(-1)?.power_user?.sb_folders?.characters?.folders?.find(folder => folder.id === folderId)?.expanded).toBe(false);
            await list.locator('[data-action-id="more"]').click();
            await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
            await list.locator('[data-sb-list-key="character:folder-qa-1.png"] .ch_name').click();
            await list.locator('[data-action-id="folder"]').click();
            await page.getByRole('menuitemradio', { name: 'QA Folder', exact: true }).click();
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-folders.js')).getFolderId('characters', 'folder-qa-1.png'))).toBe(folderId);

            const search = page.locator('#character_search_bar');
            if (!await search.isVisible()) {
                const searchButton = list.locator('[data-action-id="search"]');
                if (await searchButton.isVisible()) await searchButton.click();
                else {
                    await list.locator('[data-action-id="more"]').click();
                    await page.getByRole('menuitem', { name: 'Search', exact: true }).click();
                }
            }
            await search.fill('Folder QA 1');
            await expect(list.locator(`[data-sb-list-key="folder:characters:${folderId}"]`)).toHaveAttribute('aria-expanded', 'true');
            await expect(list.locator('[data-sb-list-key="character:folder-qa-1.png"]')).toBeVisible();
            await search.fill('');
            await expect.poll(() => page.evaluate(() => window.SillyBunnyCharacterListController.captureState().query)).toBe('');
            await expect(list.locator(`[data-sb-list-key="folder:characters:${folderId}"]`)).toHaveAttribute('aria-expanded', 'false');

            await list.locator(`[data-sb-list-key="folder:characters:${folderId}"]`).click();
            await expect(list.locator('[data-sb-list-key="character:folder-qa-1.png"]')).toBeVisible();
            await list.locator('[data-action-id="more"]').click();
            await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
            await list.locator('[data-sb-list-key="character:folder-qa-1.png"] .ch_name').click();
            await list.locator('[data-action-id="folder"]').click();
            await page.getByRole('menuitemradio', { name: 'No folder', exact: true }).click();
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-folders.js')).getFolderId('characters', 'folder-qa-1.png'))).toBeNull();

            await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-folders.js')).getFolderId('characters', 'folder-qa-1.png'))).toBeNull();
            expect(await page.evaluate(async () => (await import('/script.js')).characters.length)).toBe(3);
        });

        test('renders sections, toggles a folder, and persists expanded state across reload', async ({ page }) => {
            await protectMaintainerServer(page);
            const characters = makeCharacters(3);
            let folders = {
                version: 1,
                migratedFromTags: true,
                characters: {
                    folders: [{ id: 'folder-qa', name: 'QA Folder', color: 'rgb(53, 132, 228)', expanded: false }],
                    members: { [characters[0].avatar]: 'folder-qa' },
                },
                groups: { folders: [], members: {} },
            };
            const settingsState = await routeSettings(page, settings => {
                clearListFilters(settings);
                settings.power_user.sb_folders = structuredClone(folders);
            });
            await routeCharacters(page, characters);
            await page.goto('/');
            await waitForApp(page);
            const list = await openCharacters(page);
            const header = list.locator('[data-sb-list-key="folder:characters:folder-qa"]');
            await expect(header).toHaveAttribute('aria-expanded', 'false');
            await expect(list.locator('.character_select')).toHaveCount(2);
            await header.click();
            await expect(header).toHaveAttribute('aria-expanded', 'true');
            await expect(list.locator('.character_select')).toHaveCount(3);
            await expect.poll(() => settingsState.saved.at(-1)?.power_user?.sb_folders?.characters?.folders?.[0]?.expanded).toBe(true);
            folders = settingsState.saved.at(-1).power_user.sb_folders;

            await page.reload();
            await waitForApp(page);
            const reloaded = await openCharacters(page);
            await expect(reloaded.locator('[data-sb-list-key="folder:characters:folder-qa"]')).toHaveAttribute('aria-expanded', 'true');
            await expect(reloaded.locator('.character_select')).toHaveCount(3);
        });

        test('converts opt-in tag folders once at startup and leaves tags untouched', async ({ page }) => {
            await protectMaintainerServer(page);
            const characters = makeCharacters(4);
            const legacyTags = [
                { id: 'qa-open-folder', name: 'QA Open', color: 'orange', folder_type: 'OPEN' },
                { id: 'qa-closed-folder', name: 'QA Closed', color: '', folder_type: 'CLOSED' },
                { id: 'qa-plain-tag', name: 'QA Plain', folder_type: 'NONE' },
            ];
            const legacyMap = {
                [characters[0].avatar]: ['qa-open-folder'],
                [characters[1].avatar]: ['qa-closed-folder', 'qa-plain-tag'],
                [characters[2].avatar]: ['qa-open-folder', 'qa-closed-folder'],
            };
            const settingsState = await routeSettings(page, settings => {
                clearListFilters(settings);
                settings.power_user.bogus_folders = true;
                delete settings.power_user.sb_folders;
                // Replaces the saved tags, so qa- tags that other specs left on the server cannot reach the exact-list checks below.
                settings.tags = structuredClone(legacyTags);
                settings.tag_map = structuredClone(legacyMap);
            });
            await routeCharacters(page, characters);
            await page.goto('/');
            await waitForApp(page);

            const state = await page.evaluate(async avatars => {
                const folders = await import('/scripts/sillybunny-folders.js');
                const tags = await import('/scripts/tags.js');
                const { power_user } = await import('/scripts/power-user.js');
                const list = folders.getFolders('characters');
                const byName = name => list.find(folder => folder.name === name);
                return {
                    migrated: power_user.sb_folders.migratedFromTags,
                    bogusFolders: power_user.bogus_folders,
                    open: byName('QA Open'),
                    closed: byName('QA Closed'),
                    plain: byName('QA Plain'),
                    members: avatars.map(avatar => folders.getFolderId('characters', avatar)),
                    tagTypes: tags.tags.filter(tag => tag.id.startsWith('qa-')).map(tag => [tag.id, tag.folder_type]),
                    tagMap: avatars.map(avatar => tags.tag_map[avatar] ?? []),
                };
            }, characters.map(character => character.avatar));

            expect(state.migrated).toBe(true);
            expect(state.bogusFolders).toBe(true);
            expect(state.plain).toBeUndefined();
            expect(state.open).toMatchObject({ expanded: true, color: 'orange' });
            expect(state.closed).toMatchObject({ expanded: false });
            expect(state.members).toEqual([state.open.id, state.closed.id, null, null]);
            expect(state.tagTypes).toEqual([['qa-open-folder', 'OPEN'], ['qa-closed-folder', 'CLOSED'], ['qa-plain-tag', 'NONE']]);
            expect(state.tagMap).toEqual([['qa-open-folder'], ['qa-closed-folder', 'qa-plain-tag'], ['qa-open-folder', 'qa-closed-folder'], []]);
            await expect.poll(() => settingsState.saved.some(payload => payload.power_user?.sb_folders?.migratedFromTags === true)).toBe(true);

            const list = await openCharacters(page);
            await expect(list.locator(`[data-sb-list-key="folder:characters:${state.open.id}"]`)).toHaveAttribute('aria-expanded', 'true');
            await expect(list.locator(`[data-sb-list-key="folder:characters:${state.closed.id}"]`)).toHaveAttribute('aria-expanded', 'false');
            await expect(list.locator('.bogus_folder_select')).toHaveCount(0);
            // Open folder member + the two unfiled characters; the closed folder hides its member.
            await expect(list.locator('.character_select')).toHaveCount(3);
        });
    });
}

test('desktop Folder Manager New Folder trigger closes its open popover on repeat activation', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 844 });
    const characters = makeCharacters(1);
    await routeSettings(page, settings => {
        clearListFilters(settings);
        settings.power_user.sb_folders = {
            version: 1,
            migratedFromTags: true,
            characters: { folders: [], members: {} },
            groups: { folders: [], members: {} },
        };
    });
    await routeCharacters(page, characters);
    await page.route('**/api/characters/edit', route => route.fulfill({ body: 'ok' }));
    await page.goto('/');
    await waitForApp(page);
    const list = await openCharacters(page);
    await list.locator('[data-action-id="more"]').click();
    await page.getByRole('menuitem', { name: 'Manage Folders', exact: true }).click();
    const manager = page.locator('.sb-dialog-host[open]:has(> .sb-folder-manager)');
    await expect(manager).toBeVisible();
    const addFolder = manager.getByRole('button', { name: 'New Folder', exact: true });
    await addFolder.click();
    const popover = page.locator('.sb-custom-popover:visible');
    await expect(popover).toBeVisible();
    await expect(addFolder).toHaveAttribute('aria-expanded', 'true');
    await addFolder.click();
    await expect(popover).toHaveCount(0);
    await expect(addFolder).toHaveAttribute('aria-expanded', 'false');
});
