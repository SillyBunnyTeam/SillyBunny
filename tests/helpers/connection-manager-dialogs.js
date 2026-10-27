import { gunzipSync } from 'node:zlib';
import { protectMaintainerServer } from './maintainer-server.js';
import { fetchJsonOrSkip } from './route-fetch.js';

export const CM_VIEWPORTS = [
    { width: 1440, height: 900, presentation: 'floating' },
    { width: 390, height: 844, presentation: 'sheet' },
    { width: 844, height: 390, presentation: 'floating' },
];

export async function bootConnectionDialogs(page, viewport) {
    await protectMaintainerServer(page);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const saves = [];
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const buffer = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(buffer.toString());
        saves.push(payload);
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
    await page.route('**/api/settings/get', async route => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        settings.main_api = 'openai';
        settings.oai_settings.chat_completion_source = 'openai';
        settings.oai_settings.openai_model = 'gpt-4o';
        settings.oai_settings.preset_settings_openai = 'Default';
        settings.extension_settings.connectionManager = {
            selectedProfile: 'cm-profile-0',
            folders: Array.from({ length: 8 }, (_, index) => ({ id: `cm-folder-${index}`, name: `Folder ${index}` })),
            profiles: Array.from({ length: 8 }, (_, index) => ({
                id: `cm-profile-${index}`, name: `Profile ${index}`, mode: 'cc', exclude: ['legacy-command'],
                folderId: null, fav: false, api: 'openai', preset: 'Default', model: 'gpt-4o',
                'reasoning-effort': 'high', verbosity: 'low', 'start-reply-with': '<b>Saved text</b>',
                'stop-strings': '', 'active-agents': '<None>', samplers: 'Temperature: 1',
                'world-info-active-count': '0',
            })),
        };
        data.settings = JSON.stringify(settings);
        return route.fulfill({ json: data });
    });
    await page.route(/\/api\/backends\/[^/]+\/status/, route => route.fulfill({ json: { error: true } }));
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
    return saves;
}

export async function openConnectionDialog(page, surface) {
    const ids = { create: 'create_connection_profile', edit: 'edit_connection_profile', delete: 'delete_all_connection_profiles', folders: 'manage_profile_folders', view: 'view_connection_profile' };
    await page.evaluate(id => document.getElementById(id).click(), ids[surface]);
    const popup = page.locator('dialog.popup[open]').last();
    await popup.waitFor();
    await page.waitForFunction(() => !document.querySelector('dialog.popup[open][opening]'));
    return popup;
}

export function connectionState(page) {
    return page.evaluate(() => window.SillyTavern.getContext().extensionSettings.connectionManager);
}
