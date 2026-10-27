import { gunzipSync } from 'node:zlib';
import { protectMaintainerServer } from './maintainer-server.js';
import { fetchJsonOrSkip } from './route-fetch.js';

export const PL_VIEWPORTS = [
    { width: 1440, height: 900, presentation: 'floating' },
    { width: 390, height: 844, presentation: 'sheet' },
];

export function payload(request) {
    const body = request.postDataBuffer();
    return body ? JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString()) : {};
}

export async function bootPresetLorebookDialogs(page, viewport) {
    await protectMaintainerServer(page);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const state = { settings: [], presets: [], deleted: [], worlds: [], characterWrites: [], chatWrites: [] };
    const entry = (comment, index) => ({ id: index * 4, comment, content: comment, keys: [comment], insertion_order: 100, enabled: true });
    const characters = Array.from({ length: 18 }, (_, index) => {
        const name = `Dialog character ${index}`;
        const data = { name, description: '', personality: '', scenario: '', first_mes: 'Hello', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: { fav: false, talkativeness: 0.5 }, character_book: { name: `Embedded ${index}`, entries: [entry('Embedded entry', 0)] } };
        return { ...data, avatar: `pl-character-${index}.png`, chat: `pl-chat-${index}`, create_date: '2026-10-22', spec: 'chara_card_v2', spec_version: '2.0', data };
    });
    const bookEntries = ['Gamma', 'Alpha', 'Beta'].map(entry);
    const books = new Map(Array.from({ length: 8 }, (_, index) => [`Book ${index}`, { entries: {} }]));
    books.set('Embedded 0', { entries: {} });
    await page.route('**/api/characters/all', route => route.fulfill({ json: characters }));
    await page.route('**/api/characters/get', route => route.fulfill({ json: characters.find(character => character.avatar === payload(route.request()).avatar_url) }));
    await page.route('**/api/characters/chats', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/get', route => route.fulfill({ json: [] }));
    await page.route('**/api/characters/edit', route => {
        state.characterWrites.push(route.request().postDataBuffer().toString());
        return route.fulfill({ body: 'ok' });
    });
    await page.route('**/api/chats/save', route => {
        state.chatWrites.push(payload(route.request()));
        return route.fulfill({ json: {} });
    });
    await page.route('**/api/settings/get', async route => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        settings.main_api = 'openai';
        settings.power_user.sb_preset_autosave = false;
        settings.oai_settings.chat_completion_source = 'openai';
        settings.oai_settings.preset_settings_openai = 'Default';
        settings.extension_settings['quick-image-gen'] = { ...settings.extension_settings['quick-image-gen'], setupWizardSeen: true };
        settings.world_info = { globalSelect: [], charLore: [] };
        const preset = data.openai_settings[data.openai_setting_names.indexOf('Default')];
        data.openai_settings = Array.from({ length: 18 }, () => preset);
        data.openai_setting_names = Array.from({ length: 18 }, (_, index) => index ? `Preset ${index}` : 'Default');
        data.settings = JSON.stringify(settings);
        data.world_names = [...books.keys()];
        return route.fulfill({ json: data });
    });
    await page.route('**/api/settings/save', route => {
        const data = payload(route.request());
        state.settings.push(data);
        return route.fulfill({ json: { result: 'ok', version: data._version + 1 } });
    });
    await page.route('**/api/presets/save', route => {
        const data = payload(route.request());
        state.presets.push(data);
        return route.fulfill({ json: { name: data.name } });
    });
    await page.route('**/api/presets/delete', route => {
        state.deleted.push(payload(route.request()));
        return route.fulfill({ body: 'OK' });
    });
    await page.route('**/api/worldinfo/**', route => {
        const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
        const data = payload(route.request());
        if (endpoint === 'get') return route.fulfill({ status: books.has(data.name) ? 200 : 404, json: books.get(data.name) ?? {} });
        if (endpoint === 'list') return route.fulfill({ json: [...books].map(([name, data]) => ({ name, ...data })) });
        if (endpoint === 'edit') {
            state.worlds.push(data);
            books.set(data.name, structuredClone(data.data));
            return route.fulfill({ json: { ok: true, name: data.name } });
        }
        return route.abort();
    });
    await page.route(/\/api\/backends\/[^/]+\/status/, route => route.fulfill({ json: { error: true } }));
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.evaluate(async entries => {
        const wi = await import('/scripts/world-info.js');
        const data = wi.convertCharacterBook({ entries });
        await wi.saveWorldInfo('Book 0', data, true);
        const { power_user } = await import('/scripts/power-user.js');
        const { user_avatar } = await import('/scripts/personas.js');
        power_user.personas[user_avatar] = 'Dialog persona';
        power_user.persona_description_lorebook = '';
        const { characters } = await import('/script.js');
        const { accountStorage } = await import('/scripts/util/AccountStorage.js');
        for (const character of Object.values(characters)) accountStorage.setItem(`AlertWI_${character.avatar}`, 'true');
    }, bookEntries);
    state.worlds.length = 0;
    return { ...state, books };
}

export async function openPresetLorebookDialog(page, surface) {
    if (surface === 'sorting') {
        await page.evaluate(async () => (await import('/scripts/world-info.js')).openWorldInfoEditor('Book 0'));
        await page.locator('#WorldInfo .sb-wi-row').first().waitFor();
        await page.evaluate(() => $('#world_info_sort_order').val('1').trigger('change'));
    }
    await page.evaluate(async surface => {
        const { getPresetManager } = await import('/scripts/preset-manager.js');
        const manager = getPresetManager('openai');
        const capture = promise => { window.__plResult = undefined; window.__plError = undefined; promise.then(value => { window.__plResult = value; }).catch(error => { window.__plError = error.message; }); };
        if (surface === 'export') capture(manager.constructor.performMasterExport());
        if (surface === 'import') capture(manager.constructor.performMasterImport({
            instruct: { name: 'Dialog import instruct', input_sequence: 'Input', output_sequence: 'Output' },
            context: { name: 'Dialog import context', story_string: '{{description}}' },
            sysprompt: { name: 'Dialog import system', content: 'System' },
            preset: { name: 'Dialog import preset', temp: 1, top_k: 40, top_p: 0.9, rep_pen: 1 },
            reasoning: { name: 'Dialog import reasoning', prefix: '<think>', suffix: '</think>', separator: '\n' },
            srw: { value: 'Dialog prefix', show: true },
        }, 'dialog-import.json'));
        if (surface === 'delete') document.querySelector('[data-preset-manager-delete-all="openai"]').click();
        if (surface === 'batch') capture((await import('/scripts/world-info.js')).importEmbeddedWorldInfoBatch());
        if (surface === 'sorting') document.getElementById('world_apply_current_sorting').click();
        if (surface === 'chat') {
            const core = await import('/script.js');
            const id = Object.keys(core.characters).find(id => core.characters[id].avatar === 'pl-character-0.png');
            await core.selectCharacterById(id, { switchMenu: false });
            capture((await import('/scripts/world-info.js')).assignLorebookToChat({ shiftKey: true }));
        }
        if (surface === 'persona') $('#persona_lore_button').trigger({ type: 'click', shiftKey: true });
        if (surface === 'character') {
            const core = await import('/script.js');
            const id = Object.keys(core.characters).find(id => core.characters[id].avatar === 'pl-character-0.png');
            core.setCharacterId(id);
            core.select_selected_character(id, { switchMenu: false });
            $('#set_character_world').data('chid', id).prop('selected', true);
            $('#char-management-dropdown').trigger('change');
        }
    }, surface);
    const popup = page.locator('dialog.popup[open]').last();
    await popup.waitFor();
    await page.waitForFunction(() => !document.querySelector('dialog.popup[open][opening]'));
    return popup;
}
