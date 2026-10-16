import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';

const persistenceRequests = new WeakMap();

test.beforeEach(async ({ page }) => {
    const requests = [];
    persistenceRequests.set(page, requests);
    page.on('request', request => {
        if (/\/api\/groups\/(edit|create)$/.test(new URL(request.url()).pathname)) requests.push(request.url());
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
    expect(persistenceRequests.get(page), 'No group persistence before explicit editor Save').toEqual([]);
});

async function openCreateGroup(page, mobile) {
    await page.goto('/');
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.locator('#sb-character-toggle').click();
    if (mobile) {
        await page.getByRole('button', { name: 'Back to settings navigation', exact: true }).click();
    }
    await page.getByRole('complementary', { name: 'Settings navigation' }).getByRole('tab', { name: 'Groups' }).click();
    await page.locator('#rm_button_group_chats').click();
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

async function openFixtureGroup(page, { tagged = false } = {}) {
    return page.evaluate(async ({ tagged }) => {
        const app = await import('/script.js');
        const groupChats = await import('/scripts/group-chats.js');
        const tagsApi = await import('/scripts/tags.js');
        window.__sbTestTags = tagsApi;
        const members = app.characters.slice(0, 2).map(character => character.avatar);
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
        groupChats.groups.push(group);
        let tagId = null;
        if (tagged) {
            const tag = { id: 'member-list-qa-tag', name: 'QA tag', color: 'rgb(90, 160, 220)', color2: 'white' };
            tagsApi.tags.push(tag);
            tag.color = 'rgb(90, 160, 220)';
            tagId = tag.id;
            tagsApi.tag_map[members[0]] = [tag.id];
        }
        groupChats.select_group_chats(group.id, false);
        if (tagged) tagsApi.printTagFilters(tagsApi.tag_filter_type.group_members_list);
        return { id: group.id, members, tagId };
    }, { tagged });
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
        await expect(page.locator('#rm_group_members_pagination select')).toHaveCount(1);
        await assertRowsFit(page);
    });
}

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
        const fixture = await openFixtureGroup(page, { tagged: true });
        const controls = page.locator('#currentGroupMembers .ds-tag-filter');
        await controls.locator('.showTagList').click();
        await page.evaluate(({ tagId }) => {
            const tagsApi = window.__sbTestTags;
            tagsApi.printTagList('#rm_group_members_header ~ .rm_tag_controls .rm_tag_filter', {
                empty: false,
                tags: tagsApi.tags.filter(tag => tag.id === tagId),
                tagOptions: { isFilter: true, isGeneralList: true },
            });
            document.querySelector('#rm_group_members_header ~ .rm_tag_controls .rm_tag_filter .tag:not(.actionable)').style.display = 'flex';
        }, fixture);
        const namedTag = controls.locator('.tag:not(.actionable)').first();
        await expect(namedTag).toHaveCount(1);
        const rowTag = page.locator('#rm_group_members .ds-tag-chips .tag').first();
        await expect(rowTag).toHaveCount(1);
        await expect.poll(() => namedTag.evaluate(element => getComputedStyle(element).getPropertyValue('--sb-tag-color').trim())).toBe('rgb(90, 160, 220)');
        await expect.poll(() => rowTag.evaluate(element => getComputedStyle(element).getPropertyValue('--sb-tag-color').trim())).toBe('rgb(90, 160, 220)');

        await controls.screenshot({ path: `/tmp/opencode/tagfilter-${viewport.name}-off.png` });
        await page.locator('#rm_group_members').screenshot({ path: `/tmp/opencode/tagfilter-${viewport.name}-row-chips.png` });
        await namedTag.click();
        await expect.poll(() => namedTag.evaluate(element => element.getAnimations().length)).toBe(0);
        await controls.screenshot({ path: `/tmp/opencode/tagfilter-${viewport.name}-selected.png` });
        await namedTag.click();
        await expect.poll(() => namedTag.evaluate(element => element.getAnimations().length)).toBe(0);
        await controls.screenshot({ path: `/tmp/opencode/tagfilter-${viewport.name}-excluded.png` });

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
        expect(persistenceRequests.get(page)).toEqual([]);
        await page.locator('#sb_group_editor_cancel').click();
        await expect(page.locator('#sb_group_editor_dirty')).toBeHidden();
        await expect(members).toHaveCount(2);
        expect(await members.evaluateAll(rows => rows.map(row => row.getAttribute('data-avatar')))).toEqual(fixture.members);
        await expect(page.locator('#rm_group_members .disabled')).toHaveCount(0);
        await expect(page.locator('#rm_group_members .sb-group-member-model')).toHaveText(['', '']);
        expect(await readLiveGroup()).toEqual(fixture);
        expect(persistenceRequests.get(page)).toEqual([]);
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
