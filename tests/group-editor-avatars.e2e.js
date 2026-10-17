import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    // Browser QA must not change the running instance's saved preferences.
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip'
            ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
});

test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
        if (!window.__sbAvatarFixtureOriginalGroups) return;
        const { groups } = await import('/scripts/group-chats.js');
        groups.splice(0, groups.length, ...window.__sbAvatarFixtureOriginalGroups);
        delete window.__sbAvatarFixtureOriginalGroups;
    });
});

/** Avatar shape of every group row in the list, plus the hidden template row. */
function readGroupAvatars(page) {
    return page.evaluate(() => ({
        template: Boolean(document.querySelector('#group_list_template .group_select > .avatar')),
        rows: Array.from(document.querySelectorAll('#rm_print_characters_block .group_select'), (row) => ({
            id: row.getAttribute('data-grid'),
            avatar: Boolean(row.querySelector(':scope > .avatar')),
            missing: Boolean(row.querySelector(':scope > .missing-avatar')),
            images: [...row.querySelectorAll('.avatar img')].map(image => image.getAttribute('src')),
        })),
    }));
}

test('opening Create New Chat Group keeps the group list avatars', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.waitForFunction(() => !document.getElementById('preloader')
        && window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'));
    const id = await page.evaluate(async () => {
        const app = await import('/script.js');
        const { groups } = await import('/scripts/group-chats.js');
        const state = await import('/scripts/sillybunny-character-list-state.js');
        const { power_user } = await import('/scripts/power-user.js');
        const members = app.characters.slice(0, 2).map(character => character.avatar);
        if (members.length < 2) throw new Error('Avatar QA requires two existing characters; no cards are created.');
        window.__sbAvatarFixtureOriginalGroups = structuredClone(groups);
        const fixture = {
            id: 'group-avatar-qa-fixture', name: 'qa-avatar-group', members,
            disabled_members: [], member_models: {}, avatar_url: '',
            chat_id: 'group-avatar-qa-chat', chats: ['group-avatar-qa-chat'],
            activation_strategy: 0, generation_mode: 0, allow_self_responses: false,
            hideMutedSprites: false, fav: false,
        };
        groups.push(fixture);
        await state.switchCharacterListView('groups');
        for (const type of ['fav', 'folder', 'group']) app.entitiesFilter.setFilterData(type, 'UNDEFINED', true);
        app.entitiesFilter.setFilterData('tag', { selected: [], excluded: [] }, true);
        app.entitiesFilter.setFilterData('search', fixture.name, true);
        app.entitiesFilter.clearFuzzySearchCaches();
        document.getElementById('character_search_bar').value = fixture.name;
        power_user.bogus_folders = false;
        await state.setListPage('groups', 1);
        return fixture.id;
    });
    await page.locator('#sb-character-toggle').click();
    await page.getByRole('complementary', { name: 'Settings navigation' }).getByRole('tab', { name: 'Groups' }).click();
    await page.evaluate(async () => { await window.SillyBunnyShell.openTab('characters', 'groups'); });
    const create = page.locator('.sb-character-list [data-action-id="new"]');
    await expect(create).toBeVisible();
    await expect(page.locator('.sb-character-list')).toHaveAttribute('data-view', 'groups');

    const fixtureRow = page.locator(`.sb-character-list .group_select[data-grid="${id}"]`);
    const fixtureImage = fixtureRow.locator('.avatar img').first();
    await expect(fixtureRow).toBeVisible();
    await expect(fixtureImage).toBeVisible();
    await expect.poll(() => fixtureImage.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    const before = await readGroupAvatars(page);
    expect(before.template).toBe(true);
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0].id).toBe(id);

    await create.click();
    await expect(page.locator('#sb_group_editor_header')).toBeVisible();
    await page.locator('#sb_group_editor_back').click();
    await expect(page.locator('.sb-character-list')).toBeVisible();
    await expect(page.locator('.sb-character-list')).toHaveAttribute('data-view', 'groups');
    await expect(fixtureRow).toBeVisible();
    await expect(fixtureImage).toBeVisible();
    await expect.poll(() => fixtureImage.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect.poll(() => readGroupAvatars(page)).toEqual(before);
});
