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
        if (!/\/api\/groups\/(edit|create)$/.test(new URL(request.url()).pathname)) return;
        const body = request.headers()['content-encoding'] === 'gzip'
            ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        requests.push(JSON.parse(body.toString()));
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
});

test.afterEach(async ({ page }) => {
    await expectOnlyLiveGroupPayloads(page);
    await page.evaluate(async () => {
        const fixtures = window.__sbMemberListFixtures;
        if (!fixtures) return;
        const groupChats = await import('/scripts/group-chats.js');
        const tagsApi = await import('/scripts/tags.js');
        groupChats.resetSelectedGroup();
        for (const id of fixtures.groups) {
            const index = groupChats.groups.findIndex(group => group.id === id);
            if (index >= 0) groupChats.groups.splice(index, 1);
        }
        for (const id of fixtures.tags) {
            const index = tagsApi.tags.findIndex(tag => tag.id === id);
            if (index >= 0) tagsApi.tags.splice(index, 1);
        }
        for (const [avatar, tags] of fixtures.tagMaps) {
            if (tags === undefined) delete tagsApi.tag_map[avatar];
            else tagsApi.tag_map[avatar] = tags;
        }
    });
});

async function expectOnlyLiveGroupPayloads(page) {
    const { groups, baselines } = await page.evaluate(async () => ({
        groups: (await import('/scripts/group-chats.js')).groups,
        baselines: window.__sbMemberListFixtures?.baselines ?? [],
    }));
    for (const payload of persistenceRequests.get(page)) {
        const live = baselines.find(group => group.id === payload.id) ?? groups.find(group => group.id === payload.id);
        expect(live, 'Persisted payload must refer to a live group, not an unsaved create draft').toBeDefined();
        for (const key of groupDefinitionKeys) {
            expect(payload[key], `Only live ${key} may persist before editor Save`).toEqual(live[key]);
        }
    }
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

async function addFirstCandidate(page) {
    const candidate = page.locator('#rm_group_add_members .group_member').first();
    const avatar = await candidate.getAttribute('data-avatar');
    // The text column is row background, not the explicit Add control.
    await candidate.locator('.ch_name').click();
    // Avatar identity is a DOM attribute so clones do not depend on jQuery data.
    const row = page.locator(`#rm_group_members .group_member[data-avatar=${JSON.stringify(avatar)}]`);
    await expect(row).toBeVisible();
    await expect(page.locator(`#rm_group_add_members .group_member[data-avatar=${JSON.stringify(avatar)}]`)).toHaveCount(0);
    return { avatar, row };
}

async function openMemberMenu(page, row) {
    // Desktop closing animation briefly leaves the previous menu in the DOM.
    await expect(page.getByRole('menu')).toHaveCount(0);
    await row.getByRole('button', { name: 'Member actions', exact: true }).click();
    await expect(page.getByRole('menu')).toBeVisible();
}

async function clickCandidateTarget(candidate, target) {
    if (target === '.tag') {
        // Static chips receive role=button from a11y without an action.
        await candidate.locator('.tags').evaluate(tags => {
            const chip = document.createElement('span');
            chip.className = 'tag';
            chip.textContent = 'qa-tag';
            chip.setAttribute('role', 'button');
            tags.prepend(chip);
        });
    }
    await candidate.locator(target).first().click();
}

async function openFixtureGroup(page, { tagged = false, tagCount = tagged ? 1 : 0, memberCount = 2, active = false } = {}) {
    return page.evaluate(async ({ tagCount, memberCount, active }) => {
        const app = await import('/script.js');
        const groupChats = await import('/scripts/group-chats.js');
        const tagsApi = await import('/scripts/tags.js');
        window.__sbTestTags = tagsApi;
        const members = app.characters.slice(0, memberCount).map(character => character.avatar);
        const group = {
            id: 'member-list-qa-motion-fixture',
            name: 'qa-motion-group',
            members,
            disabled_members: [],
            member_models: {},
            avatar_url: '',
            chats: [],
            activation_strategy: 0,
            generation_mode: 0,
            allow_self_responses: false,
            hideMutedSprites: false,
        };
        if (active) {
            group.chat_id = 'member-list-qa-chat';
            group.chats = [group.chat_id];
        }
        groupChats.groups.push(group);
        const fixtures = window.__sbMemberListFixtures ??= { groups: [], baselines: [], tags: [], tagMaps: [] };
        fixtures.groups.push(group.id);
        fixtures.baselines.push(structuredClone(group));
        let tagId = null;
        if (tagCount) fixtures.tagMaps.push([members[0], tagsApi.tag_map[members[0]]]);
        const tagIds = [];
        for (let index = 0; index < tagCount; index++) {
            const tag = { id: `member-list-qa-tag-${index}`, name: `QA tag ${index}`, color: 'rgb(90, 160, 220)', color2: 'white' };
            tagsApi.tags.push(tag);
            tag.color = 'rgb(90, 160, 220)';
            tagId ??= tag.id;
            tagIds.push(tag.id);
            fixtures.tags.push(tag.id);
        }
        if (tagCount) tagsApi.tag_map[members[0]] = tagIds;
        if (active) await groupChats.openGroupById(group.id, { switchMenu: true });
        else groupChats.select_group_chats(group.id, false);
        if (tagCount) tagsApi.printTagFilters(tagsApi.tag_filter_type.group_members_list);
        return { id: group.id, members, tagId };
    }, { tagCount, memberCount, active });
}

async function assertRowsFit(page) {
    const dimensions = await page.locator('#rm_group_members .group_member, #rm_group_add_members .group_member').evaluateAll(rows => rows.map(row => ({
        client: row.clientWidth,
        scroll: row.scrollWidth,
    })));
    expect(dimensions.length).toBeGreaterThan(0);
    expect(dimensions.every(row => row.scroll <= row.client)).toBe(true);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 375, height: 812 }]) {
    test(`group chat settings align dropdowns at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openCreateGroup(page, viewport.width <= 768);
        const strategy = page.locator('#rm_group_activation_strategy');
        const generation = page.locator('#rm_group_generation_mode');
        await strategy.scrollIntoViewIfNeeded();
        await expect(strategy).toHaveAccessibleName('Group reply strategy');
        await expect(generation).toHaveAccessibleName('Group generation handling mode');

        const strategyBox = await strategy.boundingBox();
        const generationBox = await generation.boundingBox();
        expect(Math.abs(strategyBox.x - generationBox.x)).toBeLessThan(1);
        expect(Math.abs(strategyBox.width - generationBox.width)).toBeLessThan(1);
        expect(Math.abs(strategyBox.height - generationBox.height)).toBeLessThan(1);
        const layout = await page.locator('#rm_group_buttons').evaluate(node => ({
            width: node.clientWidth,
            scroll: node.scrollWidth,
        }));
        expect(layout.scroll).toBeLessThanOrEqual(layout.width);

        // Rewrapping the selects must preserve the existing join-template toggle.
        await generation.selectOption('1');
        await expect(page.locator('#group_join_templates')).toBeVisible();
        await expect(page.locator('#rm_group_generation_mode_join_prefix')).toBeVisible();
        await expect(page.locator('#rm_group_generation_mode_join_suffix')).toBeVisible();
        await generation.selectOption('0');
        await expect(page.locator('#group_join_templates')).toBeHidden();
    });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
    test(`member boxed lists support row actions at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openCreateGroup(page, viewport.width <= 768);
        await expect(page.locator('#rm_group_quick_create')).toHaveCount(0);
        const first = await addFirstCandidate(page);
        const second = await addFirstCandidate(page);
        await assertRowsFit(page);

        // Upstream inserts new members at the start of the draft order.
        await openMemberMenu(page, second.row);
        await expect(page.getByRole('menuitem', { name: 'Move up', exact: true })).toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByRole('menuitem', { name: 'Move down', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByRole('menuitem', { name: 'Remove', exact: true })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'View character', exact: true })).toHaveCount(0);
        await expect(page.getByRole('menuitem', { name: 'Speak now', exact: true })).toHaveCount(0);
        await page.getByRole('menuitem', { name: 'Move down', exact: true }).click();
        await expect(page.locator('#rm_group_members .group_member').first()).toHaveAttribute('data-avatar', first.avatar);
        await expect(second.row.locator('.sb-group-member-menu')).toBeFocused();

        const replies = first.row.getByRole('switch');
        await expect(replies).toBeChecked();
        await replies.uncheck();
        await expect(first.row).toHaveClass(/disabled/);
        await expect(replies).toBeFocused();
        await replies.check();
        await expect(first.row).not.toHaveClass(/disabled/);
        await expect(replies).toBeFocused();

        await openMemberMenu(page, first.row);
        await page.getByRole('menuitem', { name: 'Model override…', exact: true }).click();
        const popup = page.locator('dialog.popup').last();
        await popup.getByRole('textbox').fill('qa-member-model');
        await popup.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(popup).toBeHidden();
        await expect(first.row.locator('.ds-entity-row__subtitle')).toContainText('Model: qa-member-model');
        await expect(first.row.locator('.sb-group-member-menu')).toBeFocused();
        await assertRowsFit(page);

        await openMemberMenu(page, first.row);
        await page.getByRole('menuitem', { name: 'Model override…', exact: true }).click();
        await expect(popup.getByRole('textbox')).toHaveValue('qa-member-model');
        await popup.getByRole('textbox').fill('canceled-model');
        await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(popup).toBeHidden();
        await expect(first.row.locator('.ds-entity-row__subtitle')).toContainText('Model: qa-member-model');

        await openMemberMenu(page, first.row);
        await page.getByRole('menuitem', { name: 'Model override…', exact: true }).click();
        await popup.getByRole('textbox').fill('');
        await popup.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(popup).toBeHidden();
        await expect(first.row.locator('.sb-group-member-model')).toBeEmpty();
        await expect(first.row.locator('.sb-group-member-menu')).toBeFocused();

        await openMemberMenu(page, first.row);
        await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
        await expect(first.row).toHaveCount(0);
        await expect(second.row.locator('.sb-group-member-menu')).toBeFocused();
        await expect(page.locator(`#rm_group_add_members .group_member[data-avatar=${JSON.stringify(first.avatar)}]`)).toBeVisible();
        await expect(page.locator('#rm_group_members_pagination .sb-list-pagination select')).toHaveCount(1);
        await assertRowsFit(page);
    });
}

test('candidate and cloned member tag menus use their live upstream filters', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCreateGroup(page, false);
    await openFixtureGroup(page, { tagged: true, active: true });
    await page.evaluate(async () => window.__sbTestTags.printTagFilters(window.__sbTestTags.tag_filter_type.group_candidates_list));
    const candidateButton = page.locator('#rm_group_add_members_header + .rm_tag_controls .sb-tag-filter-menu-button');
    await candidateButton.click();
    const picker = page.locator('.sb-picker:visible');
    const candidateTag = picker.getByRole('option', { name: /^QA tag 0/ });
    await expect(candidateTag).toHaveClass(/is-muted/);
    await candidateTag.click();
    await expect(candidateTag).toHaveAttribute('aria-selected', 'true');
    await expect(picker.locator('.sb-picker__search')).toBeFocused();
    await expect(candidateButton.locator('.sb-tag-filter-menu-count')).toHaveText('1');
    await expect(page.locator('#rm_group_add_members .group_member')).toHaveCount(0);
    await picker.getByRole('button', { name: 'Clear all filters', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(candidateButton.locator('.sb-tag-filter-menu-count')).toBeHidden();

    await page.locator('#groupCurrentMemberPopoutButton').click();
    const popout = page.locator('#groupMemberListPopout');
    // Upstream rebuilds (member add/remove) must render only into the original controls; the clone is synced from them.
    await expect(page.locator('[id="rm_group_members_header"]')).toHaveCount(1);
    await page.evaluate(async () => window.__sbTestTags.printTagFilters(window.__sbTestTags.tag_filter_type.group_members_list));
    const liveTagCount = await page.locator('#currentGroupMembers .rm_tag_filter .tag').count();
    await expect(popout.locator('.rm_tag_filter .tag')).toHaveCount(liveTagCount);
    const clonedButton = popout.locator('.sb-tag-filter-menu-button');
    await clonedButton.click();
    const clonedTag = picker.getByRole('option', { name: /^QA tag 0/ });
    await clonedTag.click();
    await expect(clonedTag).toHaveAttribute('aria-selected', 'true');
    await expect(picker.locator('.sb-picker__search')).toBeFocused();
    await expect(clonedButton.locator('.sb-tag-filter-menu-count')).toHaveText('1');
    await expect(page.locator('#currentGroupMembers .sb-tag-filter-menu-count')).toHaveText('1');
    await expect(page.locator('#rm_group_members .group_member')).toHaveCount(1);
    await clonedTag.click();
    await expect(clonedTag.locator('.fa-minus')).toBeVisible();
    await clonedTag.click();
    await expect(clonedButton.locator('.sb-tag-filter-menu-count')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(clonedButton).toBeFocused();
    await page.locator('#groupMemberListPopoutClose').click();
    await expect(popout).toHaveCount(0);
});

test('cloned member popout keeps delegated switches and action menus', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCreateGroup(page, false);
    const { avatar, row } = await addFirstCandidate(page);
    const other = await addFirstCandidate(page);
    // The popout transport is hidden in create mode, but still exercises the
    // exact HTML-only clone used by persisted groups without opening a user chat.
    await page.locator('#groupCurrentMemberPopoutButton').evaluate(button => button.click());
    const popout = page.locator('#groupMemberListPopout');
    const clone = popout.locator(`.group_member[data-avatar=${JSON.stringify(avatar)}]`);
    await expect(clone).toBeVisible();
    expect(await clone.evaluate(node => $(node).data('id'))).toBeUndefined();
    await expect(clone.locator('.sb-group-member-grip')).toBeHidden();
    await clone.getByRole('switch').uncheck();
    await expect(clone).toHaveClass(/disabled/);
    await expect(row).toHaveClass(/disabled/);
    await expect(clone.getByRole('switch')).toBeFocused();
    await openMemberMenu(page, clone);
    await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
    await expect(clone.locator('.sb-group-member-menu')).toBeFocused();
    await openMemberMenu(page, clone);
    await page.getByRole('menuitem', { name: 'Model override…', exact: true }).click();
    const popup = page.locator('dialog.popup').last();
    await popup.getByRole('textbox').fill('qa-popout-model');
    await popup.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(popup).toBeHidden();
    await expect(clone.locator('.sb-group-member-menu')).toBeFocused();
    await openMemberMenu(page, clone);
    await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
    await expect(clone).toHaveCount(0);
    await expect(row).toHaveCount(0);
    const neighbour = popout.locator(`.group_member[data-avatar=${JSON.stringify(other.avatar)}]`);
    await expect(neighbour.locator('.sb-group-member-menu')).toBeFocused();
    await openMemberMenu(page, neighbour);
    await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
    await expect(popout.locator('[id="rm_group_members_filter"]')).toBeFocused();
    await page.locator('#groupMemberListPopoutClose').click();
    await expect(popout).toBeHidden();
});

test('candidate row, static tag and Add button each add exactly once', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCreateGroup(page, false);
    await page.evaluate(async () => {
        const app = await import('/script.js');
        window.memberListActionCount = 0;
        app.eventSource.on(app.event_types.GROUP_UPDATED, () => { window.memberListActionCount++; });
    });
    const candidate = page.locator('#rm_group_add_members .group_member').first();
    await candidate.locator('.tags').evaluate(tags => {
        const expander = document.createElement('span');
        expander.className = 'tag placeholder-expander clickable-action';
        expander.setAttribute('role', 'button');
        expander.textContent = 'qa-more';
        tags.prepend(expander);
    });
    await candidate.locator('.placeholder-expander').click();
    await expect(page.locator('#rm_group_members .group_member')).toHaveCount(0);
    let before = 0;
    for (const target of ['.ch_name', '.tag', '[data-action="add"]']) {
        const candidate = page.locator('#rm_group_add_members .group_member').first();
        const avatar = await candidate.getAttribute('data-avatar');
        await clickCandidateTarget(candidate, target);
        const members = page.locator('#rm_group_members .group_member');
        await expect(members).toHaveCount(++before);
        await expect(page.locator(`#rm_group_members .group_member[data-avatar=${JSON.stringify(avatar)}]`)).toHaveCount(1);
        await expect.poll(() => page.evaluate(() => window.memberListActionCount)).toBe(before);
    }
});

test('member list motion respects reduced motion and animates normal adds', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCreateGroup(page, false);
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    const reduced = await addFirstCandidate(page);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await openMemberMenu(page, reduced.row);
    await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
    await expect(reduced.row).toHaveCount(0);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => document.body.classList.remove('reduced-motion'));
    const candidate = page.locator('#rm_group_add_members .group_member').first();
    await candidate.locator('.ch_name').click();
    await expect.poll(() => page.evaluate(() => document.getAnimations().some(animation => {
        const target = animation.effect?.target;
        return target?.closest?.('#rm_group_members, #rm_group_add_members');
    }))).toBe(true);
});

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 375, height: 812 }]) {
    test(`group tag filters expose Libadwaita states and screenshots at ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openCreateGroup(page, viewport.width <= 768);
        await openFixtureGroup(page, { tagged: true, active: true });
        const controls = page.locator('#currentGroupMembers .ds-tag-filter');
        const tagButton = controls.locator('.sb-tag-filter-menu-button');
        await expect(tagButton).toBeVisible();
        await tagButton.click();
        const picker = page.locator('.sb-picker:visible, .sb-picker-sheet:visible').last();
        const search = picker.locator('.sb-picker__search');
        const namedTag = picker.getByRole('option', { name: /^QA tag 0/ });
        await expect(namedTag).toBeVisible();
        const rowTag = page.locator('#rm_group_members .ds-tag-chips .tag').first();
        await expect(rowTag).toHaveCount(1);
        await expect(namedTag.locator('.sb-tag-filter-menu-dot')).toHaveCSS('background-color', 'rgb(90, 160, 220)');
        await expect.poll(() => rowTag.evaluate(element => getComputedStyle(element).getPropertyValue('--sb-tag-color').trim())).toBe('rgb(90, 160, 220)');

        await picker.screenshot({ path: `/tmp/opencode/tagfilter-${viewport.name}-off.png` });
        await page.locator('#rm_group_members').screenshot({ path: `/tmp/opencode/tagfilter-${viewport.name}-row-chips.png` });
        await namedTag.click();
        await expect(namedTag).toHaveAttribute('aria-selected', 'true');
        await expect(namedTag).toBeInViewport();
        await expect(namedTag.locator('.fa-check')).toBeVisible();
        await expect(search).toBeFocused();
        await expect(tagButton.locator('.sb-tag-filter-menu-count')).toHaveText('1');
        await picker.screenshot({ path: `/tmp/opencode/tagfilter-${viewport.name}-selected.png` });
        await namedTag.click();
        await expect(namedTag).toHaveAttribute('aria-selected', 'false');
        await expect(namedTag).toBeInViewport();
        await expect(namedTag.locator('.fa-minus')).toBeVisible();
        await expect(search).toBeFocused();
        await picker.screenshot({ path: `/tmp/opencode/tagfilter-${viewport.name}-excluded.png` });
        await namedTag.click();
        await expect(namedTag.locator('.fa-minus')).toHaveCount(0);
        await expect(tagButton.locator('.sb-tag-filter-menu-count')).toBeHidden();
        await page.keyboard.press('Escape');
        await expect(tagButton).toBeFocused();

        const favorites = controls.locator('.filterByFavorites');
        await favorites.evaluate(element => {
            element.setAttribute('data-toggle-state', 'UNDEFINED');
            element.classList.remove('selected', 'excluded');
            element.setAttribute('aria-pressed', 'false');
        });
        await favorites.click();
        await expect(favorites).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(() => favorites.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
        // The colour change is a 200ms transition, so wait for it to settle.
        await expect.poll(() => favorites.evaluate(element => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--sb-color-warning)';
            document.body.append(probe);
            const matches = getComputedStyle(element).color === getComputedStyle(probe).color;
            probe.remove();
            return matches;
        })).toBe(true);
    });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
    test(`edit-mode member changes stay in the draft and discard at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openCreateGroup(page, viewport.width <= 768);
        const fixture = await page.evaluate(async () => {
            const app = await import('/script.js');
            const groupChats = await import('/scripts/group-chats.js');
            const group = {
                id: 'member-list-qa-fixture',
                name: 'qa-group',
                members: app.characters.slice(0, 2).map(character => character.avatar),
                disabled_members: [],
                member_models: {},
                avatar_url: '',
                chats: [],
                activation_strategy: 0,
                generation_mode: 0,
                allow_self_responses: false,
                hideMutedSprites: false,
            };
            groupChats.groups.push(group);
            const baseline = structuredClone(group);
            const fixtures = window.__sbMemberListFixtures ??= { groups: [], baselines: [], tags: [], tagMaps: [] };
            fixtures.groups.push(group.id);
            fixtures.baselines.push(baseline);
            // Open only the editor, not a chat that could save user metadata.
            groupChats.select_group_chats(group.id, false);
            return baseline;
        });
        const members = page.locator('#rm_group_members .group_member');
        await expect(members).toHaveCount(2);
        const added = await addFirstCandidate(page);
        await openMemberMenu(page, added.row);
        await expect(page.getByRole('menuitem', { name: 'Speak now', exact: true })).toBeVisible();
        await page.getByRole('menuitem', { name: 'Move down', exact: true }).click();
        await expect(added.row.locator('.sb-group-member-menu')).toBeFocused();
        await openMemberMenu(page, added.row);
        await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
        await expect(added.row.locator('.sb-group-member-menu')).toBeFocused();
        await added.row.getByRole('switch').focus();
        await page.keyboard.press('Space');
        await expect(added.row).toHaveClass(/disabled/);
        await expect(added.row.getByRole('switch')).toBeFocused();
        await openMemberMenu(page, added.row);
        await page.getByRole('menuitem', { name: 'Model override…', exact: true }).click();
        const popup = page.locator('dialog.popup').last();
        await popup.getByRole('textbox').fill('qa-unsaved-model');
        await popup.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(popup).toBeHidden();
        await expect(added.row.locator('.sb-group-member-menu')).toBeFocused();
        const neighbourAvatar = await members.nth(1).getAttribute('data-avatar');
        const removed = members.last();
        const removedAvatar = await removed.getAttribute('data-avatar');
        await openMemberMenu(page, removed);
        await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
        await expect(page.locator(`#rm_group_members .group_member[data-avatar=${JSON.stringify(removedAvatar)}]`)).toHaveCount(0);
        await expect(page.locator(`#rm_group_members .group_member[data-avatar=${JSON.stringify(neighbourAvatar)}] .sb-group-member-menu`)).toBeFocused();
        await page.locator('#sb_group_editor_content').evaluate(content => { content.scrollTop = 0; });
        await expect(page.locator('#sb_group_editor_dirty')).toBeVisible();
        const readLiveGroup = () => page.evaluate(async id => (await import('/scripts/group-chats.js')).groups.find(group => group.id === id), fixture.id);
        expect(await readLiveGroup()).toEqual(fixture);
        await expectOnlyLiveGroupPayloads(page);
        await page.locator('#sb_group_editor_cancel').click();
        await expect(page.locator('#sb_group_editor_dirty')).toBeHidden();
        await expect(members).toHaveCount(2);
        expect(await members.evaluateAll(rows => rows.map(row => row.getAttribute('data-avatar')))).toEqual(fixture.members);
        await expect(page.locator('#rm_group_members .disabled')).toHaveCount(0);
        await expect(page.locator('#rm_group_members .sb-group-member-model')).toHaveText(['', '']);
        expect(await readLiveGroup()).toEqual(fixture);
        await expectOnlyLiveGroupPayloads(page);
    });
}

for (const target of ['own', 'other']) {
    test(`releasing a member drag over ${target === 'own' ? 'its own' : 'another'} avatar does not open a character`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openCreateGroup(page, false);
        const first = await addFirstCandidate(page);
        const second = await addFirstCandidate(page);
        await page.locator('#rm_group_members').scrollIntoViewIfNeeded();
        const grip = await second.row.locator('.sb-group-member-grip').boundingBox();
        const avatar = await (target === 'own' ? second : first).row.locator('.ds-entity-row__avatar').boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(avatar.x + avatar.width / 2, avatar.y + avatar.height / 2, { steps: 12 });
        await page.mouse.up();
        // The create draft is dirty, so a stray navigation would surface as the leave prompt.
        // Let the sortable revert finish before asserting that nothing opened.
        await expect(page.locator('#rm_group_members .ui-sortable-placeholder')).toHaveCount(0);
        await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
        await expect(page.locator('#sb_group_editor_header')).toBeVisible();
        await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'group_create');
        expect(await page.evaluate(async () => (await import('/scripts/sillybunny-editor/object-navigation.js')).objectNavigation.depth)).toBe(0);
    });
}

test('member grips reorder the draft and hide while filtering', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCreateGroup(page, false);
    const first = await addFirstCandidate(page);
    const second = await addFirstCandidate(page);
    await page.locator('#rm_group_members').scrollIntoViewIfNeeded();
    const grip = await second.row.locator('.sb-group-member-grip').boundingBox();
    const target = await first.row.boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2, target.y + target.height - 4, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('#rm_group_members .group_member').first()).toHaveAttribute('data-avatar', first.avatar);
    await page.locator('#rm_group_members_filter').fill(await first.row.locator('.ch_name').innerText());
    await expect(page.locator('#rm_group_members')).toHaveClass(/is-filtered/);
    await expect(first.row.locator('.sb-group-member-grip')).toBeHidden();
    await page.locator('#rm_group_members_filter').fill('');
    await expect(first.row.locator('.sb-group-member-grip')).toBeVisible();
});

test('member row Enter, Space and pointer activation use object navigation', async ({ page }) => {
    await openCreateGroup(page, false);
    const fixture = await openFixtureGroup(page, { tagged: true });
    await page.evaluate(async () => {
        const { objectNavigation } = await import('/scripts/sillybunny-editor/object-navigation.js');
        window.__sbMemberNavigationCalls = [];
        window.__sbOriginalMemberNavigate = objectNavigation.navigate;
        objectNavigation.navigate = async (target, options) => {
            window.__sbMemberNavigationCalls.push({ target, options: { ...options, from: options.from() } });
            return { ok: true };
        };
    });
    try {
        const member = page.locator('#rm_group_members .group_member').first();
        await expect(member.locator('.ds-entity-row__chevron')).toBeVisible();
        await member.focus();
        await page.keyboard.press('ArrowDown');
        await expect(page.locator('#rm_group_members .group_member').last()).toBeFocused();
        await page.keyboard.press('Home');
        await expect(member).toBeFocused();
        await page.keyboard.press('End');
        await expect(page.locator('#rm_group_members .group_member').last()).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await expect(member).toBeFocused();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');
        await member.locator('.ch_name').click();
        await expect.poll(() => page.evaluate(() => window.__sbMemberNavigationCalls.length)).toBe(3);
        expect(await page.evaluate(() => window.__sbMemberNavigationCalls[0])).toEqual({
            target: { kind: 'character-editor', id: fixture.members[0], via: 'group-member' },
            options: { from: { kind: 'group-editor', id: fixture.id } },
        });
        await member.locator('.tag').first().click();
        await member.locator('.sb-group-member-grip').click();
        await member.getByRole('switch').uncheck();
        expect(await page.evaluate(() => window.__sbMemberNavigationCalls.length)).toBe(3);
    } finally {
        await page.evaluate(async () => {
            const { objectNavigation } = await import('/scripts/sillybunny-editor/object-navigation.js');
            objectNavigation.navigate = window.__sbOriginalMemberNavigate;
        });
    }
});

test('off-page /member-disable preserves the visible native pagination page', async ({ page }) => {
    await page.route('**/api/chats/group/info', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/group/get', route => route.fulfill({ json: [{ chat_metadata: { tainted: true } }] }));
    await page.route('**/api/chats/group/save', route => route.fulfill({ json: { result: 'ok' } }));
    await openCreateGroup(page, false);
    const count = await page.evaluate(async () => (await import('/script.js')).characters.length);
    // eslint-disable-next-line playwright/no-skipped-test -- Keep fixtures in memory; never create user character files just to fill a page.
    test.skip(count < 6, 'Requires six existing test characters for a second page');
    await openFixtureGroup(page, { memberCount: 6, active: true });
    const pagination = page.locator('#rm_group_members_pagination .sb-list-pagination');
    await pagination.getByRole('combobox').selectOption('5');
    await pagination.getByRole('button', { name: 'Next page', exact: true }).click();
    const members = page.locator('#rm_group_members .group_member');
    await expect(members).toHaveCount(1);
    const visibleBefore = await members.evaluateAll(rows => rows.map(row => row.dataset.avatar));
    const pageBefore = await pagination.locator('.sb-list-pagination__status').innerText();
    await page.evaluate(async () => {
        const { executeSlashCommandsWithOptions } = await import('/scripts/slash-commands.js');
        await executeSlashCommandsWithOptions('/member-disable 0');
    });
    await expect(pagination.locator('.sb-list-pagination__status')).toHaveText(pageBefore);
    expect(await members.evaluateAll(rows => rows.map(row => row.dataset.avatar))).toEqual(visibleBefore);
    await pagination.getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(members.first()).toHaveClass(/disabled/);
});

test('group row tags are capped at three chips plus the overflow count', async ({ page }) => {
    await openCreateGroup(page, false);
    const fixture = await openFixtureGroup(page, { tagCount: 5 });
    const row = page.locator(`#rm_group_members .group_member[data-avatar=${JSON.stringify(fixture.members[0])}]`);
    await expect(row.locator('.ds-entity-row__tags .tag:not(.sb-tag-overflow):not([hidden])')).toHaveCount(3);
    await expect(row.locator('.sb-tag-overflow')).toHaveText('+2');
    await expect(row.locator('.sb-tag-overflow')).toHaveAttribute('aria-label', /QA tag/);
    await expect(row.locator('.placeholder-expander:visible')).toHaveCount(0);
});

test('empty groups and filtered lists have distinct status and empty text', async ({ page }) => {
    await openCreateGroup(page, false);
    const members = page.locator('#rm_group_members');
    await expect(members).toHaveAttribute('data-empty-text', 'Group is empty.');
    await openFixtureGroup(page, { memberCount: 1 });
    const memberSearch = page.locator('#rm_group_members_filter');
    await expect(memberSearch).toHaveAccessibleName('Search');
    await memberSearch.fill('qa-no-such-member-967018');
    await expect(members.locator('.group_member')).toHaveCount(0);
    await expect(members).toHaveAttribute('data-empty-text', 'No results');
    expect(await members.evaluate(node => getComputedStyle(node, '::before').content)).toContain('No results');
    await expect(page.locator('[data-sb-section="members"] [data-sb-group-list-status]')).toHaveText('No results');
    await memberSearch.press('Escape');
    await expect(memberSearch).toBeVisible();
    await expect(memberSearch).toHaveValue('');
    await expect(members.locator('.group_member')).toHaveCount(1);
    const candidateSearch = page.locator('#rm_group_filter');
    await expect(candidateSearch).toHaveAccessibleName('Search');
    await candidateSearch.fill('qa-no-such-candidate-967018');
    await expect(page.locator('#rm_group_add_members .group_member')).toHaveCount(0);
    await expect(page.locator('#rm_group_add_members')).toHaveAttribute('data-empty-text', 'No results');
});

test('candidate Add focuses the next row, then the previous row, then search', async ({ page }) => {
    await openCreateGroup(page, false);
    const count = await page.evaluate(async () => (await import('/script.js')).characters.length);
    // eslint-disable-next-line playwright/no-skipped-test -- The test uses existing cards only and keeps three candidates in memory.
    test.skip(count < 3, 'Requires three existing test characters');
    await openFixtureGroup(page, { memberCount: count - 3 });
    const candidates = page.locator('#rm_group_add_members .group_member');
    await expect(candidates).toHaveCount(3);
    const firstTwo = await candidates.evaluateAll(rows => rows.slice(0, 2).map(row => row.dataset.avatar));
    await candidates.first().getByRole('button', { name: 'Add to group', exact: true }).click();
    await expect(page.locator(`#rm_group_add_members .group_member[data-avatar=${JSON.stringify(firstTwo[1])}]`)).toBeFocused();
    await page.locator('#rm_group_add_members_pagination .sb-list-pagination__size').selectOption('1000');
    const previous = await candidates.nth((await candidates.count()) - 2).getAttribute('data-avatar');
    await candidates.last().getByRole('button', { name: 'Add to group', exact: true }).click();
    await expect(page.locator(`#rm_group_add_members .group_member[data-avatar=${JSON.stringify(previous)}]`)).toBeFocused();
    await expect(candidates).toHaveCount(1);
    await candidates.first().focus();
    await page.keyboard.press('Enter');
    await expect(candidates).toHaveCount(0);
    await expect(page.locator('#rm_group_filter')).toBeFocused();
    await expect(page.locator('#rm_group_add_members')).toHaveAttribute('data-empty-text', 'No characters available');
});
