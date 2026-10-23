import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { q56Screenshot } from './helpers/q56-review.js';

const list = page => page.locator('.sb-character-list[data-mounted="true"]');
const listRows = (page, view) => list(page).locator(view === 'groups' ? '.group_select' : '.character_select');
const pageSize = page => list(page).getByRole('combobox', { name: 'Items per page' });

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    const characters = Array.from({ length: 28 }, (_, index) => {
        const name = `QA character ${String(index).padStart(2, '0')}`;
        const data = {
            name, description: '', personality: '', scenario: '', first_mes: 'QA greeting', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
            tags: [], creator: '', character_version: '', extensions: { fav: false, talkativeness: 0.5 },
        };
        return {
            ...data, avatar: `qa-list-character-${index}.png`, chat: `qa-list-character-chat-${index}`,
            create_date: `2026-10-${String(index + 1).padStart(2, '0')}`, date_added: index + 1,
            spec: 'chara_card_v2', spec_version: '2.0', data,
        };
    });
    await page.route('**/api/characters/all', route => route.fulfill({ json: characters }));
    await page.route('**/api/characters/get', route => {
        const body = route.request().postDataBuffer();
        const payload = JSON.parse((route.request().headers()['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString());
        return route.fulfill({ json: characters.find(character => character.avatar === payload.avatar_url) });
    });
    await page.route('**/api/characters/chats', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/get', route => route.fulfill({ json: [] }));
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip'
            ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
    for (const endpoint of [
        'groups/edit', 'chats/group/save', 'chats/save',
        'characters/edit', 'characters/edit-attribute', 'characters/merge-attributes',
    ]) {
        await page.route(`**/api/${endpoint}`, route => route.fulfill({ json: {} }));
    }
    await page.route('**/api/chats/group/info', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/group/get', route => route.fulfill({ json: [
        { chat_metadata: { tainted: true } },
        { name: 'qa-list-group', is_user: false, is_system: false, send_date: '2026-10-18', mes: 'qa-list-chat' },
    ] }));
    // No test creates or deletes a card, group, or chat on the live server.
    await page.route(/\/api\/(?:characters|groups|chats)\/(?:create|delete|duplicate|rename)$/, route => route.abort());
});

test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
        if (!window.__sbCharacterListOriginalGroups) return;
        document.getElementById('sb_group_editor_cancel')?.click();
        const groups = await import('/scripts/group-chats.js');
        const tags = await import('/scripts/tags.js');
        const { objectNavigation } = await import('/scripts/sillybunny-editor/object-navigation.js');
        const { getCurrentUserHandle } = await import('/scripts/user.js');
        objectNavigation.clear();
        groups.resetSelectedGroup();
        for (const group of groups.groups.filter(group => group.id.startsWith('qa-list-'))) {
            localStorage.removeItem(`sb-group-editor-draft-${getCurrentUserHandle() || 'default'}-${group.id}`);
        }
        groups.groups.splice(0, groups.groups.length, ...window.__sbCharacterListOriginalGroups);
        const tagFixtures = window.__sbCharacterListTagFixtures;
        if (tagFixtures) {
            for (const tagId of tagFixtures.ids) {
                const index = tags.tags.findIndex(tag => tag.id === tagId);
                if (index >= 0) tags.tags.splice(index, 1);
            }
            for (const [key, value] of tagFixtures.maps) {
                if (value === undefined) delete tags.tag_map[key];
                else tags.tag_map[key] = value;
            }
        }
        delete window.__sbCharacterListOriginalGroups;
        delete window.__sbCharacterListTagFixtures;
    });
});

async function showView(page, view) {
    await page.evaluate(async view => { await window.SillyBunnyShell.openTab('characters', view); }, view);
    await expect(list(page)).toBeVisible();
    await expect(list(page)).toHaveAttribute('data-view', view);
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).menu_type)).toBe('characters');
}

for (const { label, width, reducedMotion, appReducedMotion = false } of [
    { label: 'mobile', width: 390, reducedMotion: 'no-preference' },
    { label: 'desktop', width: 1440, reducedMotion: 'no-preference' },
    { label: 'mobile reduced motion', width: 390, reducedMotion: 'reduce' },
    { label: 'mobile app reduced motion', width: 390, reducedMotion: 'no-preference', appReducedMotion: true },
]) {
    const motionExpected = reducedMotion !== 'reduce' && !appReducedMotion;
    test.describe(`Characters first open on ${label}`, () => {
        test.use({ viewport: { width, height: 844 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion });

        test('first visible frames have settled panes, header actions and single-line rows', async ({ page }) => {
            await page.emulateMedia({ reducedMotion });
            await page.goto('/');
            await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
            await page.waitForFunction(() => !document.getElementById('preloader'));
            await page.evaluate(async appReducedMotion => {
                const app = await import('/script.js');
                const { power_user } = await import('/scripts/power-user.js');
                const tags = await import('/scripts/tags.js');
                power_user.bogus_folders = false;
                power_user.charListGrid = false;
                document.body.classList.remove('charListGrid');
                document.body.classList.toggle('reduced-motion', appReducedMotion);
                for (const type of ['fav', 'folder', 'group']) app.entitiesFilter.setFilterData(type, 'UNDEFINED', true);
                app.entitiesFilter.setFilterData('tag', { selected: [], excluded: [] }, true);
                app.entitiesFilter.setFilterData('search', '', true);
                document.getElementById('character_search_bar').value = '';
                const definitions = Array.from({ length: 5 }, (_, index) => ({ id: `qa-first-open-${index}`, name: `QA long first-open tag ${index}` }));
                tags.tags.push(...definitions);
                // Alternate tagged and untagged rows: both must have real, stable first-paint geometry.
                for (const [index, character] of app.characters.entries()) {
                    tags.tag_map[character.avatar] = index % 2 ? [] : definitions.map(tag => tag.id);
                }
                window.__sbFirstOpenFrames = [];
                window.__sbFirstOpenDone = new Promise(resolve => {
                    const start = performance.now();
                    const sample = () => {
                        const page = document.getElementById('sb-settings-page');
                        const panes = ['sb-settings-sidebar', 'sb-settings-content'].map(id => document.getElementById(id));
                        const animations = page.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running');
                        const section = document.querySelector('.sb-character-list[data-mounted="true"]');
                        const scale = new DOMMatrixReadOnly(getComputedStyle(page).transform).a;
                        const visible = !page.hidden && section && !section.closest('[hidden]') && getComputedStyle(section).visibility === 'visible' && Number(getComputedStyle(section).opacity) > 0;
                        const rect = element => {
                            const box = element.getBoundingClientRect();
                            const origin = page.getBoundingClientRect();
                            return { x: (box.x - origin.x) / scale, width: box.width / scale, height: box.height / scale };
                        };
                        window.__sbFirstOpenFrames.push({
                            visible, scale,
                            reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
                            pageMotion: animations.some(animation => animation.effect?.target === page),
                            paneMotion: animations.some(animation => panes.includes(animation.effect?.target) && animation.transitionProperty === 'transform'),
                            list: visible ? rect(section) : null,
                            buttons: visible ? [...section.querySelectorAll('.sb-character-list__header button')].filter(button => button.getClientRects().length).length : null,
                            rows: visible ? [...section.querySelectorAll('.ds-entity-row')].slice(0, 2).map(rect) : [],
                            strips: visible ? [...section.querySelectorAll('.ds-entity-row__tags')].slice(0, 2).map(strip => ({ wrap: getComputedStyle(strip).flexWrap, overflow: getComputedStyle(strip).overflowX })) : [],
                            styled: visible ? ['deferred-entity-list-css', 'deferred-editor-shell-css', 'deferred-character-list-css'].every(id => Boolean(document.getElementById(id)?.sheet)) : null,
                        });
                        if (performance.now() - start < 1600) requestAnimationFrame(sample);
                        else resolve();
                    };
                    requestAnimationFrame(sample);
                });
            }, appReducedMotion);
            await page.locator('#sb-character-toggle').click();
            await page.evaluate(() => window.__sbFirstOpenDone);
            const frames = await page.evaluate(() => window.__sbFirstOpenFrames);
            await test.info().attach('first-open-frames', { body: JSON.stringify(frames), contentType: 'application/json' });
            const visible = frames.filter(frame => frame.visible);
            expect(visible.length).toBeGreaterThan(2);
            expect(visible.every(frame => frame.rows.length === 2)).toBe(true);
            expect(frames.some(frame => frame.paneMotion)).toBe(false);
            expect(frames.every(frame => frame.reduced === (reducedMotion === 'reduce'))).toBe(true);
            expect(frames.some(frame => frame.pageMotion)).toBe(motionExpected);
            expect(new Set(visible.map(frame => frame.buttons)).size).toBe(1);
            expect(visible.every(frame => frame.styled)).toBe(true);
            expect(visible.every(frame => frame.strips.every(strip => strip.wrap === 'nowrap' && strip.overflow === 'hidden'))).toBe(true);
            const spread = values => Math.max(...values) - Math.min(...values);
            for (const property of ['x', 'width', 'height']) {
                expect(spread(visible.map(frame => frame.list[property]))).toBeLessThan(1);
            }
            for (const index of [0, 1]) expect(spread(visible.map(frame => frame.rows[index].height))).toBeLessThan(1);
            expect(frames.every(frame => motionExpected || frame.scale === 1)).toBe(true);
            // eslint-disable-next-line playwright/no-conditional-in-test -- Only the mobile, animated parameter has pane push navigation.
            if (width === 390 && motionExpected) {
                // Pane push navigation still belongs to a deliberate in-page Back/tab change.
                await page.locator('#sb-settings-back').click();
                await expect(page.locator('#sb-settings-page')).not.toHaveClass(/sb-settings-page--content/); // eslint-disable-line playwright/no-conditional-expect
                await page.getByRole('tab', { name: 'Characters', exact: true }).click();
                await expect(page.locator('#sb-settings-page')).toHaveClass(/sb-settings-page--content/); // eslint-disable-line playwright/no-conditional-expect
            }
        });
    });
}

async function prepareList(page, viewport) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.addStyleTag({ content: '#toast-container { display: none !important; }' });
    await showView(page, 'characters');
    await page.evaluate(async () => {
        const app = await import('/script.js');
        const groupChats = await import('/scripts/group-chats.js');
        const tagsApi = await import('/scripts/tags.js');
        const state = await import('/scripts/sillybunny-character-list-state.js');
        const { power_user } = await import('/scripts/power-user.js');
        if (app.characters.length !== 28) throw new Error('Character list QA fixtures did not load.');
        window.__sbCharacterListOriginalGroups = structuredClone(groupChats.groups);
        const members = app.characters.slice(0, 2).map(character => character.avatar);
        const fixtures = Array.from({ length: 28 }, (_, index) => ({
            id: `qa-list-${String(index).padStart(2, '0')}`,
            name: `qa-list-group-${String(index).padStart(2, '0')}`,
            members, disabled_members: [], member_models: {}, avatar_url: '',
            chat_id: `qa-list-chat-${index}`, chats: [`qa-list-chat-${index}`],
            activation_strategy: 0, generation_mode: 0, allow_self_responses: false,
            hideMutedSprites: false, fav: index === 0,
        }));
        groupChats.groups.splice(0, groupChats.groups.length, ...fixtures);
        const tagDefinitions = [
            { id: 'qa-list-tag-alpha', name: 'QA list alpha', color: 'rgb(90, 160, 220)', color2: 'white' },
            { id: 'qa-list-tag-beta', name: 'QA list beta', color: 'rgb(220, 150, 90)', color2: 'white' },
        ];
        const taggedAvatars = app.characters.slice(0, 3).map(character => character.avatar);
        const taggedGroups = fixtures.slice(0, 1).map(group => group.id);
        const tagMapKeys = [...taggedAvatars, ...taggedGroups];
        window.__sbCharacterListTagFixtures = {
            ids: tagDefinitions.map(tag => tag.id),
            maps: tagMapKeys.map(key => [key, tagsApi.tag_map[key]]),
        };
        tagsApi.tags.push(...tagDefinitions);
        tagsApi.tag_map[taggedAvatars[0]] = [tagDefinitions[0].id];
        tagsApi.tag_map[taggedAvatars[1]] = [tagDefinitions[1].id];
        tagsApi.tag_map[taggedAvatars[2]] = [tagDefinitions[0].id];
        tagsApi.tag_map[taggedGroups[0]] = [tagDefinitions[0].id];
        power_user.bogus_folders = false;
        power_user.show_tag_filters = true;
        power_user.charListGrid = false;
        document.body.classList.remove('charListGrid');
        for (const view of ['characters', 'groups']) {
            await state.switchCharacterListView(view);
            for (const type of ['fav', 'folder', 'group']) app.entitiesFilter.setFilterData(type, 'UNDEFINED', true);
            app.entitiesFilter.setFilterData('tag', { selected: [], excluded: [] }, true);
            app.entitiesFilter.setFilterData('search', '', true);
            app.entitiesFilter.clearFuzzySearchCaches();
            document.getElementById('character_search_bar').value = '';
            state.setListPageSize(view, 10);
            await state.setListPage(view, 1);
            await state.setListSort(view, { field: 'name', order: 'asc' });
            await app.printCharacters(false);
            tagsApi.printTagFilters(tagsApi.tag_filter_type.character);
        }
    });
    await showView(page, 'characters');
}

async function openTagPicker(page) {
    const controls = list(page).locator('.rm_tag_controls');
    const button = controls.locator('.sb-tag-filter-menu-button');
    await expect(button).toBeVisible();
    await button.click();
    const picker = page.locator('.sb-picker:visible, .sb-picker-sheet:visible').last();
    await expect(picker).toBeVisible();
    return { button, picker, search: picker.locator('.sb-picker__search') };
}

async function openHeaderMenu(page, action) {
    const button = list(page).locator(`[data-action-id="${action}"]`);
    if (await button.isVisible()) {
        await button.click();
        return;
    }
    await list(page).locator('[data-action-id="more"]').click();
    await page.getByRole('menuitem', { name: action === 'sort' ? 'Sort' : 'Search', exact: true }).click();
}

async function chooseSortItem(page, label) {
    await openHeaderMenu(page, 'sort');
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
}

async function setSearch(page, query) {
    if (!await page.locator('#character_search_bar').isVisible()) await openHeaderMenu(page, 'search');
    await page.locator('#character_search_bar').fill(query);
    await expect.poll(() => page.evaluate(() => window.SillyBunnyCharacterListController.captureState().query)).toBe(query);
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).entitiesFilter.getFilterData('search'))).toBe(query);
}

async function readSort(page, view) {
    return page.evaluate(async view => (await import('/scripts/sillybunny-character-list-state.js')).getListSort(view), view);
}

async function waitForChatActivation(page) {
    await expect(page.locator('#sb-settings-page')).toBeHidden();
    await expect(page.locator('#chat')).toBeVisible();
    await expect(page.locator('.is-activating-entity')).toHaveCount(0);
}

async function expectEditorBackRestoration(page, view) {
    await showView(page, view);
    if (view === 'groups') await setSearch(page, 'qa-list-group-');
    await pageSize(page).selectOption('10');
    await list(page).getByRole('button', { name: 'Next page', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.SillyBunnyCharacterListController.captureState().page)).toBe(2);
    const row = listRows(page, view).last();
    const key = await row.getAttribute('data-sb-list-key');
    await expect.poll(() => list(page).evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0);
    // Guarantee a scrollable origin even when ten rows fit on a tall desktop.
    await list(page).locator('.sb-character-list__box').evaluate(box => { box.style.maxHeight = '260px'; });
    await row.evaluate(element => element.focus({ preventScroll: true }));
    await list(page).locator('.sb-character-list__box').evaluate(box => { box.scrollTop = 35; });
    await row.getByRole('button', { name: 'Edit', exact: true }).evaluate(button => {
        button.addEventListener('click', () => {
            window.__sbCharacterListOrigin = window.SillyBunnyCharacterListController.captureState();
        }, { capture: true, once: true });
    });
    if (view === 'characters') await page.evaluate(async () => {
        const { debounce_timeout } = await import('/scripts/constants.js');
        const schedule = window.setTimeout;
        window.setTimeout = (callback, delay, ...args) => {
            if (delay === debounce_timeout.short && /at getChat \(/.test(new Error().stack)) {
                window.setTimeout = schedule;
                window.__sbDelayedComposerFocus = () => callback(...args);
                return schedule(() => {}, 0);
            }
            return schedule(callback, delay, ...args);
        };
    });
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = view === 'groups' ? '#sb_group_editor_header' : '#sb_character_editor_header';
    const back = view === 'groups' ? '#sb_group_editor_back' : '#sb_character_editor_back';
    await expect(page.locator(editor)).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-editor/object-navigation.js')).objectNavigation.depth)).toBe(1);
    if (view === 'characters') await page.waitForFunction(() => typeof window.__sbDelayedComposerFocus === 'function');
    const origin = await page.evaluate(() => window.__sbCharacterListOrigin);
    expect(origin.page).toBe(2);
    expect(origin.focusKey).toBe(key);
    expect(origin.scrollTop).toBeGreaterThan(0);
    await page.locator(back).click();
    await expect(list(page)).toBeVisible();
    await expect(list(page)).toHaveAttribute('data-view', view);
    await expect(list(page).locator(`[data-sb-list-key=${JSON.stringify(key)}]`)).toBeFocused();
    if (view === 'characters') await page.evaluate(async () => {
        window.__sbDelayedComposerFocus();
        delete window.__sbDelayedComposerFocus;
        await new Promise(requestAnimationFrame);
    });
    await expect(list(page).locator(`[data-sb-list-key=${JSON.stringify(key)}]`)).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.SillyBunnyCharacterListController.captureState())).toEqual(origin);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 375, height: 812 }]) {
    test(`editor avatar and tag removal are native keyboard controls at ${viewport.width}px`, async ({ page }) => {
        await prepareList(page, viewport);
        await listRows(page, 'characters').first().getByRole('button', { name: 'Edit', exact: true }).click();
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-editor/object-navigation.js')).objectNavigation.depth)).toBe(1);
        const avatar = page.locator('#avatar_div_div');
        await expect(avatar).toHaveRole('button');
        await expect(avatar).toHaveAccessibleName('Change Persona Image');
        await avatar.focus();
        await expect(avatar).toBeFocused();
        const chooserEvent = page.waitForEvent('filechooser');
        await avatar.press('Enter');
        const chooser = await chooserEvent;
        await chooser.setFiles([]);
        const tags = page.locator('#tagList > .tag');
        const count = await tags.count();
        expect(count).toBeGreaterThan(0);
        const remove = tags.first().getByRole('button', { name: 'Remove', exact: true });
        await expect(remove).toBeVisible();
        const size = await remove.boundingBox();
        const minimum = { 1440: 16, 768: 44, 375: 44 }[viewport.width];
        expect(size.width).toBeGreaterThanOrEqual(minimum);
        expect(size.height).toBeGreaterThanOrEqual(minimum);
        await remove.focus();
        await page.keyboard.press('Enter');
        await expect(tags).toHaveCount(count - 1);
    });

    test(`keyboard chat, pencil and clean Escape restore the origin at ${viewport.width}px`, async ({ page }) => {
        await prepareList(page, viewport);
        for (const { view, prefix } of [
            { view: 'characters', prefix: 'sb_character_editor' },
            { view: 'groups', prefix: 'sb_group_editor' },
        ]) {
            await showView(page, view);
            const row = listRows(page, view).first();
            const key = await row.getAttribute('data-sb-list-key');
            await row.focus();
            await page.keyboard.press('Enter');
            await waitForChatActivation(page);
            await showView(page, view);
            const origin = list(page).locator(`[data-sb-list-key=${JSON.stringify(key)}]`);
            await origin.focus();
            await page.keyboard.press('Tab');
            await expect(origin.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
            await page.keyboard.press('Enter');
            await expect(page.locator(`#${prefix}_header`)).toBeVisible();
            await expect(page.locator(`#${prefix}_save`)).toBeDisabled();
            await page.locator(`#${prefix}_back`).focus();
            await page.keyboard.press('Control+s');
            await page.keyboard.press('Escape');
            await expect(page.locator(`#${prefix}_header`)).toBeHidden();
            await expect(origin).toBeFocused();
            await expect(list(page)).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(page.locator('#sb-settings-page')).toBeHidden();
            await expect(page.locator('#sb-character-toggle')).toBeFocused();
        }
    });

    test(`shared lists activate chats and pencil/Back preserves the origin at ${viewport.width}px`, async ({ page }) => {
        await prepareList(page, viewport);
        const character = listRows(page, 'characters').first();
        const chid = Number(await character.getAttribute('data-chid'));
        await character.locator('.ch_name').click();
        await expect.poll(() => page.evaluate(async () => Number((await import('/script.js')).this_chid))).toBe(chid);
        await expect(page.locator('#sb_character_editor_header')).toBeHidden();
        await waitForChatActivation(page);
        await expectEditorBackRestoration(page, 'characters');

        await showView(page, 'groups');
        const group = listRows(page, 'groups').first();
        const groupId = await group.getAttribute('data-grid');
        await group.locator('.ch_name').click();
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).selected_group)).toBe(groupId);
        await expect(page.locator('#sb_group_editor_header')).toBeHidden();
        await waitForChatActivation(page);
        await expectEditorBackRestoration(page, 'groups');
    });

    test(`favorites, search, sort, page size and grid stay per view at ${viewport.width}px`, async ({ page }) => {
        await prepareList(page, viewport);
        const favorite = () => list(page).locator('.filterByFavorites');
        await favorite().click();
        await expect(favorite()).toHaveClass(/selected/);
        await showView(page, 'groups');
        await expect(favorite()).not.toHaveClass(/selected/);
        await favorite().click();
        await expect(favorite()).toHaveClass(/selected/);
        await showView(page, 'characters');
        await expect(favorite()).toHaveClass(/selected/);
        for (const view of ['characters', 'groups']) {
            await showView(page, view);
            await list(page).locator('.clearAllFilters').evaluate(element => element.click());
        }

        await showView(page, 'characters');
        const characterQuery = await listRows(page, 'characters').first().locator('.ch_name').textContent();
        await setSearch(page, characterQuery);
        await showView(page, 'groups');
        await expect(page.locator('#character_search_bar')).toHaveValue('');
        await setSearch(page, 'qa-list-group-0');
        await showView(page, 'characters');
        await expect(page.locator('#character_search_bar')).toHaveValue(characterQuery);
        await setSearch(page, '');
        const characterSort = await readSort(page, 'characters');
        await showView(page, 'groups');
        await expect(page.locator('#character_search_bar')).toHaveValue('qa-list-group-0');
        await setSearch(page, '');
        await chooseSortItem(page, 'Z-A');
        await expect.poll(() => readSort(page, 'groups')).toMatchObject({ field: 'name', order: 'desc' });
        expect(await readSort(page, 'characters')).toEqual(characterSort);
        expect(await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            return { field: power_user.sort_field, order: power_user.sort_order };
        })).toMatchObject({ field: characterSort.field, order: characterSort.order });
        expect(await page.evaluate(async () => JSON.parse((await import('/scripts/util/AccountStorage.js')).accountStorage.getItem('GroupList_SortOrder')))).toMatchObject({ field: 'name', order: 'desc' });
        await pageSize(page).selectOption('50');
        await showView(page, 'characters');
        await expect(pageSize(page)).toHaveValue('10');
        await pageSize(page).selectOption('25');
        await chooseSortItem(page, 'Newest');
        await expect.poll(() => readSort(page, 'characters')).toMatchObject({ field: 'create_date', order: 'desc' });
        await showView(page, 'groups');
        await expect(pageSize(page)).toHaveValue('50');
        expect(await readSort(page, 'groups')).toMatchObject({ field: 'name', order: 'desc' });
        await showView(page, 'characters');
        await expect(pageSize(page)).toHaveValue('25');
        expect(await page.evaluate(async () => {
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            return [accountStorage.getItem('Characters_PerPage'), accountStorage.getItem('Groups_PerPage')];
        })).toEqual(['25', '50']);

        await chooseSortItem(page, 'Grid');
        await expect(page.locator('body')).toHaveClass(/charListGrid/);
        await expect(list(page).locator('#rm_print_characters_block')).toHaveCSS('display', 'grid');
        await expect(listRows(page, 'characters').first().getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
        await showView(page, 'groups');
        await expect(list(page).locator('#rm_print_characters_block')).toHaveCSS('display', 'grid');
        expect((await listRows(page, 'groups').first().boundingBox()).width).toBeGreaterThan(100);
        await chooseSortItem(page, 'List');
        await expect(page.locator('body')).not.toHaveClass(/charListGrid/);
    });

    test(`row favorite menus, visible extension slot and retired hotswap at ${viewport.width}px`, async ({ page }) => {
        await prepareList(page, viewport);
        for (const view of ['characters', 'groups']) {
            await showView(page, view);
            const row = listRows(page, view).first();
            const key = await row.getAttribute('data-sb-list-key');
            const before = await row.evaluate(element => element.classList.contains('is_fav'));
            await row.getByRole('button', { name: /^Actions for / }).click();
            const favorite = page.getByRole('menuitemcheckbox', { name: 'Favorites', exact: true });
            await expect(favorite).toHaveAttribute('aria-checked', String(before));
            await favorite.click();
            const retained = list(page).locator(`[data-sb-list-key=${JSON.stringify(key)}]`);
            await expect.poll(() => retained.evaluate(element => element.classList.contains('is_fav'))).toBe(!before);
            await expect(page.locator('#rm_buttons_container')).toBeVisible();
            await expect(list(page).locator('.sb-character-list__header #rm_buttons_container')).toBeVisible();
        }
        await list(page).locator('[data-action-id="more"]').click();
        await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
        await expect(list(page)).toHaveAttribute('data-selection-mode', 'true');
        await expect(page.locator('#bulkEditButton')).toBeHidden();
        await listRows(page, 'groups').first().locator('.ch_name').click();
        await expect(list(page).locator('.sb-selection-title')).toHaveText('1 selected');
        await expect(listRows(page, 'groups').first()).toHaveClass(/is-selection-selected/);
        await list(page).getByRole('button', { name: 'Select all', exact: true }).click();
        await expect(list(page).locator('.sb-selection-title')).toHaveText('28 selected');
        await expect(list(page).locator('.sb-selection-action[data-action-id="delete"]')).toBeVisible();
        await list(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(list(page).locator('.is-selection-selected')).toHaveCount(0);
        await expect(list(page).locator('.bulk_select_checkbox')).toHaveCount(0);
        for (const tab of ['characters', 'groups', 'editor', 'world-info', 'persona', 'import']) {
            await page.evaluate(async tab => { await window.SillyBunnyShell.openTab('characters', tab); }, tab);
            await expect(page.locator('#CharListButtonAndHotSwaps')).toBeHidden();
        }
    });
}

async function enterSelection(page) {
    await list(page).locator('.sb-character-list__header [data-action-id="more"]').click();
    await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
    await expect(list(page)).toHaveAttribute('data-selection-mode', 'true');
    await expect(list(page).locator('.sb-selection-cancel')).toBeFocused();
}

for (const width of [1440, 390]) {
    test(`q56 ${width}px Characters selection header retains contrasting header actions`, async ({ page }) => {
        await prepareList(page, { width, height: 1000 });
        await enterSelection(page);
        await expect(list(page).locator('.sb-selection-cancel')).toHaveClass(/sb-editor-action--secondary/);
        await expect(list(page).locator('.sb-selection-select-all')).toHaveClass(/sb-editor-action--primary/);
        await q56Screenshot(page, `selection-characters-${width}`);
    });
}

for (const width of [375, 390, 430, 768]) {
    test(`header controls and Chat Archive fit within the list at ${width}px`, async ({ page }) => {
        await prepareList(page, { width, height: 844 });
        const header = list(page).locator('.sb-character-list__header');
        await expect(header.locator('#sbca_drawer_button')).toBeVisible();
        await expect.poll(() => header.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return [...element.querySelectorAll('button, .menu_button, [role="button"]')]
                .filter(control => control.getClientRects().length && getComputedStyle(control).visibility !== 'hidden')
                .filter(control => {
                    const rect = control.getBoundingClientRect();
                    return rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5;
                })
                .map(control => control.getAttribute('aria-label') || control.title);
        })).toEqual([]);
        await expect(header.locator('[data-action-id="sort"]')).toBeVisible({ visible: width > 390 });
        await header.locator('[data-action-id="more"]').click();
        await expect(page.getByRole('menuitem', { name: 'Sort', exact: true })).toBeVisible({ visible: width <= 390 });
        await page.keyboard.press('Escape');
    });
}

async function chatState(page) {
    return page.evaluate(async () => {
        const app = await import('/script.js');
        const groups = await import('/scripts/group-chats.js');
        return { character: app.this_chid, group: groups.selected_group, chat: app.getCurrentChatId() };
    });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    for (const view of ['characters', 'groups']) {
        test(`${view} activation closes the shell and reopening reveals the current row at ${viewport.width}px`, async ({ page }) => {
            await prepareList(page, viewport);
            await showView(page, view);
            await pageSize(page).selectOption('50');
            const row = listRows(page, view).last();
            const key = await row.getAttribute('data-sb-list-key');
            await row.evaluate(element => { window.__sbActivationRow = element; });
            await row.locator('.ch_name').click();
            await waitForChatActivation(page);
            await list(page).locator('.sb-character-list__box').evaluate(box => { box.scrollTop = 0; });
            await showView(page, view);
            const current = list(page).locator(`[data-sb-list-key=${JSON.stringify(key)}]`);
            await expect(current).toHaveAttribute('aria-current', 'true');
            await expect(current).toHaveClass(/is-selected/);
            await expect(current.locator('.sb-character-list__active-dot')).toBeVisible();
            await expect(current.locator('.sb-character-list__active-dot')).toHaveAttribute('aria-hidden', 'true');
            await expect(current).toBeInViewport();
            expect(await current.evaluate(element => element === window.__sbActivationRow)).toBe(true);
            await expect(current).not.toBeFocused();
            await expect.poll(() => list(page).locator('.sb-character-list__box').evaluate(box => box.scrollTop)).toBeGreaterThan(0);
            for (const gesture of ['Enter', ' ']) {
                await current.focus();
                await page.keyboard.press(gesture);
                await waitForChatActivation(page);
                await showView(page, view);
            }
            await pageSize(page).selectOption('10');
            await page.evaluate(() => window.SillyBunnyShell.closeCharacters());
            await waitForChatActivation(page);
            await showView(page, view);
            await expect(list(page).locator(`[data-sb-list-key=${JSON.stringify(key)}]`)).toBeInViewport();
            await expect.poll(() => page.evaluate(() => window.SillyBunnyCharacterListController.captureState().page)).toBe(3);
            await chooseSortItem(page, 'Grid');
            await expect(list(page).locator('[aria-current="true"]')).toHaveCSS('background-color', await list(page).evaluate(element => {
                const probe = document.createElement('span');
                probe.style.backgroundColor = 'var(--sb-flat-selected-bg)';
                element.append(probe);
                const color = getComputedStyle(probe).backgroundColor;
                probe.remove();
                return color;
            }));
        });

        test(`${view} refusal, failed loading, and pinning keep the list open at ${viewport.width}px`, async ({ page }) => {
            await prepareList(page, viewport);
            await showView(page, view);
            const before = await chatState(page);
            await page.evaluate(async () => (await import('/script.js')).setSendButtonState(true));
            const row = listRows(page, view).last();
            await row.locator('.ch_name').click();
            await expect(page.locator('#sb-settings-page')).toBeVisible();
            expect(await chatState(page)).toEqual(before);
            await expect(row).not.toHaveAttribute('aria-current', 'true');
            await page.evaluate(async () => (await import('/script.js')).setSendButtonState(false));

            const endpoint = { characters: '**/api/chats/get', groups: '**/api/chats/group/get' }[view];
            await page.route(endpoint, route => route.fulfill({ status: 500, json: {} }));
            await row.locator('.ch_name').click();
            await expect.poll(() => page.evaluate(() => document.querySelector('.is-activating-entity') === null)).toBe(true);
            await expect(page.locator('#sb-settings-page')).toBeVisible();
            await expect(row).toBeFocused();
            await page.unroute(endpoint);
            // Restore the original fixture handler removed by unroute, never allow a live chat write.
            await page.route(endpoint, route => route.fulfill({ json: view === 'groups' ? [
                { chat_metadata: { tainted: true } },
                { name: 'QA group', is_user: false, mes: 'QA chat', send_date: '2026-10-18' },
            ] : [] }));
            await page.evaluate(() => { document.getElementById('rm_button_panel_pin').checked = true; });
            const other = listRows(page, view).first();
            await other.locator('.ch_name').click();
            await expect(other).toHaveAttribute('aria-current', 'true');
            await expect(other).not.toHaveClass(/is-activating-entity/);
            await expect(page.locator('#sb-settings-page')).toBeVisible();
            await page.evaluate(() => { document.getElementById('rm_button_panel_pin').checked = false; });
            await other.locator('.ch_name').click();
            await waitForChatActivation(page);
        });

        for (const [shell, tab] of [['left', 'connections'], ['right', 'appearance'], ['characters', 'world-info']]) {
            test(`${view} delayed failure preserves newer ${shell}/${tab} navigation at ${viewport.width}px`, async ({ page }) => {
                await prepareList(page, viewport);
                await showView(page, view);
                let release;
                let requested = false;
                const gate = new Promise(resolve => { release = resolve; });
                const endpoint = { groups: '**/api/chats/group/get', characters: '**/api/chats/get' }[view];
                await page.route(endpoint, async route => {
                    requested = true;
                    await gate;
                    await route.fulfill({ status: 500, json: {} });
                });
                await listRows(page, view).last().locator('.ch_name').click();
                await expect(list(page)).toBeHidden();
                await expect.poll(() => requested).toBe(true);
                await page.evaluate(async ({ shell, tab }) => {
                    await window.SillyBunnyShell.openTab(shell, tab);
                    window.__sbFailureReopens = 0;
                    const openTab = window.SillyBunnyShell.openTab;
                    window.SillyBunnyShell.openTab = (...args) => {
                        window.__sbFailureReopens++;
                        return openTab(...args);
                    };
                }, { shell, tab });
                const selected = page.locator(`#sb-settings-tab-list [data-sb-settings-tab="${tab}"]`);
                await expect(selected).toHaveAttribute('aria-selected', 'true');
                const destinationFocus = page.locator('#sb-settings-page button:visible').first();
                await destinationFocus.focus();
                try {
                    release();
                    await expect(page.locator('.is-activating-entity')).toHaveCount(0);
                    await expect(selected).toHaveAttribute('aria-selected', 'true');
                    await expect(destinationFocus).toBeFocused();
                    await expect(list(page)).toBeHidden();
                    expect(await page.evaluate(() => window.__sbFailureReopens)).toBe(0);
                } finally {
                    release();
                }
            });
        }

        test(`${view} acceptance hides the list before a delayed chat fetch and keeps larger avatars at ${viewport.width}px`, async ({ page }) => {
            await prepareList(page, viewport);
            await showView(page, view);
            const row = listRows(page, view).last();
            const key = await row.getAttribute('data-sb-list-key');
            await expect(row.locator(':scope > .ds-entity-row__avatar')).toHaveCSS('width', '40px');
            await expect(row.locator(':scope > .ds-entity-row__avatar')).toHaveCSS('height', '40px');
            let release;
            let requested = false;
            let completed = false;
            const gate = new Promise(resolve => { release = resolve; });
            const endpoint = { groups: '**/api/chats/group/get', characters: '**/api/chats/get' }[view];
            await page.route(endpoint, async route => {
                requested = true;
                await gate;
                completed = true;
                await route.fulfill({ json: view === 'groups' ? [
                    { chat_metadata: { tainted: true } },
                    { name: 'QA group', is_user: false, mes: 'QA chat', send_date: '2026-10-18' },
                ] : [] });
            });
            await row.evaluate(element => {
                element.addEventListener('click', () => {
                    const start = performance.now();
                    const section = element.closest('.sb-character-list');
                    const observer = new MutationObserver(() => {
                        if (!section.hidden) return;
                        window.__sbAcceptedHideMs = performance.now() - start;
                        observer.disconnect();
                    });
                    observer.observe(section, { attributes: true, attributeFilter: ['hidden'] });
                }, { capture: true, once: true });
            });
            try {
                await row.locator('.ch_name').click();
                await expect(list(page)).toBeHidden();
                await expect.poll(() => requested).toBe(true);
                expect(completed).toBe(false);
                expect(await page.evaluate(() => window.__sbAcceptedHideMs)).toBeLessThan(100);
            } finally {
                release();
            }
            await waitForChatActivation(page);
            await showView(page, view);
            const current = list(page).locator(`[data-sb-list-key=${JSON.stringify(key)}]`);
            await expect(current).toHaveAttribute('aria-current', 'true');
            const dot = current.locator('.sb-character-list__active-dot');
            await expect(dot).toBeVisible();
            await expect(dot).toHaveCSS('width', '8px');
            await expect(dot).toHaveCSS('height', '8px');
            await chooseSortItem(page, 'Grid');
            await expect(dot).toHaveCSS('position', 'absolute');
            await expect(current.locator(':scope > .ds-entity-row__avatar')).toHaveCSS('width', viewport.width === 390 ? '88px' : '116px');
            for (const theme of ['Libadwaita', 'Libadwaita Light']) {
                await page.evaluate(theme => window.$('#themes').val(theme).trigger('change'), theme);
                await expect(dot).toBeVisible();
                const accent = await dot.evaluate(element => {
                    const probe = document.createElement('span');
                    probe.style.backgroundColor = 'var(--sb-accent)';
                    element.append(probe);
                    const color = getComputedStyle(probe).backgroundColor;
                    probe.remove();
                    return color;
                });
                await expect(dot).toHaveCSS('background-color', accent);
            }
            await page.emulateMedia({ forcedColors: 'active' });
            await expect(dot).toBeVisible();
            await expect(dot).toHaveCSS('forced-color-adjust', 'none');
            await expect(dot).toHaveCSS('outline-width', '1px');
        });
    }

    test(`tag filter menu cycles states and filters both list views at ${viewport.width}px`, async ({ page }) => {
        await prepareList(page, viewport);
        await pageSize(page).selectOption('50');
        const characterTotal = await listRows(page, 'characters').count();
        const { button, picker, search } = await openTagPicker(page);
        await expect(search).toBeFocused();
        const labels = await page.evaluate(() => [...document.querySelectorAll('.sb-character-list .rm_tag_filter .tag:not(.actionable) .tag_name')].map(tag => tag.textContent));
        await expect(picker.locator('.sb-picker__label')).toHaveText(labels);
        await expect(picker).toHaveClass(viewport.width === 390 ? /sb-picker-sheet/ : /sb-picker/);
        await expect(picker.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
        await search.fill('alpha');
        await expect(picker.getByRole('option')).toHaveCount(1);
        const option = picker.getByRole('option', { name: /^QA list alpha/ });
        await expect(option).toBeVisible();
        await option.click();
        await expect(option).toHaveAttribute('aria-selected', 'true');
        await expect(picker.locator('.fa-check')).toBeVisible();
        await expect(search).toBeFocused();
        await expect(button.locator('.sb-tag-filter-menu-count')).toHaveText('1');
        await expect(listRows(page, 'characters')).toHaveCount(2);

        await option.click();
        await expect(option).toHaveAttribute('aria-selected', 'false');
        await expect(option.locator('.fa-minus')).toBeVisible();
        await expect(search).toBeFocused();
        await expect(listRows(page, 'characters')).toHaveCount(characterTotal - 2);

        await option.click();
        await expect(option.locator('.fa-minus')).toHaveCount(0);
        await expect(button.locator('.sb-tag-filter-menu-count')).toBeHidden();
        await expect(listRows(page, 'characters')).toHaveCount(characterTotal);
        await page.keyboard.press('Escape');
        await expect(picker).toBeHidden();
        await expect(button).toBeFocused();

        await showView(page, 'groups');
        const groups = listRows(page, 'groups');
        const groupPicker = await openTagPicker(page);
        await groupPicker.search.fill('alpha');
        await expect(groupPicker.picker.getByRole('option')).toHaveCount(1);
        const groupOption = groupPicker.picker.getByRole('option', { name: /^QA list alpha/ });
        await groupOption.click();
        await expect(groupOption).toHaveAttribute('aria-selected', 'true');
        await expect(groups).toHaveCount(1);
        await expect(groupPicker.search).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(groupPicker.button).toBeFocused();
    });

    test(`selection gestures, ranges and all filtered pages preserve the chat at ${viewport.width}px`, async ({ page }) => {
        await prepareList(page, viewport);
        const before = await chatState(page);
        const total = await page.evaluate(async () => (await import('/script.js')).characters.length);
        await page.evaluate(async () => {
            const { eventSource, event_types } = await import('/scripts/events.js');
            window.__sbSelectionEvents = [];
            eventSource.on(event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_BEFORE, state => { window.__sbSelectionEvents.push(['before', state]); });
            eventSource.on(event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER, state => { window.__sbSelectionEvents.push(['after', state]); });
        });
        await enterSelection(page);
        await expect(list(page).locator('.sb-character-list__header')).toBeHidden();
        await expect(list(page).locator('.sb-character-list__filters')).toBeHidden();
        await listRows(page, 'characters').first().locator('.ch_name').click();
        await expect(list(page).locator('.sb-selection-title')).toHaveText('1 selected');
        await expect(listRows(page, 'characters').first().getByRole('button', { name: 'Edit', exact: true })).toBeHidden();
        await listRows(page, 'characters').nth(3).locator('.ch_name').click({ modifiers: ['Shift'] });
        await expect(list(page).locator('.sb-selection-title')).toHaveText('4 selected');
        const visibleCharacterCount = await listRows(page, 'characters').count();
        const focusedRow = listRows(page, 'characters').first();
        await focusedRow.focus();
        for (const key of ['x', 'Control+f', 'Meta+f']) {
            await page.keyboard.press(key);
            await expect(focusedRow).toBeFocused();
            await expect(page.locator('#character_search_bar')).toHaveValue('');
            await expect(page.locator('#character_search_bar')).toBeHidden();
            // Saved folder headers consume page slots without representing selectable characters.
            await expect(listRows(page, 'characters')).toHaveCount(visibleCharacterCount);
        }
        expect(await chatState(page)).toEqual(before);
        await list(page).getByRole('button', { name: 'Select all', exact: true }).click();
        await expect(list(page).locator('.sb-selection-title')).toHaveText(`${total} selected`);
        await list(page).getByRole('button', { name: 'Next page', exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.SillyBunnyCharacterListController.captureState().page)).toBe(2);
        await expect(listRows(page, 'characters').first().locator('.sb-selection-check')).toBeChecked();
        await expect(list(page).locator('.sb-selection-title')).toHaveText(`${total} selected`);
        await page.keyboard.press('Escape');
        await expect(list(page)).toHaveAttribute('data-selection-mode', 'false');
        await expect(list(page).locator('.sb-character-list__header [data-action-id="more"]')).toBeFocused();
        await expect.poll(() => page.evaluate(() => window.__sbSelectionEvents)).toEqual([['before', 1], ['after', 1], ['before', 0], ['after', 0]]);
        const row = listRows(page, 'characters').first();
        await row.locator('.ch_name').click({ button: 'right' });
        await expect(list(page)).toHaveAttribute('data-selection-mode', 'true');
        await expect(list(page).locator('.sb-selection-title')).toHaveText('1 selected');
        await page.keyboard.press('Escape');
        await expect(row).toBeFocused();
        await chooseSortItem(page, 'Grid');
        await enterSelection(page);
        const check = listRows(page, 'characters').first().locator('.sb-selection-check');
        await expect(check).toHaveCSS('position', 'absolute');
        await check.click();
        await expect(check).toBeChecked();
        expect(await chatState(page)).toEqual(before);
        await showView(page, 'groups');
        await expect(list(page)).toHaveAttribute('data-selection-mode', 'false');
    });

    test(`bulk Favorite uses upstream requests and Delete keeps its confirmation at ${viewport.width}px`, async ({ page }) => {
        await prepareList(page, viewport);
        const favorites = [];
        await page.route('**/api/characters/merge-attributes', route => {
            favorites.push(route.request().postDataJSON());
            return route.fulfill({ json: {} });
        });
        const avatars = await listRows(page, 'characters').evaluateAll(rows => rows.slice(0, 2).map(row => row.dataset.chid));
        const expected = await page.evaluate(async ids => {
            const { characters } = await import('/script.js');
            return ids.map(id => characters[Number(id)].avatar);
        }, avatars);
        await enterSelection(page);
        await listRows(page, 'characters').nth(0).locator('.ch_name').click();
        await listRows(page, 'characters').nth(1).locator('.ch_name').click();
        await list(page).locator('.sb-selection-action[data-action-id="favorite"]').click();
        await expect.poll(() => favorites.length).toBe(2);
        expect(favorites.map(payload => payload.avatar).sort()).toEqual(expected.sort());
        await expect(list(page)).toHaveAttribute('data-selection-mode', 'false');
        await enterSelection(page);
        await listRows(page, 'characters').first().locator('.ch_name').click();
        await list(page).locator('.sb-selection-action[data-action-id="delete"]').click();
        const dialog = page.locator('dialog.popup[open]').last();
        await expect(dialog).toContainText('Delete 1 characters?');
        await expect(dialog.locator('#del_char_checkbox')).toBeVisible();
        await dialog.getByRole('button', { name: 'No', exact: true }).click();
        await expect(list(page)).toHaveAttribute('data-selection-mode', 'false');
    });

    test(`group Tag and Delete reuse upstream popups; tab switches exit selection at ${viewport.width}px`, async ({ page }) => {
        await prepareList(page, viewport);
        await showView(page, 'groups');
        await enterSelection(page);
        await expect(list(page).locator('.sb-selection-action')).toHaveCount(3);
        await listRows(page, 'groups').first().locator('.ch_name').click();
        await list(page).locator('.sb-selection-action[data-action-id="tag"]').click();
        await expect(page.locator('#bulk_tag_popup')).toContainText('Modify tags of 1 groups');
        await page.locator('#bulk_tag_popup_cancel').click();
        await expect(page.locator('#bulk_tag_popup')).toHaveCount(0);
        await expect(list(page)).toHaveAttribute('data-selection-mode', 'false');
        await enterSelection(page);
        await listRows(page, 'groups').first().locator('.ch_name').click();
        await list(page).locator('.sb-selection-action[data-action-id="delete"]').click();
        const dialog = page.locator('dialog.popup[open]').last();
        await expect(dialog).toContainText('Delete 1 groups?');
        await dialog.getByRole('button', { name: 'No', exact: true }).click();
        await expect(list(page)).toHaveAttribute('data-selection-mode', 'false');
        await enterSelection(page);
        await showView(page, 'characters');
        await expect(list(page)).toHaveAttribute('data-selection-mode', 'false');
        expect(await page.evaluate(async () => (await import('/script.js')).characterGroupOverlay.legacyRowSelectionEnabled)).toBe(false);
    });
}

test.describe('touch selection', () => {
    test.use({ hasTouch: true });
    test('a 500ms touch hold enters selection and swallows the release click at 390px', async ({ page }) => {
        await prepareList(page, { width: 390, height: 844 });
        const before = await chatState(page);
        const row = listRows(page, 'characters').first();
        const bounds = await row.locator('.ch_name').boundingBox();
        const session = await page.context().newCDPSession(page);
        try {
            await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + 8, y: bounds.y + 8 }] });
            await expect(list(page)).toHaveAttribute('data-selection-mode', 'true');
            await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await expect(list(page).locator('.sb-selection-title')).toHaveText('1 selected');
            expect(await chatState(page)).toEqual(before);
            await page.keyboard.press('Escape');
            await expect(row).toBeFocused();
        } finally {
            await session.detach();
        }
    });
});
