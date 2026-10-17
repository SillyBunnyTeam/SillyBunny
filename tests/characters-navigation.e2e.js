import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

const persistenceRequests = new WeakMap();
const groupDefinitionKeys = [
    'name', 'members', 'disabled_members', 'member_models', 'avatar_url', 'fav',
    'activation_strategy', 'generation_mode', 'generation_mode_join_prefix', 'generation_mode_join_suffix',
    'allow_self_responses', 'hideMutedSprites',
];

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    const requests = [];
    persistenceRequests.set(page, requests);
    page.on('request', request => {
        const pathname = new URL(request.url()).pathname;
        if (!/\/api\/groups\/(edit|create)$/.test(pathname)) return;
        const body = request.headers()['content-encoding'] === 'gzip'
            ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        requests.push({ ...JSON.parse(body.toString()), sbQaCreate: pathname.endsWith('/create') });
    });
    // Keep all browser QA changes local to the editor draft.
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip'
            ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
    await page.route('**/api/groups/edit', route => route.fulfill({ json: {} }));
    await page.route('**/api/groups/create', route => route.fulfill({ json: { id: 'member-list-qa' } }));
    // The selected fixture chat exists only in this browser, never on disk.
    await page.route('**/api/chats/group/info', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/group/get', route => route.fulfill({ json: [
        { chat_metadata: { tainted: true } },
        { name: 'qa-group', is_user: false, is_system: false, send_date: '2026-10-17', mes: 'qa-navigation-chat' },
    ] }));
    await page.route('**/api/chats/group/save', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/save', route => route.fulfill({ json: {} }));
    await page.route('**/api/characters/edit*', route => route.fulfill({ body: 'ok' }));
});

test.afterEach(async ({ page }) => {
    try {
        await expectOnlyLiveGroupPayloads(page);
    } finally {
        await page.evaluate(async () => {
            const fixture = window.__sbCharactersNavigationFixture;
            if (!fixture && !window.__sbCharactersNavigationOriginalGroups) return;
            document.getElementById('sb_group_editor_cancel')?.click();
            const groupChats = await import('/scripts/group-chats.js');
            const { objectNavigation } = await import('/scripts/sillybunny-editor/object-navigation.js');
            const { getCurrentUserHandle } = await import('/scripts/user.js');
            const { tag_map } = await import('/scripts/tags.js');
            objectNavigation.clear();
            groupChats.resetSelectedGroup();
            const ids = [fixture?.id, ...(window.__sbCharactersNavigationExtraGroups ?? [])].filter(Boolean);
            for (const id of ids) {
                const index = groupChats.groups.findIndex(group => group.id === id);
                if (index >= 0) groupChats.groups.splice(index, 1);
                localStorage.removeItem(`sb-group-editor-draft-${getCurrentUserHandle() || 'default'}-${id}`);
                delete tag_map[id];
            }
            if (window.__sbCharactersNavigationOriginalGroups) {
                groupChats.groups.splice(0, groupChats.groups.length, ...window.__sbCharactersNavigationOriginalGroups);
                localStorage.removeItem(`sb-group-editor-draft-${getCurrentUserHandle() || 'default'}-new-group`);
            }
            delete window.__sbCharactersNavigationFixture;
            delete window.__sbCharactersNavigationExtraGroups;
            delete window.__sbCharactersNavigationOriginalGroups;
        });
    }
});

async function expectOnlyLiveGroupPayloads(page) {
    const { groups, fixture } = await page.evaluate(async () => ({
        groups: (await import('/scripts/group-chats.js')).groups,
        fixture: window.__sbCharactersNavigationFixture,
    }));
    for (const payload of persistenceRequests.get(page)) {
        const live = payload.sbQaCreate || payload.id === fixture?.id ? fixture : groups.find(group => group.id === payload.id);
        expect(live, 'Persisted payload must refer to a live group, not an unsaved create draft').toBeDefined();
        for (const key of groupDefinitionKeys) {
            expect(payload[key], `Only live ${key} may persist before editor Save`).toEqual(live[key]);
        }
    }
}

async function flushLiveGroupMetadata(page) {
    expect(await page.evaluate(async () => (await import('/script.js')).saveMetadata({ throwOnError: true }))).toBe(true);
    expect(persistenceRequests.get(page).length).toBeGreaterThan(0);
}

async function openCreateGroup(page, mobile) {
    await page.goto('/');
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.addStyleTag({ content: '#toast-container { display: none !important; }' });
    await page.locator('#sb-character-toggle').click();
    if (mobile) {
        await page.getByRole('button', { name: 'Back to settings navigation', exact: true }).click();
    }
    await page.getByRole('complementary', { name: 'Settings navigation' }).getByRole('tab', { name: 'Groups' }).click();
    await expect(page.locator('.sb-character-list')).toHaveAttribute('data-view', 'groups');
    await expect(page.locator('.sb-character-list .sb-list-header__title')).toHaveText('Groups');
    await page.locator('.sb-character-list [data-action-id="new"]').click();
    await expect(page.locator('#sb_group_editor_header')).toBeVisible();
}

async function openFixtureGroup(page, mobile) {
    await openCreateGroup(page, mobile);
    const fixture = await page.evaluate(async () => {
        const app = await import('/script.js');
        const groupChats = await import('/scripts/group-chats.js');
        const members = app.characters.slice(0, 2).map(character => character.avatar);
        if (members.length < 2) throw new Error('Character navigation QA requires two existing test characters.');
        const group = {
            id: 'characters-navigation-qa-fixture',
            name: 'qa-navigation-group',
            members,
            disabled_members: [],
            member_models: {},
            avatar_url: '',
            chat_id: 'characters-navigation-qa-chat',
            chats: ['characters-navigation-qa-chat'],
            activation_strategy: 0,
            generation_mode: 0,
            allow_self_responses: false,
            hideMutedSprites: false,
        };
        groupChats.groups.push(group);
        window.__sbCharactersNavigationFixture = structuredClone(group);
        // Unlike the editor-only fixture, select its stubbed chat to exercise peeking.
        if (!await groupChats.openGroupById(group.id, { switchMenu: true })) throw new Error('Could not open the fixture group.');
        return window.__sbCharactersNavigationFixture;
    });
    await expect(page.locator('#rm_group_members .group_member')).toHaveCount(2);
    return fixture;
}

async function stubCreatedGroup(page) {
    const baseline = await page.evaluate(async () => {
        const app = await import('/script.js');
        const groupChats = await import('/scripts/group-chats.js');
        const members = app.characters.slice(0, 2).map(character => character.avatar);
        if (members.length < 2) throw new Error('Character navigation QA requires two existing test characters.');
        window.__sbCharactersNavigationOriginalGroups = structuredClone(groupChats.groups);
        // Avoid the duplicate-members branch without changing persisted user groups.
        const groups = groupChats.groups.filter(group => group.members?.length !== members.length
            || !members.every(avatar => group.members.includes(avatar)));
        groupChats.groups.splice(0, groupChats.groups.length, ...groups);
        return { members, groups };
    });
    let savedGroup = null;
    await page.route('**/api/groups/create', async route => {
        savedGroup = { ...route.request().postDataJSON(), id: 'characters-navigation-qa-created' };
        await page.evaluate(group => { window.__sbCharactersNavigationFixture = structuredClone(group); }, savedGroup);
        await route.fulfill({ json: savedGroup });
    });
    await page.route('**/api/groups/all', route => route.fulfill({
        json: savedGroup ? [...baseline.groups, savedGroup] : baseline.groups,
    }));
    return baseline.members;
}

async function addCandidate(page, avatar) {
    const search = page.locator('#rm_group_filter');
    await search.fill(await page.evaluate(async avatar => (await import('/script.js')).characters.find(character => character.avatar === avatar).name, avatar));
    await page.locator(`#rm_group_add_members .group_member[data-avatar=${JSON.stringify(avatar)}] [data-action="add"]`).click();
    await expect(memberRow(page, avatar)).toBeVisible();
    await search.fill('');
}

function memberRow(page, avatar) {
    return page.locator(`#rm_group_members .group_member[data-avatar=${JSON.stringify(avatar)}]`);
}

async function activateMember(page, row, activation) {
    if (activation === 'click') await row.locator('.ch_name').click();
    else await page.keyboard.press('Enter');
}

async function prepareMemberScroll(page, row) {
    await page.locator('#sb_group_editor_content').evaluate((scroller) => {
        scroller.scrollTop = Math.min(120, scroller.scrollHeight - scroller.clientHeight);
    });
    // Pointer activation may scroll the title into view before dispatching the click.
    // Record the actual origin at the event, before the delegated route handler runs.
    await row.evaluate(element => {
        window.__sbMemberOriginScroll = document.getElementById('sb_group_editor_content').scrollTop;
        element.addEventListener('click', () => {
            window.__sbMemberOriginScroll = document.getElementById('sb_group_editor_content').scrollTop;
        }, { capture: true, once: true });
    });
}

async function openSettingsNavigation(page, mobile) {
    if (mobile) await page.getByRole('button', { name: 'Back to settings navigation', exact: true }).click();
}

async function readChatState(page) {
    return page.evaluate(async () => {
        const app = await import('/script.js');
        const groupChats = await import('/scripts/group-chats.js');
        return { group: groupChats.selected_group, chatId: app.getCurrentChatId(), messages: structuredClone(app.chat) };
    });
}

async function expectCharacterEditor(page, avatar) {
    await expect(page.locator('#rm_ch_create_block')).toBeVisible();
    await expect(page.locator('#sb-settings-tab-list [data-sb-settings-tab="editor"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'character_edit');
    await expect.poll(() => page.evaluate(async () => {
        const app = await import('/script.js');
        return app.characters[app.this_chid]?.avatar;
    })).toBe(avatar);
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-editor/object-navigation.js')).objectNavigation.depth)).toBe(1);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`create member navigation saves first and Back returns to the new group at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openCreateGroup(page, viewport.width <= 768);
        const members = await stubCreatedGroup(page);
        await page.locator('#rm_group_chat_name').fill('qa-created-navigation-group');
        await addCandidate(page, members[0]);
        await addCandidate(page, members[1]);
        await memberRow(page, members[0]).locator('.ch_name').click();
        const popup = page.locator('dialog.popup[open]').last();
        await expect(popup).toContainText('Unsaved changes');
        await popup.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(popup).toBeHidden();
        await expectCharacterEditor(page, members[0]);
        expect(persistenceRequests.get(page).filter(payload => payload.sbQaCreate)).toHaveLength(1);
        const chat = await readChatState(page);
        await page.locator('#sb_character_editor_back').click();
        await expect(page.locator('#sb_group_editor_header')).toBeVisible();
        await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'group_edit');
        await expect(page.locator('#rm_group_chat_name')).toHaveValue('qa-created-navigation-group');
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).openGroupId)).toBe('characters-navigation-qa-created');
        await expect(page.locator('#rm_group_members .group_member')).toHaveCount(2);
        expect(await readChatState(page)).toEqual(chat);
    });

    test(`non-peek Back presents an unselected group without changing chat at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const fixture = await openFixtureGroup(page, viewport.width <= 768);
        const editedId = await page.evaluate(async fixture => {
            const groupChats = await import('/scripts/group-chats.js');
            const group = { ...structuredClone(fixture), id: 'characters-navigation-qa-unselected', name: 'qa-unselected-group' };
            groupChats.groups.push(group);
            window.__sbCharactersNavigationExtraGroups = [group.id];
            groupChats.select_group_chats(group.id, false);
            return group.id;
        }, fixture);
        expect((await readChatState(page)).group).toBe(fixture.id);
        await memberRow(page, fixture.members[0]).locator('.ch_name').click();
        await expectCharacterEditor(page, fixture.members[0]);
        const chat = await readChatState(page);
        expect(chat.group).toBeNull();
        await page.locator('#sb_character_editor_back').click();
        await expect(page.locator('#sb_group_editor_header')).toBeVisible();
        await expect(page.locator('#rm_group_chat_name')).toHaveValue('qa-unselected-group');
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).openGroupId)).toBe(editedId);
        expect(await readChatState(page)).toEqual(chat);
    });

    for (const activation of ['click', 'Enter']) {
        test(`member ${activation} peeks and Back restores focus and scroll at ${viewport.width}px`, async ({ page }) => {
            await page.setViewportSize(viewport);
            const fixture = await openFixtureGroup(page, viewport.width <= 768);
            const row = memberRow(page, fixture.members[0]);
            await row.evaluate(element => element.focus({ preventScroll: true }));
            await prepareMemberScroll(page, row);
            const chat = await readChatState(page);
            await activateMember(page, row, activation);
            const scrollTop = await page.evaluate(() => window.__sbMemberOriginScroll);
            expect(scrollTop).toBeGreaterThan(0);

            await expectCharacterEditor(page, fixture.members[0]);
            await flushLiveGroupMetadata(page);
            expect(await readChatState(page)).toEqual(chat);
            await page.locator('#sb_character_editor_back').click();
            await expect(page.locator('#sb_group_editor_header')).toBeVisible();
            await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'group_edit');
            await expect(row).toBeFocused();
            await expect.poll(() => page.locator('#sb_group_editor_content').evaluate(scroller => scroller.scrollTop)).toBeCloseTo(scrollTop, 0);
            expect(await readChatState(page)).toEqual(chat);
        });
    }

    test(`dirty group navigation offers Save/Discard/Cancel and Cancel stays at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const fixture = await openFixtureGroup(page, viewport.width <= 768);
        const row = memberRow(page, fixture.members[0]);
        const chat = await readChatState(page);
        const draftName = `${fixture.name}-unsaved-draft`;
        await page.locator('#rm_group_chat_name').fill(draftName);
        await row.getByRole('switch').uncheck();
        await expect(page.locator('#sb_group_editor_dirty')).toBeVisible();
        await flushLiveGroupMetadata(page);
        expect(persistenceRequests.get(page).map(payload => payload.name)).not.toContain(draftName);
        await row.locator('.ch_name').click();
        const popup = page.locator('dialog.popup[open]').last();
        await expect(popup).toContainText('Unsaved changes');
        await expect(popup.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
        await expect(popup.getByRole('button', { name: 'Discard', exact: true })).toBeVisible();
        await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(popup).toBeHidden();
        await expect(page.locator('#sb_group_editor_header')).toBeVisible();
        await expect(page.locator('#rm_ch_create_block')).toBeHidden();
        await expect(row.getByRole('switch')).not.toBeChecked();
        expect(await readChatState(page)).toEqual(chat);
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-editor/object-navigation.js')).objectNavigation.depth)).toBe(0);
    });

    test(`sidebar navigation clears the origin and Back falls back to Characters at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const mobile = viewport.width <= 768;
        const fixture = await openFixtureGroup(page, mobile);
        await memberRow(page, fixture.members[0]).locator('.ch_name').click();
        await expectCharacterEditor(page, fixture.members[0]);
        await openSettingsNavigation(page, mobile);
        await page.getByRole('complementary', { name: 'Settings navigation' }).getByRole('tab', { name: 'Characters', exact: true }).click();
        await expect(page.locator('#rm_characters_block')).toBeVisible();
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-editor/object-navigation.js')).objectNavigation.depth)).toBe(0);

        // Reopen the same definition without a new origin; Back must not resurrect the group.
        expect(await page.evaluate(async avatar => (await import('/scripts/group-chats.js')).openGroupMemberDefinition(avatar), fixture.members[0])).toBe(true);
        await expect(page.locator('#sb_character_editor_header')).toBeVisible();
        await page.locator('#sb_character_editor_back').click();
        await expect(page.locator('#rm_characters_block')).toBeVisible();
        await expect(page.locator('#sb-settings-tab-list [data-sb-settings-tab="characters"]')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#sb_group_editor_header')).toBeHidden();
    });
}
