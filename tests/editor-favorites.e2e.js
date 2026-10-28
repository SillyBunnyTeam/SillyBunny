import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

const CARD = 'qa-favorite-card.png';
const GROUP = 'qa-favorite-group';
const GROUP_NAME = 'QA Favorite Group';

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(60000);

function requestJson(request) {
    const body = request.postDataBuffer();
    return JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString());
}

function makeCharacter(avatar, name) {
    const data = {
        name, description: '', personality: '', scenario: '', first_mes: 'QA greeting', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
        tags: [], creator: '', character_version: '', extensions: { fav: false, talkativeness: 0.5 },
    };
    return {
        ...data, avatar, chat: '', fav: false, create_date: '2026-10-19', date_added: 1,
        spec: 'chara_card_v2', spec_version: '2.0', data,
    };
}

/** Serves cards and one group from memory. Every write is recorded and, as on a server, changes what the next read returns. */
async function bootFixtures(page) {
    await protectMaintainerServer(page);
    const characters = [
        makeCharacter(CARD, 'QA Favorite Card'),
        makeCharacter('qa-other-card.png', 'QA Other Card'),
        // Startup creates a missing bundled assistant, which would send a create or import request.
        makeCharacter('default_SillyBunnyGuide.png', 'QA Guide'),
        makeCharacter('default_AssistantNahida.png', 'QA Nahida'),
    ];
    const groups = [{
        id: GROUP, name: GROUP_NAME, members: characters.slice(0, 2).map(character => character.avatar),
        disabled_members: [], member_models: {}, avatar_url: '', chat_id: 'qa-favorite-group-chat',
        chats: ['qa-favorite-group-chat'], activation_strategy: 0, generation_mode: 0,
        allow_self_responses: false, hideMutedSprites: false, fav: false,
    }];
    const writes = { favorites: [], cardEdits: [], groupEdits: [], created: [] };

    await page.route('**/api/settings/get', async route => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        data.settings = JSON.stringify({ ...JSON.parse(data.settings), firstRun: false });
        return route.fulfill({ json: data });
    });
    await page.route('**/api/characters/all', route => route.fulfill({ json: characters }));
    await page.route('**/api/characters/get', route => {
        const payload = requestJson(route.request());
        return route.fulfill({ json: characters.find(character => character.avatar === payload.avatar_url) ?? {} });
    });
    await page.route('**/api/characters/chats', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/get', route => route.fulfill({ json: [] }));
    await page.route('**/api/groups/all', route => route.fulfill({ json: groups }));
    await page.route('**/api/chats/group/info', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/group/get', route => route.fulfill({ json: [] }));
    await page.route('**/api/characters/merge-attributes', route => {
        const payload = requestJson(route.request());
        writes.favorites.push(payload);
        const character = characters.find(item => item.avatar === payload.avatar);
        character.fav = payload.fav;
        character.data.extensions.fav = payload.data.extensions.fav;
        return route.fulfill({ json: {} });
    });
    await page.route('**/api/characters/edit*', route => {
        writes.cardEdits.push(route.request().url());
        return route.fulfill({ body: 'ok' });
    });
    await page.route('**/api/characters/create*', route => {
        writes.created.push(route.request().postDataBuffer().toString());
        characters.push(makeCharacter('qa-created-card.png', 'QA Created Card'));
        return route.fulfill({ body: 'qa-created-card.png' });
    });
    await page.route('**/api/groups/edit', route => {
        const payload = requestJson(route.request());
        writes.groupEdits.push(payload);
        groups.splice(groups.findIndex(group => group.id === payload.id), 1, payload);
        return route.fulfill({ json: { ok: true } });
    });
    return writes;
}

async function showList(page, view) {
    await page.evaluate(view => window.SillyBunnyShell.openTab('characters', view), view);
    await expect(page.locator('.sb-character-list[data-mounted="true"]')).toHaveAttribute('data-view', view);
}

async function bootList(page, view) {
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await showToasts(page);
    await showList(page, view);
}

/** Opens the card from the list and resolves once the editor has loaded it, also when the same card is already loaded. */
async function openCardEditor(page) {
    await showList(page, 'characters');
    const opened = page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window.SillyTavern.getContext();
        eventSource.once(eventTypes.CHARACTER_EDITOR_OPENED, resolve);
    }));
    await page.locator(`.sb-character-list [data-sb-list-key="character:${CARD}"] [aria-label="Edit"]`).click();
    await opened;
}

/** The editor judges dirtiness on a trailing debounce, so a clean state only means something once that debounce has run. */
async function settle(page) {
    await page.evaluate(async () => {
        const { DIRTY_DEBOUNCE_MS } = await import('/scripts/sillybunny-editor/session.js');
        await new Promise(resolve => setTimeout(resolve, DIRTY_DEBOUNCE_MS + 100));
    });
}

test('a saved card\'s star saves at once, so closing the panel without Save keeps it', async ({ page }) => {
    const writes = await bootFixtures(page);
    await bootList(page, 'characters');
    await openCardEditor(page);
    const star = page.locator('#favorite_button');
    await expect(star).toHaveClass(/fav_off/);

    await star.click();
    await expect(star).toHaveClass(/fav_on/);
    await settle(page);
    expect(writes.favorites).toHaveLength(1);
    expect(writes.favorites[0]).toMatchObject({ avatar: CARD, fav: true, data: { extensions: { fav: true } } });
    await expect(page.locator('#sb_character_editor_save')).toBeDisabled();

    await page.locator('#sb-settings-close').click();
    await expect(page.locator('#sb-settings-page')).toBeHidden();
    await openCardEditor(page);
    await expect(star).toHaveClass(/fav_on/);
    await expect(page.locator('#sb_draft_restore_btn')).toHaveCount(0);

    await star.click();
    await expect(star).toHaveClass(/fav_off/);
    await settle(page);
    expect(writes.favorites.map(payload => payload.fav)).toEqual([true, false]);
    expect(writes.favorites[1]).toMatchObject({ avatar: CARD, data: { extensions: { fav: false } } });
    await expect(page.locator('#sb_character_editor_save')).toBeDisabled();
    expect(writes.cardEdits).toEqual([]);
});

test('a new card\'s star stays an unsaved choice until the card is created', async ({ page }) => {
    const writes = await bootFixtures(page);
    await bootList(page, 'characters');
    await page.locator('.sb-character-list [data-action-id="new"]').click();
    await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'create');
    const star = page.locator('#favorite_button');
    const dirty = page.locator('#sb_character_editor_dirty');
    await expect(star).toHaveClass(/fav_off/);
    await expect(dirty).toBeHidden();

    await star.click();
    await expect(star).toHaveClass(/fav_on/);
    await expect(dirty).toBeVisible();
    await settle(page);
    expect(writes.favorites).toEqual([]);

    await page.locator('#character_name_pole').fill('QA Created Card');
    await page.locator('#sb_character_editor_save').click();
    await expect(page.locator('.sb-character-list [data-sb-list-key="character:qa-created-card.png"]')).toBeVisible();
    expect(writes.created).toHaveLength(1);
    expect(writes.created[0]).toMatch(/name="fav"\r\n\r\ntrue\r\n/);
    expect(writes.favorites).toEqual([]);
});

test('restoring a stored draft on a saved card does not replay its favorite', async ({ page }) => {
    const writes = await bootFixtures(page);
    await bootList(page, 'characters');
    // A stored draft keeps the star it was written with, which can disagree with the saved card's favorite.
    await page.evaluate(async avatar => {
        const { getCurrentUserHandle } = await import('/scripts/user.js');
        localStorage.setItem(`sb-editor-draft-${getCurrentUserHandle() || 'default'}-${avatar}`, JSON.stringify({
            v: 1, ts: Date.now(), snapshot: { description_textarea: 'Draft description', _fav: true },
        }));
    }, CARD);
    await openCardEditor(page);
    await page.locator('#sb_draft_restore_btn').click();
    await expect(page.locator('#description_textarea')).toHaveValue('Draft description');
    await settle(page);
    await expect(page.locator('#favorite_button')).toHaveClass(/fav_off/);
    expect(writes.favorites).toEqual([]);
});

test('a saved group\'s star saves at once and leaves the group editor clean', async ({ page }) => {
    const writes = await bootFixtures(page);
    await bootList(page, 'groups');
    await page.locator(`.sb-character-list [data-sb-list-key="group:${GROUP}"] [aria-label="Edit"]`).click();
    await expect(page.locator('#sb_group_editor_header')).toBeVisible();
    const star = page.locator('#group_favorite_button');
    const save = page.locator('#sb_group_editor_save');
    await expect(star).toHaveClass(/fav_off/);

    await star.click();
    await expect(star).toHaveClass(/fav_on/);
    await settle(page);
    const favorited = writes.groupEdits.filter(group => group.fav);
    expect(favorited).toHaveLength(1);
    expect(favorited[0]).toMatchObject({ id: GROUP });
    await expect(save).toBeDisabled();

    // The star click never re-checks dirtiness, so a stale baseline only shows once another edit does.
    const name = page.locator('#rm_group_chat_name');
    await name.fill(`${GROUP_NAME} renamed`);
    await expect(save).toBeEnabled();
    await name.fill(GROUP_NAME);
    await expect(save).toBeDisabled();
});

test('restoring a stored draft on a saved group does not replay its favorite', async ({ page }) => {
    const writes = await bootFixtures(page);
    await bootList(page, 'groups');
    // A stored draft keeps the star it was written with, which can disagree with the saved group's favorite.
    await page.evaluate(async ({ id, name }) => {
        const { getCurrentUserHandle } = await import('/scripts/user.js');
        localStorage.setItem(`sb-group-editor-draft-${getCurrentUserHandle() || 'default'}-${id}`, JSON.stringify({
            v: 1, ts: Date.now(), snapshot: { name, fav: true },
        }));
    }, { id: GROUP, name: `${GROUP_NAME} draft` });
    await page.locator(`.sb-character-list [data-sb-list-key="group:${GROUP}"] [aria-label="Edit"]`).click();
    await page.locator('#sb_draft_restore_btn').click();
    await expect(page.locator('#rm_group_chat_name')).toHaveValue(`${GROUP_NAME} draft`);
    await settle(page);
    await expect(page.locator('#group_favorite_button')).toHaveClass(/fav_off/);
    expect(writes.groupEdits.filter(group => group.fav)).toEqual([]);
});
