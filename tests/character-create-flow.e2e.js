import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

function makeCharacter(avatar, name, nickname = '') {
    const data = {
        name, nickname, description: '', personality: '', scenario: '', first_mes: 'QA greeting', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
        tags: [], creator: '', character_version: '', extensions: { fav: false, talkativeness: 0.5 },
    };
    return {
        ...data, avatar, chat: '', create_date: '2026-10-19', date_added: 1,
        spec: 'chara_card_v2', spec_version: '2.0', data,
    };
}

function requestJson(request) {
    const body = request.postDataBuffer();
    const decoded = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(body) : body;
    return JSON.parse(decoded.toString());
}

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    const characters = [
        makeCharacter('qa-character-a.png', 'QA Character A', 'Ally'),
        makeCharacter('qa-character-b.png', 'QA Character B'),
    ];
    const groups = [];

    await page.route('**/api/characters/all', route => route.fulfill({ json: characters }));
    await page.route('**/api/characters/get', route => {
        const payload = requestJson(route.request());
        return route.fulfill({ json: characters.find(character => character.avatar === payload.avatar_url) ?? {} });
    });
    await page.route('**/api/characters/chats', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/get', route => route.fulfill({ json: [] }));
    await page.route('**/api/groups/all', route => route.fulfill({ json: groups }));
    await page.route('**/api/groups/create', async route => {
        const group = { ...route.request().postDataJSON(), id: 'qa-created-group' };
        groups.push(group);
        await route.fulfill({ json: group });
    });
    await page.route('**/api/groups/edit', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/group/info', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/group/get', route => route.fulfill({ json: [] }));
    // Register after protectMaintainerServer so create requests only update these in-memory fixtures.
    await page.route('**/api/characters/create', async route => {
        characters.push(makeCharacter('qa-created-character.png', 'QA Created Character'));
        await route.fulfill({ status: 200, body: 'qa-created-character.png' });
    });
});

async function openView(page, view) {
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.evaluate(async view => window.SillyBunnyShell.openTab('characters', view), view);
    await expect(page.locator('.sb-character-list[data-mounted="true"]')).toHaveAttribute('data-view', view);
}

async function addTag(page, inputSelector, listSelector, name) {
    const input = page.locator(inputSelector);
    await input.fill(name);
    const suggestion = page.locator('.ui-autocomplete:visible .ui-menu-item').filter({ hasText: name }).first();
    await expect(suggestion).toBeVisible();
    await suggestion.click();
    const chips = page.locator(`${listSelector} > .tag`);
    await expect(chips).toHaveCount(1);
    return chips.first();
}

async function addCharacterToGroup(page) {
    await page.locator('#rm_group_filter').fill('QA Character A');
    const candidate = page.locator('#rm_group_add_members .group_member[data-avatar="qa-character-a.png"]');
    await expect(candidate).toBeVisible();
    await candidate.locator('[data-action="add"]').click();
    await expect(page.locator('#rm_group_members .group_member[data-avatar="qa-character-a.png"]')).toBeVisible();
}

async function waitForChatActivation(page) {
    await expect(page.locator('#sb-settings-page')).toBeHidden();
    await expect(page.locator('#chat')).toBeVisible();
    await expect(page.locator('.is-activating-entity')).toHaveCount(0);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`character create returns to its list and leaves one activatable row per item at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await openView(page, 'characters');

        await page.locator('.sb-character-list [data-action-id="new"]').click();
        await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'create');
        await page.locator('#character_name_pole').fill('QA Created Character');
        await page.locator('#character_nickname_pole').fill('Temporary nickname');
        await page.locator('#sb_character_editor_save').click();

        const list = page.locator('.sb-character-list[data-mounted="true"]');
        const created = list.locator('[data-sb-list-key="character:qa-created-character.png"]');
        await expect(created).toBeVisible();
        await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'characters');
        await expect(page.locator('[data-sb-settings-tab="characters"][aria-selected="true"]')).toHaveCount(1);
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).menu_type)).toBe('characters');
        await expect(page.locator('#rm_print_characters_block > .entity_block:not(.ds-entity-row)')).toHaveCount(0);
        await expect.poll(() => list.locator('.ds-entity-row').evaluateAll(rows => {
            const keys = rows.map(row => row.dataset.sbListKey);
            return keys.length === new Set(keys).size;
        })).toBe(true);
        await expect(created).toBeFocused();
        await expect(created).toHaveClass(/flash/);

        await page.evaluate(async () => window.SillyBunnyShell.openTab('characters', 'editor'));
        await page.evaluate(async () => window.SillyBunnyShell.openTab('characters', 'characters'));
        await expect(list.locator('.ds-entity-row')).toHaveCount(3);
        const rowKeys = await list.locator('.ds-entity-row').evaluateAll(rows => rows.map(row => row.dataset.sbListKey));
        expect(new Set(rowKeys).size).toBe(rowKeys.length);
        for (const rowKey of rowKeys) {
            const row = list.locator(`[data-sb-list-key=${JSON.stringify(rowKey)}]`);
            const characterId = Number(await row.getAttribute('data-chid'));
            await row.locator('.ch_name').click();
            await waitForChatActivation(page);
            await expect.poll(() => page.evaluate(async () => Number((await import('/script.js')).this_chid))).toBe(characterId);
            await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
            await expect(list).toBeVisible();
        }

        await page.locator('.sb-character-list [data-action-id="new"]').click();
        await expect(page.locator('#character_nickname_pole')).toHaveValue('');
    });

    test(`group create returns to Groups and reveals the new row at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openView(page, 'groups');
        const folderId = await page.evaluate(async () => (await import('/scripts/sillybunny-folders.js')).createFolder('groups', 'QA Group Folder').id);
        await page.locator('.sb-character-list [data-action-id="new"]').click();
        await expect(page.locator('#sb_group_editor_header')).toBeVisible();
        await page.locator('#rm_group_chat_name').fill('QA Created Group');
        await page.locator('#group_folder').selectOption(folderId);
        await addCharacterToGroup(page);
        const save = page.locator('#sb_group_editor_save');
        await expect(save).toBeEnabled();
        await save.evaluate(button => button.click());

        const list = page.locator('.sb-character-list[data-mounted="true"]');
        const created = list.locator('[data-sb-list-key="group:qa-created-group"]');
        await expect(created).toBeVisible();
        await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'groups');
        await expect(page.locator('[data-sb-settings-tab="groups"][aria-selected="true"]')).toHaveCount(1);
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).menu_type)).toBe('characters');
        await expect(created).toBeFocused();
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-folders.js')).getFolderId('groups', 'qa-created-group'))).toBe(folderId);
        expect(await page.evaluate(async () => (await import('/scripts/group-chats.js')).groups.find(group => group.id === 'qa-created-group'))).not.toHaveProperty('_folder');
    });
}

test('removing a create-mode character tag survives the redraw and the saved tag map', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openView(page, 'characters');
    await page.locator('.sb-character-list [data-action-id="new"]').click();
    await page.locator('#character_name_pole').fill('QA Created Character');
    const chip = await addTag(page, '#tagInput', '#tagList', 'QA removable character tag');
    const tagId = await chip.getAttribute('id');
    await chip.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.waitForTimeout(500);
    await expect(page.locator('#tagList > .tag')).toHaveCount(0);
    await page.locator('#sb_character_editor_save').click();
    await expect(page.locator('[data-sb-list-key="character:qa-created-character.png"]')).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/tags.js')).tag_map['qa-created-character.png'])).not.toContain(tagId);
});

test('removing a create-mode group tag survives the redraw and the saved tag map', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openView(page, 'groups');
    await page.locator('.sb-character-list [data-action-id="new"]').click();
    await page.locator('#rm_group_chat_name').fill('QA Created Group');
    await addCharacterToGroup(page);
    const chip = await addTag(page, '#groupTagInput', '#groupTagList', 'QA removable group tag');
    const tagId = await chip.getAttribute('id');
    await chip.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.waitForTimeout(500);
    await expect(page.locator('#groupTagList > .tag')).toHaveCount(0);
    await page.locator('#sb_group_editor_save').click();
    await expect(page.locator('[data-sb-list-key="group:qa-created-group"]')).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/tags.js')).tag_map['qa-created-group'])).not.toContain(tagId);
});

test('opening characters with and without a nickname never reuses the previous field value', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openView(page, 'characters');
    const list = page.locator('.sb-character-list[data-mounted="true"]');
    await list.locator('[data-sb-list-key="character:qa-character-a.png"] [aria-label="Edit"]').click();
    await expect(page.locator('#character_nickname_pole')).toHaveValue('Ally');
    await page.locator('#sb_character_editor_back').click();
    await page.evaluate(async () => window.SillyBunnyShell.openTab('characters', 'characters'));
    await list.locator('[data-sb-list-key="character:qa-character-b.png"] [aria-label="Edit"]').click();
    await expect(page.locator('#character_nickname_pole')).toHaveValue('');
    await page.locator('#character_nickname_pole').fill('Bee');
    await page.locator('#sb_character_editor_save').click();
    await page.locator('#sb_character_editor_back').click();
    await page.evaluate(async () => window.SillyBunnyShell.openTab('characters', 'characters'));
    await expect(list).toBeVisible();
    await list.locator('[data-sb-list-key="character:qa-character-a.png"] [aria-label="Edit"]').click();
    await expect(page.locator('#character_nickname_pole')).toHaveValue('Ally');
});
