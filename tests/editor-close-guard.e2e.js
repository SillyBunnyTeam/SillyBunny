import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

const CARD = 'qa-close-guard-card.png';
const GROUP = 'qa-close-guard-group';
const GROUP_NAME = 'QA Close Guard Group';
const BOOK = 'QA Close Guard Book';
const SAVED = 'Saved description';
const EDITED = 'Edited description';

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(60000);

function requestJson(request) {
    const body = request.postDataBuffer();
    return JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString());
}

function makeCharacter(avatar, name, description = '') {
    const data = {
        name, description, personality: '', scenario: '', first_mes: 'QA greeting', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
        tags: [], creator: '', character_version: '', extensions: { fav: false, talkativeness: 0.5 },
    };
    return {
        ...data, avatar, chat: '', fav: false, create_date: '2026-10-19', date_added: 1,
        spec: 'chara_card_v2', spec_version: '2.0', data,
    };
}

function makeEntry(uid, comment) {
    return {
        uid, comment, key: [comment.toLowerCase()], keysecondary: [], content: `${comment} content`,
        constant: false, vectorized: false, selective: true, order: 100, position: 0, disable: false, displayIndex: uid,
    };
}

/** Serves a card, a group and a lorebook from memory and records the writes the editors could send. */
async function bootFixtures(page) {
    await protectMaintainerServer(page);
    const characters = [
        makeCharacter(CARD, 'QA Close Guard Card', SAVED),
        makeCharacter('qa-other-card.png', 'QA Other Card'),
        // Startup creates a missing bundled assistant, which would send a create or import request.
        makeCharacter('default_SillyBunnyGuide.png', 'QA Guide'),
        makeCharacter('default_AssistantNahida.png', 'QA Nahida'),
    ];
    const groups = [{
        id: GROUP, name: GROUP_NAME, members: characters.slice(0, 2).map(character => character.avatar),
        disabled_members: [], member_models: {}, avatar_url: '', chat_id: 'qa-close-guard-group-chat',
        chats: ['qa-close-guard-group-chat'], activation_strategy: 0, generation_mode: 0,
        allow_self_responses: false, hideMutedSprites: false, fav: false,
    }];
    const book = { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') } };
    const writes = { cardEdits: [], groupEdits: [], worldInfoEdits: [], settings: [] };

    await page.route('**/api/settings/get', async route => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        data.settings = JSON.stringify({ ...JSON.parse(data.settings), firstRun: false });
        return route.fulfill({ json: { ...data, world_names: [BOOK] } });
    });
    await page.route('**/api/settings/save', route => {
        const payload = requestJson(route.request());
        writes.settings.push(payload);
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
    // The app saves the Quick Reply sets during startup.
    await page.route('**/api/quick-replies/save', route => route.fulfill({ body: 'ok' }));
    await page.route('**/api/characters/all', route => route.fulfill({ json: characters }));
    await page.route('**/api/characters/get', route => {
        const payload = requestJson(route.request());
        return route.fulfill({ json: characters.find(character => character.avatar === payload.avatar_url) ?? {} });
    });
    await page.route('**/api/characters/chats', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/get', route => route.fulfill({ json: [] }));
    await page.route('**/api/characters/edit*', route => {
        const description = route.request().postDataBuffer().toString().match(/name="description"\r\n\r\n([\s\S]*?)\r\n--/)?.[1];
        writes.cardEdits.push({ description });
        const card = characters.find(character => character.avatar === CARD);
        card.description = card.data.description = description;
        return route.fulfill({ body: 'ok' });
    });
    await page.route('**/api/groups/all', route => route.fulfill({ json: groups }));
    await page.route('**/api/chats/group/info', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/group/get', route => route.fulfill({ json: [] }));
    await page.route('**/api/groups/edit', route => {
        writes.groupEdits.push(requestJson(route.request()));
        return route.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/worldinfo/**', route => {
        const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
        if (endpoint === 'get') {
            const known = requestJson(route.request()).name === BOOK;
            return route.fulfill({ status: known ? 200 : 404, json: known ? book : {} });
        }
        if (endpoint === 'list') return route.fulfill({ json: [{ name: BOOK, ...book }] });
        if (endpoint === 'edit') {
            writes.worldInfoEdits.push(requestJson(route.request()));
            return route.fulfill({ json: { ok: true, name: BOOK } });
        }
        return route.abort();
    });
    return writes;
}

async function bootApp(page) {
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
}

async function showList(page, view) {
    await page.evaluate(view => window.SillyBunnyShell.openTab('characters', view), view);
    await expect(page.locator('.sb-character-list[data-mounted="true"]')).toHaveAttribute('data-view', view);
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

async function openGroupEditor(page) {
    await showList(page, 'groups');
    await page.locator(`.sb-character-list [data-sb-list-key="group:${GROUP}"] [aria-label="Edit"]`).click();
    await expect(page.locator('#sb_group_editor_header')).toBeVisible();
}

async function openPersonaEditor(page) {
    await page.evaluate(async () => {
        const { user_avatar: avatarId } = await import('/scripts/personas.js');
        const { openPersonaEditor } = await import('/scripts/sillybunny-persona-editor.js');
        if (!await openPersonaEditor({ avatarId })) throw new Error('The running instance needs a current persona');
    });
    const entry = page.locator('#PersonaManagement .sb-persona-editor .sb-persona-entry');
    await expect(entry).toBeVisible();
    return entry;
}

async function openBookEntry(page) {
    await page.evaluate(async name => {
        const { openWorldInfoEditor } = await import('/scripts/world-info.js');
        openWorldInfoEditor(name);
    }, BOOK);
    const editor = page.locator('#WorldInfo .sb-wi-editor');
    await expect(editor.locator('.sb-wi-row')).toHaveCount(2);
    await editor.locator('.sb-wi-row', { hasText: 'Alpha' }).click();
    return editor.locator('.sb-wi-entry-textarea');
}

/** The editor judges dirtiness on a trailing debounce, so a clean state only means something once that debounce has run. */
async function settle(page) {
    await page.evaluate(async () => {
        const { DIRTY_DEBOUNCE_MS } = await import('/scripts/sillybunny-editor/session.js');
        await new Promise(resolve => setTimeout(resolve, DIRTY_DEBOUNCE_MS + 100));
    });
}

async function closeWithEdits(page, choice) {
    await page.locator('#sb-settings-close').click();
    const dialog = page.locator('dialog.popup[open]:not([closing])', { hasText: 'Unsaved changes' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('#sb-settings-page')).toBeVisible();
    await dialog.getByRole('button', { name: choice, exact: true }).click();
    // The guard blocks a close click made while the previous dialog is still closing, and opens no new dialog.
    await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
}

test('closing Settings over an unsaved card edit asks first, Cancel keeps the edit and Discard keeps the saved card', async ({ page }) => {
    const writes = await bootFixtures(page);
    await bootApp(page);
    await openCardEditor(page);
    const description = page.locator('#description_textarea');
    const dirty = page.locator('#sb_character_editor_dirty');
    await description.fill(EDITED);
    await expect(dirty).toBeVisible();

    await closeWithEdits(page, 'Cancel');
    await expect(page.locator('#sb-settings-page')).toBeVisible();
    await expect(description).toHaveValue(EDITED);
    await expect(dirty).toBeVisible();

    await closeWithEdits(page, 'Discard');
    await expect(page.locator('#sb-settings-page')).toBeHidden();
    expect(writes.cardEdits).toEqual([]);
    await openCardEditor(page);
    await expect(description).toHaveValue(SAVED);
});

test('Save in the close dialog saves the card once and then closes Settings', async ({ page }) => {
    const writes = await bootFixtures(page);
    await bootApp(page);
    await openCardEditor(page);
    await page.locator('#description_textarea').fill(EDITED);

    await closeWithEdits(page, 'Save');
    await expect(page.locator('#sb-settings-page')).toBeHidden();
    expect(writes.cardEdits).toEqual([{ description: EDITED }]);
});

test('a clean card editor closes Settings without asking', async ({ page }) => {
    await bootFixtures(page);
    await bootApp(page);
    await openCardEditor(page);
    await settle(page);
    await expect(page.locator('#sb_character_editor_save')).toBeDisabled();

    await page.locator('#sb-settings-close').click();
    await expect(page.locator('#sb-settings-page')).toBeHidden();
    await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
});

test('closing Settings over an unsaved group edit asks first and Discard sends no group edit', async ({ page }) => {
    const writes = await bootFixtures(page);
    await bootApp(page);
    await openGroupEditor(page);
    await page.locator('#rm_group_chat_name').fill(`${GROUP_NAME} renamed`);

    await closeWithEdits(page, 'Discard');
    await expect(page.locator('#sb-settings-page')).toBeHidden();
    expect(writes.groupEdits.map(group => group.name)).not.toContain(`${GROUP_NAME} renamed`);
});

test('closing Settings over an unsaved persona edit asks first and Discard saves no settings with it', async ({ page }) => {
    const writes = await bootFixtures(page);
    await bootApp(page);
    const entry = await openPersonaEditor(page);
    await entry.getByRole('textbox', { name: 'Persona Description', exact: true }).fill(EDITED);

    await closeWithEdits(page, 'Discard');
    await expect(page.locator('#sb-settings-page')).toBeHidden();
    const descriptions = writes.settings.flatMap(payload => Object.values(payload.power_user?.persona_descriptions ?? {}));
    expect(descriptions.map(descriptor => descriptor.description)).not.toContain(EDITED);
});

test('closing Settings over an unsaved World Info entry asks first and Discard saves no entry', async ({ page }) => {
    const writes = await bootFixtures(page);
    await bootApp(page);
    const content = await openBookEntry(page);
    await content.fill(EDITED);

    await closeWithEdits(page, 'Discard');
    await expect(page.locator('#sb-settings-page')).toBeHidden();
    const saved = writes.worldInfoEdits.flatMap(payload => Object.values(payload.data.entries));
    expect(saved.map(entry => entry.content)).not.toContain(EDITED);
});

test('closing Settings over an unsaved card edit asks first at 390px and Discard sends no card edit', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const writes = await bootFixtures(page);
    await bootApp(page);
    await openCardEditor(page);
    await page.locator('#description_textarea').fill(EDITED);

    await closeWithEdits(page, 'Discard');
    await expect(page.locator('#sb-settings-page')).toBeHidden();
    expect(writes.cardEdits).toEqual([]);
});
