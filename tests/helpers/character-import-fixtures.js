import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { protectMaintainerServer } from './maintainer-server.js';

export const BOOK = 'qa-import-book';
const AVATAR = readFileSync(new URL('../../public/img/ai4.png', import.meta.url));
const lorebook = { entries: { 0: {
    uid: 0, comment: 'QA import entry', key: ['qa'], keysecondary: [], content: 'QA imported lore',
    constant: false, vectorized: false, selective: true, order: 100, position: 0, disable: false, displayIndex: 0,
} } };

function card(name, avatar) {
    const data = {
        name, description: '', personality: '', scenario: '', first_mes: 'QA greeting', mes_example: '',
        creator_notes: '', creator: '', character_version: '', alternate_greetings: [], group_only_greetings: [],
        tags: [], extensions: { fav: false, talkativeness: 0.5 },
    };
    return { ...data, avatar, data, shallow: false, chat: `qa-${avatar}`, create_date: 1, json_data: JSON.stringify({ data }) };
}

function payload(request) {
    const bytes = request.postDataBuffer();
    return JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString());
}

/** All cards, books, groups and imported files exist in browser/request memory only. */
export async function protectImportFixtures(page) {
    await protectMaintainerServer(page);
    const characters = [card('QA existing', 'qa-existing.png'), card('Assistant Nahida', 'default_AssistantNahida.png')];
    const books = [];
    const imports = [];
    await page.route('**/thumbnail?*', route => {
        const name = new URL(route.request().url()).searchParams.get('file');
        if (name === 'qa-missing.png') return route.fulfill({ status: 404 });
        if (name?.startsWith('qa-')) return route.fulfill({ contentType: 'image/png', body: AVATAR });
        return route.continue();
    });
    await page.route('**/api/avatars/get', route => route.fulfill({ json: ['qa-import-persona.png'] }));
    await page.route('**/api/characters/**', route => {
        const endpoint = new URL(route.request().url()).pathname.split('/').pop();
        if (endpoint === 'all') return route.fulfill({ json: characters });
        if (endpoint === 'get') return route.fulfill({ json: characters.find(character => character.avatar === payload(route.request()).avatar_url) ?? characters[0] });
        if (endpoint === 'chats') return route.fulfill({ json: {} });
        if (endpoint === 'import') {
            const fileName = route.request().postDataBuffer().toString().match(/filename="([^"]+)"/)?.[1];
            imports.push(fileName);
            if (fileName === 'bad.json') return route.fulfill({ status: 400, json: { error: 'QA server rejected this card' } });
            const id = fileName.replace(/\.[^.]+$/, '');
            if (!characters.some(character => character.avatar === `${id}.png`)) characters.push(card(`QA ${id}`, `${id}.png`));
            return route.fulfill({ json: { file_name: id } });
        }
        // Every write is fulfilled in memory; no route in this family can reach the maintainer server.
        return route.fulfill({ json: {} });
    });
    await page.route('**/api/groups/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/all') ? [] : {} }));
    await page.route('**/api/worldinfo/**', route => {
        const endpoint = new URL(route.request().url()).pathname.split('/').pop();
        if (endpoint === 'import') {
            books.push(BOOK);
            return route.fulfill({ json: { name: BOOK } });
        }
        return route.fulfill({ json: lorebook });
    });
    await page.route('**/api/content/import*', route => route.fulfill({
        body: JSON.stringify(lorebook),
        headers: { 'Content-Type': 'application/json', 'X-Custom-Content-Type': 'lorebook', 'Content-Disposition': `attachment; filename="${BOOK}.json"` },
    }));
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const settings = await response.json();
        return route.fulfill({ json: { ...settings, world_names: [...books] } });
    });
    await page.route('**/api/chats/get', route => route.fulfill({ json: [] }));
    await page.route('**/api/chats/group/get', route => route.fulfill({ json: [] }));
    return { imports };
}

export async function bootImport(page) {
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.evaluate(async () => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.tag_import_setting = 0;
    });
    await page.locator('#sb-character-toggle').click();
    await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'import'));
    await expect(page.locator('#sb_character_import_panel')).toHaveAttribute('data-mounted', 'true');
    await expect(page.locator('#sb_character_import_content')).toBeVisible();
    await page.mouse.move(0, 0);
}

export const upload = (name = 'qa-imported.json') => ({ name, mimeType: 'application/json', buffer: Buffer.from('{}') });

export async function currentAvatar(page) {
    return page.evaluate(async () => {
        const app = await import('/script.js');
        return app.characters[app.this_chid]?.avatar ?? null;
    });
}
