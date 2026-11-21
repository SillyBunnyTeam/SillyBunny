import { gunzipSync } from 'node:zlib';
import { fetchJsonOrSkip } from './route-fetch.js';
import { applyWelcomeSettings } from './welcome-dialog.js';

function readPayload(request) {
    const buffer = request.postDataBuffer();
    return JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(buffer) : buffer).toString());
}

/**
 * Keeps what a spec saves in memory and gives it back on the next read, so a spec that saves settings, Chat Completion
 * presets and keys, then reloads or reads them again, works without a write to the server. The routes answer before the
 * ones of `protectMaintainerServer`, which still stubs every other write.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ settings: Record<string, any> | null, presets: Map<string, Record<string, any>>, secrets: Map<string, object[]> }>}
 *   What the page saved: the settings object, the presets by name, and the key state by secret key.
 */
export async function keepSavesInPage(page) {
    const kept = { settings: null, presets: new Map(), secrets: new Map() };
    let version = 0;

    await page.route('**/api/settings/save', (route) => {
        kept.settings = readPayload(route.request());
        version = (kept.settings._version ?? version) + 1;
        return route.fulfill({ json: { result: 'ok', version } });
    });
    await page.route('**/api/presets/save', (route) => {
        const { apiId, name, preset } = readPayload(route.request());
        if (apiId === 'openai') kept.presets.set(name, preset);
        return route.fulfill({ json: { name } });
    });
    await page.route('**/api/secrets/write', (route) => {
        const { key, value, label } = readPayload(route.request());
        const id = `kept-${kept.secrets.size + 1}`;
        kept.secrets.set(key, [{ id, value: '*'.repeat(String(value).length), label, active: true }]);
        return route.fulfill({ json: { id } });
    });
    await page.route('**/api/secrets/read', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        return route.fulfill({ json: { ...data, ...Object.fromEntries(kept.secrets) } });
    });
    await page.route('**/api/settings/get', async (route) => {
        if (!kept.settings && kept.presets.size === 0) return route.fallback();
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        if (kept.settings) {
            data.settings = JSON.stringify({ ...kept.settings, _version: version });
        } else {
            // This route fetched the response itself, so the route that keeps Welcome closed was skipped.
            const settings = JSON.parse(data.settings);
            applyWelcomeSettings(settings);
            data.settings = JSON.stringify(settings);
        }
        for (const [name, preset] of kept.presets) {
            // The server sends each preset as the text of its file.
            const index = data.openai_setting_names.indexOf(name);
            if (index >= 0) {
                data.openai_settings[index] = JSON.stringify(preset);
            } else {
                data.openai_setting_names.push(name);
                data.openai_settings.push(JSON.stringify(preset));
            }
        }
        return route.fulfill({ json: data });
    });
    return kept;
}
