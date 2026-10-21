import { gunzipSync } from 'node:zlib';
import { protectMaintainerServer } from './maintainer-server.js';

export const MISC_VIEWPORTS = [
    { width: 1440, height: 900, presentation: 'floating' },
    { width: 390, height: 844, presentation: 'sheet' },
];

function payload(request) {
    const body = request.postDataBuffer();
    return body ? JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString()) : {};
}

export async function bootMiscDialogs(page, viewport, { admin = false } = {}) {
    await protectMaintainerServer(page);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const state = { settings: [], users: [], installs: [], branches: [] };
    const currentUser = { handle: 'dialog-user', name: 'Dialog User', admin, enabled: true, password: true, created: 0, avatar: '/img/ai4.png' };
    const data = { name: 'Dialog Character', description: '', personality: '', scenario: '', first_mes: 'Hello', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: { talkativeness: 0.5 } };
    const character = { ...data, avatar: 'misc-dialog-character.png', chat: 'misc-dialog-chat', create_date: '2026-10-22', spec: 'chara_card_v2', spec_version: '2.0', data };
    // Context-level account fallback prevents any accidental request reaching a real account route.
    await page.context().route('**/api/users/**', route => route.fulfill({ status: 400, json: { error: 'Blocked by dialog test' } }));
    await page.route('**/api/users/**', route => {
        const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
        if (endpoint === 'me') return route.fulfill({ json: currentUser });
        if (endpoint === 'get') return route.fulfill({ json: [{ ...currentUser, handle: 'other-user', name: 'Other User' }] });
        if (endpoint === 'reset-step1') return route.fulfill({ json: {} });
        state.users.push({ endpoint, ...payload(route.request()) });
        return route.fulfill({ status: 400, json: { error: 'Intercepted by dialog test' } });
    });
    await page.route('**/api/characters/all', route => route.fulfill({ json: [character] }));
    await page.route('**/api/characters/get', route => route.fulfill({ json: character }));
    await page.route('**/api/characters/chats', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/get', route => route.fulfill({ json: [] }));
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const body = await response.json();
        const settings = JSON.parse(body.settings);
        settings.firstRun = false;
        settings.main_api = 'openai';
        settings.power_user.sb_preset_autosave = false;
        settings.power_user.custom_css = '';
        settings.power_user.external_media_allowed_overrides = [];
        settings.power_user.external_media_forbidden_overrides = [];
        settings.extension_settings['quick-image-gen'] = { ...settings.extension_settings['quick-image-gen'], setupWizardSeen: true };
        settings.extension_settings.connectionManager = {
            selectedProfile: 'misc-profile-0', folders: [],
            profiles: Array.from({ length: 6 }, (_, index) => ({ id: `misc-profile-${index}`, name: `Profile ${index}`, mode: 'cc', api: 'openai', preset: 'Default', model: 'gpt-4o', exclude: [], folderId: null })),
        };
        body.settings = JSON.stringify(settings);
        return route.fulfill({ json: body });
    });
    await page.route('**/api/settings/save', route => {
        const data = payload(route.request());
        state.settings.push(data);
        return route.fulfill({ json: { result: 'ok', version: data._version + 1 } });
    });
    await page.route('**/api/extensions/install', route => {
        state.installs.push(payload(route.request()));
        return route.fulfill({ status: 400, body: 'Intercepted extension install' });
    });
    await page.route('**/api/extensions/branches', route => route.fulfill({ json: [
        { name: 'main', commit: 'abc123', current: true, label: 'Main' },
        { name: 'dev', commit: 'def456', current: false, label: 'Development' },
    ] }));
    await page.route('**/api/extensions/switch', route => {
        state.branches.push(payload(route.request()));
        return route.fulfill({ status: 400, body: 'Intercepted branch switch' });
    });
    await page.route(/\/api\/backends\/[^/]+\/status/, route => route.fulfill({ json: { error: true } }));
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.evaluate(async () => {
        await (await import('/scripts/user.js')).setUserControls(true);
        const core = await import('/script.js');
        const id = Object.keys(core.characters).find(id => core.characters[id].avatar === 'misc-dialog-character.png');
        core.setCharacterId(id);
        (await import('/scripts/util/AccountStorage.js')).accountStorage.setItem('extensionInstallationWarningShown', '1');
    });
    return state;
}

export async function openMiscDialog(page, surface) {
    if (['password', 'settings', 'reset', 'delete'].includes(surface)) {
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
        await page.locator('#account_button').waitFor({ state: 'attached' });
    }
    if (['password', 'settings', 'reset'].includes(surface)) {
        await page.evaluate(() => $('#account_button').trigger('click'));
        await page.locator('dialog[open] .userResetAllButton').waitFor();
        const selector = { password: '.userChangePasswordButton', settings: '.userResetSettingsButton', reset: '.userResetAllButton' }[surface];
        await page.locator(`dialog[open] ${selector}`).dispatchEvent('click');
    } else if (surface === 'delete') {
        await page.evaluate(() => $('#admin_button').trigger('click'));
        await page.locator('dialog[open] .usersList .userDelete').first().waitFor();
        await page.locator('dialog[open] .usersList .userDelete').first().dispatchEvent('click');
    } else {
        await page.evaluate(async surface => {
            if (surface === 'styles') $('#creators_note_styles_button').trigger('click');
            if (surface === 'media') {
                const button = document.createElement('button');
                button.className = 'open_media_overrides';
                document.body.append(button);
                button.click();
                button.remove();
            }
            if (surface === 'css') $('#custom_css_ai_wand').trigger('click');
            if (surface === 'screenshot') {
                const context = window.SillyTavern.getContext();
                context.chat.length = 0;
                document.getElementById('chat').replaceChildren();
                for (const mes of ['First screenshot message', 'Second screenshot message']) {
                    const message = { name: 'Dialog User', is_user: true, is_system: false, send_date: new Date().toISOString(), mes, extra: {} };
                    context.chat.push(message);
                    context.addOneMessage(message, { scroll: false });
                }
                document.querySelector('#chat .mes .mes_screenshot').click();
            }
            if (surface === 'install') void (await import('/scripts/extensions.js')).openThirdPartyExtensionMenu('https://example.test/extension');
            if (surface === 'branch') {
                const parent = document.createElement('div');
                parent.className = 'extensions_info';
                parent.innerHTML = '<div class="extension_block"><button class="btn_branch" data-name="dialog-extension"></button></div>';
                document.body.append(parent);
                parent.querySelector('button').click();
                parent.remove();
            }
        }, surface);
    }
    const popup = page.locator('dialog.popup[open]').last();
    await popup.waitFor();
    await page.waitForFunction(() => !document.querySelector('dialog.popup[open][opening]'));
    // Account helper popups are pushed over a live parent; wait for the child, not just its parent.
    if (surface === 'password') await popup.locator('input[name="confirm"]').waitFor();
    if (surface === 'settings') await popup.locator('#resetSettingsPassword').waitFor();
    if (surface === 'reset') await popup.locator('input[name="code"]').waitFor();
    if (surface === 'delete') await popup.locator('#deleteUserHandle').waitFor();
    return page.locator(`dialog.popup[data-id="${await popup.getAttribute('data-id')}"]`);
}
