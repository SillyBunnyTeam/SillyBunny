import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { sizeFreeTestFor } from './helpers/matrix.js';
import { BUNDLED_THEME_NAMES, readChipContrast, selectTheme } from './helpers/page-contrast.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
const COPY_PLACEHOLDER = 'TODO(copy)';

const VIEWPORTS = [
    { name: 'desktop 1440x900', checksColours: true, options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', checksColours: false, options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

const GROUPS = ['First-Party Extensions', 'Third-Party Extensions', 'Themes', 'Presets'];
/** Every row of the window, in page order, and the folder an extension installs into. */
const ITEMS = [
    { id: 'alternate-descriptions', label: 'Alternate Descriptions', folder: 'SillyBunny-AlternateDescriptions', url: 'https://github.com/SillyBunnyTeam/SillyBunny-AlternateDescriptions' },
    { id: 'bot-searcher', label: 'Bot Searcher', folder: 'SillyBunny-BotSearcher', url: 'https://github.com/SillyBunnyTeam/SillyBunny-BotSearcher' },
    { id: 'css-snippets', label: 'CSS Snippets', folder: 'SillyBunny-CssSnippets', url: 'https://github.com/SillyBunnyTeam/SillyBunny-CssSnippets' },
    { id: 'deep-swipe', label: 'Deep Swipe', folder: 'SillyBunny-Deep-Swipe', url: 'https://github.com/SillyBunnyTeam/SillyBunny-Deep-Swipe' },
    { id: 'macro-enhanced', label: 'Macro Enhanced', folder: 'SillyBunny-MacroEnhanced', url: 'https://github.com/SillyBunnyTeam/SillyBunny-MacroEnhanced' },
    { id: 'prompt-tags', label: 'Prompt Tags', folder: 'SillyBunny-PromptTags', url: 'https://github.com/SillyBunnyTeam/SillyBunny-PromptTags' },
    { id: 'prompting-lab', label: 'Prompting Lab', folder: 'SillyBunny-Prompting-Lab', url: 'https://github.com/SillyBunnyTeam/SillyBunny-Prompting-Lab' },
    { id: 'regex-agent-themes', label: 'Regex Agent Themes', folder: 'SillyBunny-Regex-Agent-Themes', url: 'https://github.com/SillyBunnyTeam/SillyBunny-Regex-Agent-Themes' },
    { id: 'time-machine', label: 'Time Machine', folder: 'SillyBunny-Time-Machine', url: 'https://github.com/SillyBunnyTeam/SillyBunny-Time-Machine' },
    { id: 'world-info-lab', label: 'World Info Lab', folder: 'SillyBunny-WorldInfo-Lab', url: 'https://github.com/SillyBunnyTeam/SillyBunny-WorldInfo-Lab' },
    { id: 'dialogue-colors', label: 'Dialogue Colors', folder: 'sillytavern-character-colors', url: 'https://github.com/platberlitz/sillytavern-character-colors' },
    { id: 'summary-sharder', label: 'Summary Sharder', folder: 'summary-sharder', url: 'https://github.com/Promansis/summary-sharder' },
    { id: 'group-chat-overhaul', label: 'Group Chat Overhaul', folder: 'SillyBunnyGCO', url: 'https://github.com/voldomero/SillyBunnyGCO' },
    { id: 'lalib', label: 'LALib', folder: 'SillyTavern-LALib', url: 'https://github.com/LenAnderson/SillyTavern-LALib' },
    { id: 'moonlit-echoes', label: 'Moonlit Echoes', folder: 'SillyBunny-MoonlitEchoesTheme', url: 'https://github.com/SillyBunnyTeam/SillyBunny-MoonlitEchoesTheme' },
    { id: 'terminal-ui', label: 'Terminal UI', folder: 'SillyBunny-Terminal-UI', url: 'https://github.com/SillyBunnyTeam/SillyBunny-Terminal-UI' },
    { id: 'geechan-universal-roleplay', label: 'Geechan - Universal Roleplay (v5.2)' },
    { id: 'tld-card-conversion', label: 'TLD Card Conversion Preset' },
];
const item = id => ITEMS.find(candidate => candidate.id === id);

const GEECHAN_PRESET = 'Geechan - Universal Roleplay (Chat Completions) (v5.2)';
const FIXTURE_THEME = { id: 'fixture-midnight', name: 'Fixture Midnight', group: 'themes', kind: 'theme-css', url: 'https://example.com/fixture-midnight', themeName: 'Fixture Midnight' };

const hosts = page => page.locator('dialog.sb-dialog-host:not([closing])');
const homeTile = (page, key) => page.locator(`#chat > .welcomePanel .sbHomeTile[data-sb-home-key="${key}"]`);
const rowOf = (host, label) => host.locator('.ds-row', { has: host.page().locator('.ds-row-label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
const statusOf = row => row.locator('.sbBundledExtraState');
const buttonsOf = row => row.locator('.sbBundledExtraControls button');

const readPayload = (request) => {
    const buffer = request.postDataBuffer();
    const bytes = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(buffer) : buffer;
    return JSON.parse(bytes.toString());
};

/**
 * Starts the app on Home with the extension, preset and theme routes answered by a small world that the test keeps in
 * memory: which extension folders are installed (and switched off), which bundled preset is missing from the list, and
 * which themes the server holds. The install, delete, restore and theme routes only record the call and update that world.
 */
async function boot(page, { installed = {}, missingPresets = [], themeInstall = null, cleanHooks = [] } = {}) {
    const world = {
        folders: new Map(Object.entries(installed)),
        missingPresets: new Set(missingPresets),
        cleanHooks: new Set(cleanHooks),
        savedThemes: [],
        settingsReads: 0,
        calls: [],
        settingsSaves: [],
    };

    page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (request.method() === 'POST' && /^\/api\/(?:extensions\/(?:install|delete)|presets\/(?:restore|save|restore-defaults)|sillybunny\/themes\/install-bundled)$/.test(pathname)) {
            world.calls.push({ path: pathname, body: request.postDataJSON() });
        }
        if (request.method() === 'POST' && pathname === '/api/characters/import') {
            world.calls.push({ path: pathname });
        }
    });

    await protectMaintainerServer(page);
    await installFixtureChats(page);

    await page.route('**/api/extensions/discover', async (route) => {
        const real = await fetchJsonOrSkip(route);
        if (!real) return;
        const known = real.filter(entry => !world.folders.has(entry.name.replace(/^third-party\//, '')));
        return route.fulfill({ json: [...known, ...[...world.folders.keys()].map(folder => ({ name: `third-party/${folder}`, type: 'local' }))] });
    });
    await page.route('**/scripts/extensions/third-party/*/manifest.json*', (route) => {
        const folder = new URL(route.request().url()).pathname.split('/').at(-2);
        return world.folders.has(folder)
            ? route.fulfill({ json: { display_name: folder, loading_order: 100, requires: [], optional: [], version: '1.0.0', author: 'Fixture', ...(world.cleanHooks.has(folder) ? { hooks: { clean: 'onClean' } } : {}) } })
            : route.fulfill({ status: 404, body: 'missing' });
    });
    await page.route('**/api/extensions/install', async (route) => {
        const folder = new URL(route.request().postDataJSON().url).pathname.split('/').at(-1);
        world.folders.set(folder, true);
        return route.fulfill({ json: { version: '1.0.0', author: 'Fixture', display_name: folder, extensionPath: `/fixture/${folder}`, folderName: folder } });
    });
    await page.route('**/api/extensions/delete', (route) => {
        world.folders.delete(route.request().postDataJSON().extensionName);
        return route.fulfill({ body: 'ok' });
    });
    // The bulk restore copies every bundled preset over the file of the user. A row must never call it, so it answers with nothing restored.
    await page.route('**/api/presets/restore-defaults', route => route.fulfill({ json: { ok: true, restored: [], failed: [] } }));
    await page.route('**/api/presets/restore', route => route.fulfill({ json: { isDefault: true, preset: { name: GEECHAN_PRESET, temperature: 1 } } }));
    await page.route('**/api/presets/save', (route) => {
        const { name } = route.request().postDataJSON();
        world.missingPresets.delete(name);
        return route.fulfill({ json: { name } });
    });
    await page.route('**/api/sillybunny/themes/install-bundled', (route) => {
        if (themeInstall?.status === 409) {
            return route.fulfill({ status: 409, json: { error: 'already_installed', name: FIXTURE_THEME.themeName } });
        }
        if (themeInstall?.status && themeInstall.status !== 201) {
            return route.fulfill({ status: themeInstall.status, json: { error: themeInstall.error } });
        }
        world.savedThemes.push(FIXTURE_THEME.themeName);
        return route.fulfill({ status: 201, json: { name: FIXTURE_THEME.themeName, theme: { name: FIXTURE_THEME.themeName, custom_css: '' } } });
    });
    await page.route('**/api/settings/save', (route) => {
        world.settingsSaves.push(readPayload(route.request()));
        return route.fulfill({ json: { result: 'ok', version: (world.settingsSaves.at(-1)._version ?? 0) + 1 } });
    });
    // This route answers last-registered first and fetches the real response, so it also applies the Home test settings.
    await page.route('**/api/settings/get', async (route) => {
        world.settingsReads += 1;
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyHomeTestSettings(settings);
        settings.accountStorage = { ...settings.accountStorage };
        delete settings.accountStorage.extensionInstallationWarningShown;
        settings.extension_settings = {
            ...settings.extension_settings,
            disabledExtensions: [...world.folders].filter(([, enabled]) => !enabled).map(([folder]) => `third-party/${folder}`),
        };
        const keep = data.openai_setting_names.map(name => !world.missingPresets.has(name));
        data.openai_setting_names = data.openai_setting_names.filter((_, index) => keep[index]);
        data.openai_settings = data.openai_settings.filter((_, index) => keep[index]);
        const themeTemplate = data.themes[0];
        data.themes = [...data.themes, ...world.savedThemes.map(name => ({ ...themeTemplate, name, custom_css: themeTemplate.custom_css ?? '' }))];
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });

    await openQuietChatForSmoke(page, { selectCharacter: false });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await expect(page.locator('#chat > .welcomePanel')).toBeAttached({ timeout: STARTUP_TIMEOUT });
    return world;
}

async function openFromTile(page) {
    await homeTile(page, 'extras').click();
    const host = hosts(page);
    await expect(host).toBeVisible();
    await expect(host.locator('.ds-row-label', { hasText: 'Deep Swipe' })).toBeVisible();
    return host;
}

/** Opens the real window with one more item than the static list has, as the list will have when themes are picked. */
async function openWithFixtureTheme(page) {
    await page.evaluate(async (fixture) => {
        const { BUNDLED_EXTRAS } = await import('/scripts/sillybunny-bundled-extras.js');
        const { openBundledExtrasWindow } = await import('/scripts/sillybunny-home/bundled-extras-window.js');
        await openBundledExtrasWindow({ items: [...BUNDLED_EXTRAS, fixture] });
    }, FIXTURE_THEME);
    const host = hosts(page);
    await expect(host).toBeVisible();
    return host;
}

const popupButton = (page, name) => page.locator(`dialog.popup[open] .popup-button-${name}`);

for (const { name, checksColours, options } of VIEWPORTS) {
    test.describe(`Bundled Extras at ${name}`, () => {
        test.use(options);
        // Only the tests that open the window and fit its rows use `test`; the rest do not depend on the size.
        const sizeFreeTest = sizeFreeTestFor(test, options.viewport);

        test.describe('the window', () => {
            /** @type {Awaited<ReturnType<typeof boot>>} */
            let world;
            test.beforeEach(async ({ page }) => {
                world = await boot(page, {
                    installed: { 'SillyBunny-Deep-Swipe': true, 'SillyBunny-BotSearcher': false },
                    missingPresets: [GEECHAN_PRESET],
                    cleanHooks: ['SillyBunny-BotSearcher'],
                });
            });

            test('lists every group and row, each with its real state, its actions and the slot of its description', async ({ page }) => {
                const host = await openFromTile(page);

                await expect(host.getByRole('heading', { level: 3 })).toHaveText(GROUPS);
                await expect(host.getByRole('heading', { name: 'Third-Party Themes' })).toHaveCount(0);
                await expect(host.locator('.ds-row-label')).toHaveText([...ITEMS.map(entry => entry.label), 'UI Themes']);

                const slots = await host.locator('[data-sb-copy-placeholder="true"]').evaluateAll(nodes => nodes.map(node => [node.dataset.sbCopySlot, node.textContent.trim()]));
                expect(slots.filter(([slot]) => slot.startsWith('BE-ITEM-')).map(([slot]) => slot).sort())
                    .toEqual(ITEMS.map(entry => `BE-ITEM-${entry.id.toUpperCase()}`).sort());
                expect(slots.every(([, text]) => text === COPY_PLACEHOLDER)).toBe(true);

                const expected = {
                    'deep-swipe': ['Enabled', ['Disable', 'Remove']],
                    'bot-searcher': ['Installed', ['Enable', 'Remove']],
                    'alternate-descriptions': ['Not installed', ['Install']],
                    'dialogue-colors': ['Not installed', ['Install']],
                    'moonlit-echoes': ['Not installed', ['Install']],
                    'terminal-ui': ['Not installed', ['Install']],
                    'geechan-universal-roleplay': ['Not installed', ['Restore']],
                    'tld-card-conversion': ['Installed', []],
                };
                for (const [id, [status, buttons]] of Object.entries(expected)) {
                    const row = rowOf(host, item(id).label);
                    await expect(statusOf(row), id).toHaveText(status);
                    await expect(buttonsOf(row), id).toHaveText(buttons);
                }
            });

            test('shows the state as a chip with its text always, a check on an item that is there, and keeps the row inside the window', async ({ page }) => {
                const host = await openFromTile(page);
                const chips = {};

                for (const [label, status, tone] of [['Deep Swipe', 'enabled', 'success'], ['Bot Searcher', 'installed', 'success'], ['Alternate Descriptions', 'not-installed', 'neutral']]) {
                    const row = host.locator('.ds-row', { has: page.locator('.ds-row-label', { hasText: new RegExp(`^${label}$`) }) });
                    const look = await row.evaluate((node) => {
                        const state = node.querySelector('.sbBundledExtraState');
                        const button = node.querySelector('.sbBundledExtraControls button');
                        const controls = node.querySelector('.sbBundledExtraControls');
                        const box = node.getBoundingClientRect();
                        const stateBox = state.getBoundingClientRect();
                        const style = getComputedStyle(state);
                        return {
                            status: state.dataset.sbStatus,
                            tone: state.dataset.sbTone,
                            shared: state.classList.contains('sbStatusChip'),
                            text: state.textContent.trim(),
                            checks: state.querySelectorAll('i.fa-check[aria-hidden="true"]').length,
                            background: style.backgroundColor,
                            radius: style.borderTopLeftRadius,
                            display: getComputedStyle(controls).display,
                            gap: stateBox.right - button.getBoundingClientRect().left,
                            inside: controls.getBoundingClientRect().right <= box.right + 1,
                            overflows: node.scrollWidth > node.clientWidth + 1,
                        };
                    });
                    chips[status] = look;
                    expect(look.status, label).toBe(status);
                    expect(look.text, `${label}: the state is written out`).not.toBe('');
                    expect([look.shared, look.tone], `${label}: the shared chip, in the tone of the state`).toEqual([true, tone]);
                    expect(look.checks, `${label}: a check on an item that is there, and none on one that is not`).toBe(tone === 'success' ? 1 : 0);
                    expect(look.background, `${label}: the chip has a tint`).not.toBe('rgba(0, 0, 0, 0)');
                    expect(parseFloat(look.radius), `${label}: the chip is rounded`).toBeGreaterThan(8);
                    expect(look.display, label).toBe('flex');
                    expect(look.gap, `${label}: the state ends before the first button starts`).toBeLessThanOrEqual(-4);
                    expect(look.inside, label).toBe(true);
                    expect(look.overflows, label).toBe(false);
                }
                expect(chips.enabled.background, 'Enabled and Installed share the success tint').toBe(chips.installed.background);
                expect(chips['not-installed'].background, 'Not installed has the neutral tint').not.toBe(chips.installed.background);
            });

            if (checksColours) {
                test('keeps the text of every chip at 4.5:1 and its check at 3:1 against what is painted behind it, in every bundled theme', async ({ page }) => {
                    test.setTimeout(300_000);
                    const host = await openFromTile(page);
                    const readings = [];

                    for (const theme of BUNDLED_THEME_NAMES) {
                        await selectTheme(page, theme);

                        for (const label of ['Deep Swipe', 'Bot Searcher', 'Alternate Descriptions']) {
                            readings.push(...await readChipContrast(page, statusOf(rowOf(host, label)), `${theme}, ${label}`));
                        }
                    }

                    const below = readings.filter(reading => reading.ratio < reading.floor);
                    expect([...new Set(below.map(reading => `${reading.where}: ${reading.part} ${reading.ratio.toFixed(2)} < ${reading.floor}`))]).toEqual([]);
                    expect(readings.map(reading => reading.part).filter(part => part === 'check')).toHaveLength(BUNDLED_THEME_NAMES.length * 2 * 2);
                });
            }

            sizeFreeTest('Install on a first-party extension asks the install route for its repository, without a third-party warning, and the row then shows it installed', async ({ page }) => {
                const host = await openFromTile(page);

                const installed = page.waitForRequest('**/api/extensions/install');
                await buttonsOf(rowOf(host, 'Alternate Descriptions')).getByText('Install').click();
                const request = await installed;

                expect(request.postDataJSON()).toEqual({ url: item('alternate-descriptions').url, global: false, branch: '' });
                await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
                // The server enables a new extension, so it is on the moment it is installed.
                await expect(statusOf(rowOf(host, 'Alternate Descriptions'))).toHaveText('Enabled');
                await expect(buttonsOf(rowOf(host, 'Alternate Descriptions'))).toHaveText(['Disable', 'Remove']);
            });

            sizeFreeTest('Install on a third-party extension asks first: cancelling installs nothing, and accepting installs it', async ({ page }) => {
                const host = await openFromTile(page);
                const installs = [];
                page.on('request', request => request.url().endsWith('/api/extensions/install') && installs.push(request.postDataJSON().url));

                await buttonsOf(rowOf(host, 'LALib')).getByText('Install').click();
                await expect(page.locator('dialog.popup[open]')).toBeVisible();
                await popupButton(page, 'cancel').click();
                await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
                expect(installs).toEqual([]);
                await expect(statusOf(rowOf(host, 'LALib'))).toHaveText('Not installed');

                await buttonsOf(rowOf(host, 'LALib')).getByText('Install').click();
                await popupButton(page, 'ok').click();
                await expect(statusOf(rowOf(host, 'LALib'))).toHaveText('Enabled');
                expect(installs).toEqual([item('lalib').url]);
            });

            sizeFreeTest('Install on a theme that is an extension goes through the same install route', async ({ page }) => {
                const host = await openFromTile(page);

                const installed = page.waitForRequest('**/api/extensions/install');
                await buttonsOf(rowOf(host, 'Moonlit Echoes')).getByText('Install').click();

                expect((await installed).postDataJSON().url).toBe(item('moonlit-echoes').url);
                await expect(statusOf(rowOf(host, 'Moonlit Echoes'))).toHaveText('Enabled');
            });

            sizeFreeTest('Enable takes the extension off the disabled list and saves the settings', async ({ page }) => {
                const host = await openFromTile(page);

                const saved = page.waitForRequest(request => request.url().endsWith('/api/settings/save') && !readPayload(request).extension_settings.disabledExtensions.includes('third-party/SillyBunny-BotSearcher'));
                await buttonsOf(rowOf(host, 'Bot Searcher')).getByText('Enable').click();

                expect((await saved).method()).toBe('POST');
            });

            sizeFreeTest('Disable puts the extension on the disabled list and saves the settings', async ({ page }) => {
                const host = await openFromTile(page);

                const saved = page.waitForRequest(request => request.url().endsWith('/api/settings/save') && readPayload(request).extension_settings.disabledExtensions.includes('third-party/SillyBunny-Deep-Swipe'));
                await buttonsOf(rowOf(host, 'Deep Swipe')).getByText('Disable').click();

                expect((await saved).method()).toBe('POST');
            });

            sizeFreeTest('Remove asks first: cancelling deletes nothing, and accepting deletes the extension folder', async ({ page }) => {
                const host = await openFromTile(page);
                const deletes = [];
                page.on('request', request => request.url().endsWith('/api/extensions/delete') && deletes.push(request.postDataJSON()));

                await buttonsOf(rowOf(host, 'Deep Swipe')).getByText('Remove').click();
                await expect(page.locator('dialog.popup[open]')).toBeVisible();
                await popupButton(page, 'cancel').click();
                await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
                expect(deletes).toEqual([]);

                const deleted = page.waitForRequest('**/api/extensions/delete');
                await buttonsOf(rowOf(host, 'Deep Swipe')).getByText('Remove').click();
                await popupButton(page, 'ok').click();

                expect((await deleted).postDataJSON()).toEqual({ extensionName: 'SillyBunny-Deep-Swipe', global: false });
            });

            sizeFreeTest('Remove on an extension with a clean hook offers the clean-up checkbox of the Extensions panel, and one without does not', async ({ page }) => {
                const host = await openFromTile(page);
                const cleanup = page.locator('dialog.popup[open]').getByLabel('Also clean up extension data');

                await buttonsOf(rowOf(host, 'Bot Searcher')).getByText('Remove').click();
                await expect(cleanup).toBeVisible();
                await expect(cleanup).not.toBeChecked();
                await popupButton(page, 'cancel').click();
                await expect(page.locator('dialog.popup[open]')).toHaveCount(0);

                await buttonsOf(rowOf(host, 'Deep Swipe')).getByText('Remove').click();
                await expect(page.locator('dialog.popup[open]')).toBeVisible();
                await expect(cleanup).toHaveCount(0);
                await popupButton(page, 'cancel').click();
            });

            sizeFreeTest('the delete confirm shows a name with HTML as text', async ({ page }) => {
                await openFromTile(page);
                const name = '<img src="/x.png" alt="injected">';

                await page.evaluate(async (extensionName) => {
                    const { confirmAndDeleteExtension } = await import('/scripts/extensions.js');
                    void confirmAndDeleteExtension(extensionName);
                }, name);

                const popup = page.locator('dialog.popup[open]');
                await expect(popup).toContainText(name);
                await expect(popup.locator('img[alt="injected"]')).toHaveCount(0);
                await popupButton(page, 'cancel').click();
            });

            sizeFreeTest('Restore on a missing bundled preset restores that one preset through the single-preset routes, and the row then shows it installed', async ({ page }) => {
                const host = await openFromTile(page);

                const read = page.waitForRequest('**/api/presets/restore');
                const saved = page.waitForRequest('**/api/presets/save');
                await buttonsOf(rowOf(host, 'Geechan - Universal Roleplay (v5.2)')).getByText('Restore').click();

                expect((await read).postDataJSON()).toEqual({ name: GEECHAN_PRESET, apiId: 'openai' });
                expect((await saved).postDataJSON()).toEqual({ name: GEECHAN_PRESET, apiId: 'openai', preset: { name: GEECHAN_PRESET, temperature: 1 } });
                await expect(statusOf(rowOf(host, 'Geechan - Universal Roleplay (v5.2)'))).toHaveText('Installed');
                await expect(buttonsOf(rowOf(host, 'Geechan - Universal Roleplay (v5.2)'))).toHaveCount(0);
                expect(world.calls.filter(call => call.path === '/api/presets/restore-defaults'), 'the bulk restore is not called').toEqual([]);
            });

            sizeFreeTest('Restore adds the preset to the list without selecting it, so the preset in use stays', async ({ page }) => {
                const host = await openFromTile(page);
                const selected = () => page.locator('#settings_preset_openai').inputValue();
                const before = await selected();

                await buttonsOf(rowOf(host, 'Geechan - Universal Roleplay (v5.2)')).getByText('Restore').click();
                await expect(statusOf(rowOf(host, 'Geechan - Universal Roleplay (v5.2)'))).toHaveText('Installed');

                await expect(page.locator('#settings_preset_openai option', { hasText: GEECHAN_PRESET })).toHaveCount(1);
                expect(await selected()).toBe(before);
            });

            sizeFreeTest('lists no Third-Party Themes group while no CSS theme is pinned, and shows it once there is one', async ({ page }) => {
                const closed = await openFromTile(page);
                await expect(closed.getByRole('heading', { name: 'Third-Party Themes' })).toHaveCount(0);
                await page.keyboard.press('Escape');
                await expect(hosts(page)).toHaveCount(0);

                const host = await openWithFixtureTheme(page);

                await expect(host.getByRole('heading', { level: 3 })).toHaveText(['First-Party Extensions', 'Third-Party Extensions', 'Themes', 'Third-Party Themes', 'Presets']);
                await expect(statusOf(rowOf(host, 'Fixture Midnight'))).toHaveText('Not installed');
                await expect(host.locator('[data-sb-copy-slot="BE-ITEM-FIXTURE-MIDNIGHT"]')).toHaveText(COPY_PLACEHOLDER);
            });

            sizeFreeTest('installing a CSS theme posts its id, refreshes the UI theme list, and Apply switches to it', async ({ page }) => {
                const host = await openWithFixtureTheme(page);
                await expect(page.locator(`#themes option[value="${FIXTURE_THEME.themeName}"]`)).toHaveCount(0);

                const posted = page.waitForRequest('**/api/sillybunny/themes/install-bundled');
                const readsBefore = world.settingsReads;
                await buttonsOf(rowOf(host, 'Fixture Midnight')).getByText('Install').click();

                expect((await posted).postDataJSON()).toEqual({ id: 'fixture-midnight' });
                await expect(statusOf(rowOf(host, 'Fixture Midnight'))).toHaveText('Installed');
                expect(world.settingsReads, 'a new install registers the theme the route returned, with no settings round trip').toBe(readsBefore);
                await expect(page.locator(`#themes option[value="${FIXTURE_THEME.themeName}"]`)).toHaveCount(1);
                await expect(buttonsOf(rowOf(host, 'Fixture Midnight'))).toHaveText(['Apply']);

                await buttonsOf(rowOf(host, 'Fixture Midnight')).getByText('Apply').click();

                await expect.poll(() => page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.theme)).toBe(FIXTURE_THEME.themeName);
            });

            sizeFreeTest('lists no assistant: no group, no row for Nahida, no art beside a row, and opening the window imports no card', async ({ page }) => {
                const host = await openFromTile(page);

                await expect(host.getByRole('heading', { name: 'Assistants' })).toHaveCount(0);
                await expect(host.locator('.ds-row-label', { hasText: 'Nahida' })).toHaveCount(0);
                await expect(host.locator('[data-sb-art-placeholder^="row-"]')).toHaveCount(0);
                await expect(host.locator('[data-sb-copy-slot^="AS-"]')).toHaveCount(0);
                expect(world.calls.filter(call => call.path === '/api/characters/import')).toEqual([]);
            });
        });

        test.describe('a theme that is saved already', () => {
            sizeFreeTest('is read back from the saved themes, because the route leaves the one that is there', async ({ page }) => {
                const world = await boot(page, { themeInstall: { status: 409 } });
                const host = await openWithFixtureTheme(page);
                // The theme reached the server after this page loaded, so the page's list does not have it.
                world.savedThemes.push(FIXTURE_THEME.themeName);
                const readsBefore = world.settingsReads;

                await buttonsOf(rowOf(host, 'Fixture Midnight')).getByText('Install').click();

                await expect(statusOf(rowOf(host, 'Fixture Midnight'))).toHaveText('Installed');
                await expect(page.locator(`#themes option[value="${FIXTURE_THEME.themeName}"]`)).toHaveCount(1);
                expect(world.settingsReads).toBeGreaterThan(readsBefore);
            });
        });

        test.describe('a theme that fails to install', () => {
            sizeFreeTest('stays not installed, logs the error and toasts the marked placeholder', async ({ page }) => {
                await boot(page, { themeInstall: { status: 502, error: 'hash_mismatch' } });
                await showToasts(page);
                const errors = [];
                page.on('console', message => message.type() === 'error' && errors.push(message.text()));
                const host = await openWithFixtureTheme(page);

                await buttonsOf(rowOf(host, 'Fixture Midnight')).getByText('Install').click();

                const toast = page.locator('#toast-container .toast-message[data-sb-copy-slot="BE-ACTION-ERROR"]');
                await expect(toast).toHaveText(COPY_PLACEHOLDER);
                await expect(toast).toHaveAttribute('data-sb-copy-placeholder', 'true');
                await expect(statusOf(rowOf(host, 'Fixture Midnight'))).toHaveText('Not installed');
                await expect(buttonsOf(rowOf(host, 'Fixture Midnight'))).toHaveText(['Install']);
                await expect(buttonsOf(rowOf(host, 'Fixture Midnight'))).toBeEnabled();
                expect(errors.some(line => line.includes('hash_mismatch') || line.includes('fixture-midnight'))).toBe(true);
            });
        });
    });
}
