import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

// End-to-end coverage for the connection profile change notice: one summary toast per user switch,
// silent scripted switches, the "Also sets" card line, and the id-keyed View popup.
// Run it against an isolated server through an out-of-repo config (absolute testDir, channel 'msedge', baseURL of
// that server). Such a config resolves '@playwright/test' from its own folder, so set NODE_PATH=<repo>/tests/node_modules.
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

// Longer than the 750 ms quiet window plus the 3 s busy grace, so a late summary would have shown.
const SILENT_WAIT_MS = 4000;
const AUTOSAVE_DELAY_MS = 1000;
const SUMMARY_TIMEOUT_MS = 10000;
const MOBILE_VIEWPORT = Object.freeze({ width: 390, height: 844 });
// A user preset cloned from the bundled Default, so a switch to CC_B changes the preset.
const SECOND_PRESET = 'SB Notice Second';
// The prompt-editor guard can hold the preset step of a switch for the preset manager's 10 s wait.
const GUARDED_SUMMARY_TIMEOUT_MS = 25000;
// The Edit handler shows "Included settings list updated" right after its popup closes, so a toast would be added by then.
const EDIT_TOAST_WAIT_MS = 1500;
// Longer than the 750 ms quiet window, so a report that does not wait for the Regex apply closes before the save returns.
const REGEX_SAVE_DELAY_MS = 1800;

const REGEX_PRESET_A = Object.freeze({ id: 'sb-e2e-regex-a', name: 'SB Regex A', isSelected: true, global: [], scoped: [], preset: [] });
const REGEX_PRESET_B = Object.freeze({ id: 'sb-e2e-regex-b', name: 'SB Regex B', isSelected: false, global: [], scoped: [], preset: [] });
// A scoped script that SB Regex B enables, shaped like the ones the Regex extension stores on a character.
const SCOPED_REGEX_SCRIPT = Object.freeze({ id: 'sb-e2e-scoped', scriptName: 'SB Scoped', findRegex: 'x', replaceString: 'x', placement: [], disabled: true, runOnEdit: false });

/**
 * Builds a profile shaped like the ones `readProfileFromCommands` writes, snapshot fields included.
 * @param {object} fields Profile fields
 * @returns {object} Profile
 */
function profile(fields) {
    return {
        exclude: [],
        folderId: null,
        fav: false,
        'active-agents': '<None>',
        samplers: 'Temperature: 1, Top P: 1, Top K: 0',
        'instruct-template': 'Alpaca',
        'context-template': 'Alpaca',
        'system-prompt': 'Neutral - Chat',
        'world-info-active-count': '0',
        ...fields,
    };
}

/**
 * A Chat Completion profile on the bundled `Default` preset.
 * @param {object} fields Profile fields
 * @returns {object} Profile
 */
function ccProfile(fields) {
    return profile({
        mode: 'cc',
        api: 'openai',
        preset: 'Default',
        'stop-strings': '',
        'start-reply-with': '',
        'reasoning-template': 'DeepSeek',
        ...fields,
    });
}

const CC_A = ccProfile({ id: 'sb-e2e-cc-a', name: 'CC_A', 'reasoning-effort': 'high', verbosity: 'low' });
const CC_B = ccProfile({ id: 'sb-e2e-cc-b', name: 'CC_B', preset: SECOND_PRESET, 'reasoning-effort': 'low', verbosity: 'high' });
const CC_HTML = ccProfile({ id: 'sb-e2e-cc-html', name: '<b>x</b>', 'start-reply-with': '<u>y</u>', 'reasoning-effort': 'medium', verbosity: 'medium' });
const CC_REGEX = ccProfile({ id: 'sb-e2e-cc-regex', name: 'CC_REGEX', 'regex-preset': REGEX_PRESET_B.id });
const TC_A = profile({
    id: 'sb-e2e-tc-a',
    name: 'TC_A',
    mode: 'tc',
    api: 'ooba',
    preset: 'Default',
    'sysprompt-state': 'true',
    sysprompt: 'Neutral - Chat',
    'instruct-state': 'true',
    instruct: 'Alpaca',
    context: 'Alpaca',
    'stop-strings': '',
    'start-reply-with': '',
    'reasoning-template': 'DeepSeek',
});
const PROFILES = Object.freeze([CC_A, CC_B, CC_HTML, CC_REGEX, TC_A]);
// Exclude entries the Edit popup does not render: a TC command, a legacy snapshot field and an unknown id.
const CC_LEGACY = ccProfile({ id: 'sb-e2e-cc-legacy', name: 'CC_LEGACY', exclude: ['instruct', 'system-prompt', 'sb-unknown'] });

/**
 * Loads the app with every write intercepted before navigation, the fixture profiles, two Regex presets and the
 * second user preset seeded.
 * @param {import('@playwright/test').Page} page
 * @param {{ autosave?: boolean, profiles?: object[] }} [options]
 * @returns {Promise<{ saves: object[] }>} Bodies of the preset saves, filled as they happen
 */
async function loadApp(page, { autosave = true, profiles = PROFILES } = {}) {
    const saves = [];
    const origin = new URL(test.info().project.use.baseURL).origin;
    const readOnlyEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me', '/api/presets/defaults',
    ]);
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/extensions/discover') {
            const response = await route.fetch();
            const extensions = await response.json();
            return route.fulfill({ json: extensions.filter(extension => !extension.name.startsWith('third-party/')) });
        }
        if (url.pathname === '/api/settings/get') {
            const response = await route.fetch();
            const data = await response.json();
            data.request_compression = { ...data.request_compression, enabled: false };
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            settings.main_api = 'openai';
            settings.power_user.sb_preset_autosave = autosave;
            settings.extension_settings['quick-image-gen'] = { ...settings.extension_settings['quick-image-gen'], setupWizardSeen: true };
            settings.extension_settings.connectionManager = { profiles: structuredClone(profiles), folders: [], selectedProfile: null };
            settings.extension_settings.regex_presets = structuredClone([REGEX_PRESET_A, REGEX_PRESET_B]);
            data.settings = JSON.stringify(settings);
            // Cloned from the bundled defaults, so the suite never depends on local preset files.
            data.openai_settings.push(data.openai_settings[data.openai_setting_names.indexOf('Default')]);
            data.openai_setting_names.push(SECOND_PRESET);
            data.textgenerationwebui_presets.push(data.textgenerationwebui_presets[data.textgenerationwebui_preset_names.indexOf('Default')]);
            data.textgenerationwebui_preset_names.push(SECOND_PRESET);
            return route.fulfill({ json: data });
        }
        if (url.pathname === '/api/presets/save') {
            const body = request.postDataJSON();
            saves.push(body);
            return route.fulfill({ json: { name: body?.name ?? '' } });
        }
        if (url.pathname === '/api/settings/save') return route.fulfill({ json: { version: Date.now() } });
        // No backend is ever contacted: every status check reports no connection.
        if (/^\/api\/backends\/[^/]+\/status/.test(url.pathname)) return route.fulfill({ json: { error: true } });
        if (readOnlyEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) return route.continue();
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && url.pathname.startsWith('/api/')) {
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await testSetup.waitForAppReady({ page });
    return { saves };
}

/**
 * Opens a left-shell tab and waits for its panel.
 * @param {import('@playwright/test').Page} page
 * @param {string} tab Tab id
 */
async function openPanel(page, tab) {
    await page.evaluate(tab => window.SillyBunnyShell.openTab('left', tab), tab);
    await page.locator(`button[data-sb-settings-tab="${tab}"]`).evaluate(button => button.click());
    const panel = page.locator(`[data-sb-panel="${tab}"]`);
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    return panel;
}

const openConnections = page => openPanel(page, 'connections');

/** @param {import('@playwright/test').Page} page */
const summaryOf = page => page.locator('#toast-container .toast-info:has(.sb-profile-switch-summary)');

/** @param {import('@playwright/test').Page} page @param {number} ms */
const sleep = (page, ms) => page.evaluate(ms => new Promise(resolve => setTimeout(resolve, ms)), ms);

/**
 * Starts listening for the profile load event of one profile name. Resolves once it fires.
 * @param {import('@playwright/test').Page} page
 * @param {string} name Profile name, or `<None>`
 * @returns {Promise<void>}
 */
function waitForProfileLoaded(page, name) {
    return page.evaluate(name => new Promise(resolve => {
        const { eventSource, eventTypes } = window.SillyTavern.getContext();
        const listener = loadedName => {
            if (loadedName !== name) return;
            eventSource.removeListener(eventTypes.CONNECTION_PROFILE_LOADED, listener);
            resolve();
        };
        eventSource.on(eventTypes.CONNECTION_PROFILE_LOADED, listener);
    }), name);
}

/**
 * Selects a profile by its option label and waits until the switch has applied.
 * @param {import('@playwright/test').Page} page
 * @param {string} name Option label
 * @param {{ picker?: string }} [options] Picker selector
 */
async function selectProfile(page, name, { picker = '#connection_profiles' } = {}) {
    const loaded = waitForProfileLoaded(page, name);
    await page.locator(picker).selectOption({ label: name });
    await loaded;
}

/**
 * Runs the `/profile` callback the way Quick Replies and scripts do.
 * @param {import('@playwright/test').Page} page
 * @param {object} args Named arguments
 * @param {string} name Profile name
 */
async function runProfileCommand(page, args, name) {
    await page.evaluate(async ({ args, name }) => {
        const { SlashCommandParser } = await import('/scripts/slash-commands/SlashCommandParser.js');
        await SlashCommandParser.commands['profile'].callback(args, name);
    }, { args, name });
}

/**
 * Waits for the one summary of a switch to a profile.
 * @param {import('@playwright/test').Page} page
 * @param {string} name Profile name shown as the title
 * @param {number} [timeout] How long the summary may take to appear
 */
async function expectSummaryFor(page, name, timeout = SUMMARY_TIMEOUT_MS) {
    const summary = summaryOf(page);
    await expect(summary.locator('.toast-title', { hasText: name })).toHaveCount(1, { timeout });
    await expect(summary).toHaveCount(1);
    await expect(summary.locator('.toast-title')).toHaveText(name);
}

/** Removes every toast at once, so the next assertion only sees what comes after. */
async function clearToasts(page) {
    await page.evaluate(() => window.toastr.remove());
    await expect(page.locator('#toast-container .toast')).toHaveCount(0);
}

/**
 * Applies a profile and waits for its summary, then clears the toasts: the starting state of a case.
 * @param {import('@playwright/test').Page} page
 * @param {string} name Profile name
 */
async function startFrom(page, name) {
    await selectProfile(page, name);
    await expectSummaryFor(page, name);
    await clearToasts(page);
}

/**
 * Records every attribute and child list write under an element for a while (bunny-preset-tools-idle-writes.e2e.js).
 * @param {import('@playwright/test').Page} page
 * @param {string} selector Element to watch
 * @param {number} ms How long to watch
 * @returns {Promise<string[]>} One line per mutation record
 */
function recordMutations(page, selector, ms) {
    return page.evaluate(async ({ selector, ms }) => {
        const records = [];
        const observer = new MutationObserver(list => records.push(...list));
        observer.observe(document.querySelector(selector), { attributes: true, childList: true, subtree: true });
        await new Promise(resolve => setTimeout(resolve, ms));
        observer.disconnect();
        return records.map(record => `${record.type} ${record.attributeName ?? ''} ${record.target.id || record.target.className}`.trim());
    }, { selector, ms });
}

/**
 * Starts recording every attribute and child list write under some elements, until `stopRecordingMutations`.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} selectors Elements to watch
 */
async function startRecordingMutations(page, selectors) {
    await page.evaluate(selectors => {
        window.sbMutationRecords = [];
        window.sbMutationObserver = new MutationObserver(list => window.sbMutationRecords.push(...list));
        for (const selector of selectors) {
            window.sbMutationObserver.observe(document.querySelector(selector), { attributes: true, childList: true, subtree: true });
        }
    }, selectors);
}

/**
 * Stops the recording `startRecordingMutations` started.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>} One line per mutation record, in the format of `recordMutations`
 */
function stopRecordingMutations(page) {
    return page.evaluate(() => {
        window.sbMutationRecords.push(...window.sbMutationObserver.takeRecords());
        window.sbMutationObserver.disconnect();
        return window.sbMutationRecords.map(record => `${record.type} ${record.attributeName ?? ''} ${record.target.id || record.target.className}`.trim());
    });
}

/**
 * Starts recording the title of every summary toast the page adds, each toast once (the shell can move the toast
 * container, which re-adds its toasts). Read the titles with `readSummaryTitles`.
 * @param {import('@playwright/test').Page} page
 */
async function recordSummaryTitles(page) {
    await page.evaluate(() => {
        const seen = new WeakSet();
        window.sbSummaryTitles = [];
        const collect = element => {
            const toasts = [element, ...element.querySelectorAll('.toast-info')].filter(toast => toast.matches('.toast-info'));
            for (const toast of toasts.filter(toast => !seen.has(toast) && toast.querySelector('.sb-profile-switch-summary'))) {
                seen.add(toast);
                window.sbSummaryTitles.push(toast.querySelector('.toast-title')?.textContent ?? '');
            }
        };
        new MutationObserver(list => list.forEach(record => record.addedNodes.forEach(node => node instanceof Element && collect(node))))
            .observe(document.body, { childList: true, subtree: true });
    });
}

/** @param {import('@playwright/test').Page} page @returns {Promise<string[]>} Titles recorded so far */
const readSummaryTitles = page => page.evaluate(() => window.sbSummaryTitles);

/**
 * Starts recording the text of every toast the page adds, each toast once. While a popup is open toastr keeps its
 * container inside the dialog, so a toast shown as a popup closes can leave with the dialog before a locator sees it.
 * Read the texts with `readToastTexts`.
 * @param {import('@playwright/test').Page} page
 */
async function recordToastTexts(page) {
    await page.evaluate(() => {
        const seen = new WeakSet();
        window.sbToastTexts = [];
        const collect = element => {
            const toasts = [element, ...element.querySelectorAll('.toast')].filter(toast => toast.matches('.toast') && !seen.has(toast));
            for (const toast of toasts) {
                seen.add(toast);
                window.sbToastTexts.push(toast.textContent ?? '');
            }
        };
        new MutationObserver(list => list.forEach(record => record.addedNodes.forEach(node => node instanceof Element && collect(node))))
            .observe(document.body, { childList: true, subtree: true });
    });
}

/** @param {import('@playwright/test').Page} page @returns {Promise<string[]>} Toast texts recorded so far */
const readToastTexts = page => page.evaluate(() => window.sbToastTexts);

/**
 * Holds every preset save for a while before it succeeds. Registered after `loadApp`, so it wins over its route.
 * @param {import('@playwright/test').Page} page
 * @param {number} ms How long each save is held
 */
async function delayPresetSaves(page, ms) {
    await page.route('**/api/presets/save', async route => {
        await new Promise(resolve => setTimeout(resolve, ms));
        await route.fulfill({ json: { name: route.request().postDataJSON()?.name ?? '' } });
    });
}

/**
 * Starts recording, as `performance.now()` times, the first `CHAT_CHANGED` and the first summary toast the page adds.
 * Stop and read the times with `stopRecordingSwitchTimes`.
 * @param {import('@playwright/test').Page} page
 */
async function startRecordingSwitchTimes(page) {
    await page.evaluate(() => {
        const { eventSource, eventTypes } = window.SillyTavern.getContext();
        const times = { chatChanged: null, summary: null };
        const onChatChanged = () => {
            times.chatChanged ??= performance.now();
        };
        const isSummaryToast = node => node instanceof Element
            && [node, ...node.querySelectorAll('.toast')].some(toast => toast.matches('.toast') && toast.querySelector('.sb-profile-switch-summary'));
        const observer = new MutationObserver(list => {
            if (times.summary === null && list.some(record => [...record.addedNodes].some(isSummaryToast))) {
                times.summary = performance.now();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
        window.sbSwitchTimes = {
            times,
            stop: () => {
                eventSource.removeListener(eventTypes.CHAT_CHANGED, onChatChanged);
                observer.disconnect();
            },
        };
    });
}

/** @param {import('@playwright/test').Page} page @returns {Promise<number | null>} Time of the first CHAT_CHANGED so far */
const readChatChangedTime = page => page.evaluate(() => window.sbSwitchTimes.times.chatChanged);

/**
 * Stops the recording `startRecordingSwitchTimes` started.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ chatChanged: number | null, summary: number | null }>} The recorded times, null when nothing came
 */
function stopRecordingSwitchTimes(page) {
    return page.evaluate(() => {
        window.sbSwitchTimes.stop();
        return window.sbSwitchTimes.times;
    });
}

/**
 * Reads the label texts of the open View popup.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>} Labels, trimmed
 */
async function readViewLabels(page) {
    await page.locator('#view_connection_profile').click();
    const scope = page.locator('dialog[open] .profile-summary-scope');
    await expect(scope).toBeVisible();
    await expect(page.locator('#connection_profile_details_content')).toBeHidden();
    return (await scope.locator('strong.profile-summary-label').allTextContents()).map(text => text.trim());
}

test('a picker switch shows one summary toast and saves no preset', async ({ page }) => {
    const { saves } = await loadApp(page);
    await openConnections(page);
    await selectProfile(page, 'CC_A');
    await expectSummaryFor(page, 'CC_A');
    await selectProfile(page, 'CC_B');
    await expectSummaryFor(page, 'CC_B');
    const summary = summaryOf(page);
    await expect(summary).toHaveCount(1);
    await expect(summary.locator('li')).toContainText(['Chat Completion Presets', 'Reasoning Effort']);
    await expect(summary.locator('li', { hasText: 'Chat Completion Presets' })).toHaveText(`Chat Completion Presets: Default → ${SECOND_PRESET}`);
    await expect(summary.locator('li', { hasText: 'Reasoning Effort' })).toHaveText('Reasoning Effort: High → Low');
    await sleep(page, AUTOSAVE_DELAY_MS + 700);
    expect(saves).toHaveLength(0);
});

test('Reload shows the summary beside the reloaded toast', async ({ page }) => {
    await loadApp(page);
    await openConnections(page);
    await startFrom(page, 'CC_A');
    const presets = await openPanel(page, 'prompting');
    await presets.locator('#openai_reasoning_effort').selectOption('low');
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/openai.js')).oai_settings.reasoning_effort)).toBe('low');
    await openConnections(page);
    await page.locator('#reload_connection_profile').click();
    await expect(page.locator('.toast-success', { hasText: 'Connection profile reloaded' })).toBeVisible();
    await expectSummaryFor(page, 'CC_A');
    await expect(summaryOf(page).locator('li')).toHaveText(['Reasoning Effort: Low → High']);
});

test('the mobile chat-tools picker reports', async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await loadApp(page);
    await page.evaluate(() => window.SillyBunnyShell.openChatTools());
    await expect(page.locator('.sb-mobile-chat-connection')).toBeVisible();
    await selectProfile(page, 'CC_B', { picker: '#sb-mobile-chat-connection-select' });
    await expectSummaryFor(page, 'CC_B');
    await expect(summaryOf(page).locator('li')).toContainText(['Reasoning Effort', 'Verbosity']);
});

test('/profile is silent and quiet=false reports', async ({ page }) => {
    test.slow(); // Two switches and a 4 s silent window.
    await loadApp(page);
    await runProfileCommand(page, { await: 'true' }, 'CC_B');
    await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().extensionSettings.connectionManager.selectedProfile)).toBe(CC_B.id);
    await sleep(page, SILENT_WAIT_MS);
    await expect(summaryOf(page)).toHaveCount(0);

    await runProfileCommand(page, { await: 'true', quiet: 'false' }, 'CC_A');
    await expectSummaryFor(page, 'CC_A');
    await expect(summaryOf(page).locator('li')).toContainText(['Reasoning Effort: Low → High', 'Verbosity: High → Low']);
});

test('<None>, the backend pill and a no-op switch show nothing', async ({ page }) => {
    test.slow(); // Four switches and two 4 s silent windows.
    await loadApp(page);
    await openConnections(page);
    await startFrom(page, 'CC_A');

    await selectProfile(page, '<None>');
    await selectProfile(page, 'CC_A');
    await selectProfile(page, 'CC_A');
    await sleep(page, SILENT_WAIT_MS);
    await expect(summaryOf(page)).toHaveCount(0);

    // A backend chosen by hand clears the profile and changes the backend; neither is a profile switch.
    await page.locator('.sb-backend-switch-button[data-sb-backend="text"]').click();
    await expect(page.locator('#connection_profiles')).toHaveValue('');
    await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().mainApi)).toBe('textgenerationwebui');
    await sleep(page, SILENT_WAIT_MS);
    await expect(summaryOf(page)).toHaveCount(0);
});

test('the card line sits in the card, hides with no profile and fits at 390px', async ({ page }) => {
    await loadApp(page);
    await openConnections(page);
    const line = page.locator('.sb-connections-profile .connection-profile-picker > #sb-connection-profile-sets');
    await expect(line).toHaveCount(1);
    await expect(page.locator('#connection_profiles')).toHaveValue('');
    await expect(line).toBeHidden();

    await selectProfile(page, 'CC_A');
    await expect(line).toBeVisible();
    await expect(line).toContainText('Reasoning Effort');
    await expect(line.locator('span')).toHaveAttribute('data-sb-profile-copy', 'true');

    await selectProfile(page, '<None>');
    await expect(line).toBeHidden();
    await expect(line).toBeEmpty();

    await selectProfile(page, 'CC_A');
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openConnections(page);
    await expect(line).toBeVisible();
    expect(await line.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

test('the Connections tab writes nothing while idle', async ({ page }) => {
    await loadApp(page);
    await openConnections(page);
    await selectProfile(page, 'CC_A');
    await expectSummaryFor(page, 'CC_A');
    await expect(page.locator('.sb-connections-profile')).toHaveCount(1);
    expect(await recordMutations(page, '.sb-connections-profile', 3000)).toEqual([]);
});

test('View opens a dialog with unique labels and no TC rows on a CC profile', async ({ page }) => {
    await loadApp(page);
    await openConnections(page);
    await selectProfile(page, 'CC_A');
    const labels = await readViewLabels(page);
    expect(labels).toContain('Reasoning Effort');
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain('Instruct Template');
    expect(labels).not.toContain('Context Template');
    expect(labels).not.toContain('System Prompt');
});

test('a regex-preset profile reports after the chat reload', async ({ page }) => {
    await loadApp(page);
    await openConnections(page);
    // CC_REGEX switches from SB Regex A to SB Regex B, whose script lists already match the live scripts. With a slow
    // save the Regex apply only ends with its chat reload, and the summary must come after that reload.
    await delayPresetSaves(page, REGEX_SAVE_DELAY_MS);
    await startRecordingSwitchTimes(page);
    await selectProfile(page, 'CC_REGEX');
    const summary = summaryOf(page);
    await expect(summary).toHaveCount(1, { timeout: 9000 });
    await expect(summary.locator('.toast-title')).toHaveText('CC_REGEX');
    await expect(summary.locator('li')).toContainText(['Regex Presets: SB Regex A → SB Regex B']);
    await expect.poll(() => readChatChangedTime(page)).toEqual(expect.any(Number));
    const times = await stopRecordingSwitchTimes(page);
    expect(times.summary).toBeGreaterThan(times.chatChanged);
});

test('content reloaded shows with autosave on and off', async ({ page }) => {
    test.slow(); // Two app loads.
    // Each load starts from empty browser storage, as a fresh test would: on a second load Quick Image Gen
    // finds the first load's browser-only settings and asks whether to import them.
    await page.addInitScript(() => window.localStorage.clear());
    for (const autosave of [true, false]) {
        await test.step(`autosave ${autosave}`, async () => {
            await page.unrouteAll({ behavior: 'ignoreErrors' });
            await loadApp(page, { autosave });
            await openConnections(page);
            await startFrom(page, 'CC_A');
            const presets = await openPanel(page, 'prompting');
            const prefix = presets.locator('#reasoning_prefix');
            await prefix.scrollIntoViewIfNeeded();
            await prefix.click();
            await page.keyboard.press('End');
            await page.keyboard.type(' edited');
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.reasoning.prefix)).toMatch(/ edited$/);
            await runProfileCommand(page, { await: 'true', quiet: 'false' }, 'CC_A');
            await expectSummaryFor(page, 'CC_A');
            const line = summaryOf(page).locator('li', { hasText: 'Reasoning Template' });
            await expect(line).toHaveCount(1);
            await expect(line.locator('[data-sb-profile-copy]')).toHaveText('(content reloaded)');
            await expect(prefix).not.toHaveValue(/ edited$/);
        });
    }
});

test('rapid A then B shows one toast for B', async ({ page }) => {
    await loadApp(page);
    await openConnections(page);
    await recordSummaryTitles(page);
    const loaded = waitForProfileLoaded(page, 'CC_B');
    const picker = page.locator('#connection_profiles');
    await picker.selectOption({ label: 'CC_A' });
    await picker.selectOption({ label: 'CC_B' });
    await loaded;
    await expectSummaryFor(page, 'CC_B');
    // B carries A's BEFORE forward (spec 4.3), so the lines run from the fresh-load values, not from CC_A's.
    const summary = summaryOf(page);
    await expect(summary.locator('li', { hasText: 'Reasoning Effort' })).toHaveText('Reasoning Effort: None → Low');
    await expect(summary.locator('li', { hasText: 'Verbosity' })).toHaveText('Verbosity: Auto → High');
    await sleep(page, SILENT_WAIT_MS);
    await expect(summary).toHaveCount(1);
    await expect(summary.locator('.toast-title')).toHaveText('CC_B');
    expect(await readSummaryTitles(page)).toEqual(['CC_B']);
});

test('a CC switch with a dirty editor draft does not throw', async ({ page }) => {
    test.slow(); // The guard holds the preset step for up to 10 s.
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await loadApp(page);
    const editor = await openPanel(page, 'editor');
    const firstPrompt = editor.locator('.sb-prompt-order .sb-prompt-row').first();
    await expect(firstPrompt).toHaveAttribute('data-prompt-id', 'main');
    await firstPrompt.locator('.sb-prompt-row-name').click();
    const content = editor.locator('.sb-prompt-textarea');
    await content.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' draft');
    await expect(editor.locator('.sb-prompt-dirty')).toBeVisible();

    // CC_B changes the Chat Completion preset, so #870's prompt-editor guard asks about the draft during the switch
    // (spec Section 8: it can hold the preset step for up to 10 s, cancel it, or replay it). Cancel keeps the draft and
    // cancels the preset step; the switch still finishes and reports. The picker is used from the Editor tab, because
    // leaving that tab with a draft asks as well.
    const guards = [];
    await page.addLocatorHandler(page.locator('dialog.popup[open]', { hasText: 'Unsaved changes' }), async dialog => {
        guards.push(await dialog.locator('.popup-button-cancel').textContent());
        await dialog.locator('.popup-button-cancel').click();
    });
    const loaded = waitForProfileLoaded(page, 'CC_B');
    // eslint-disable-next-line playwright/no-force-option -- the picker sits on the hidden Connections tab (see above).
    await page.locator('#connection_profiles').selectOption({ label: 'CC_B' }, { force: true });
    await expectSummaryFor(page, 'CC_B', GUARDED_SUMMARY_TIMEOUT_MS);
    await loaded;
    expect(guards).toEqual(['Cancel']);
    await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
    await expect(editor.locator('.sb-prompt-dirty')).toBeVisible();
    await expect(summaryOf(page).locator('li')).toContainText(['Reasoning Effort: None → Low']);
    expect(errors).toEqual([]);
});

test('names render literally in the toast', async ({ page }) => {
    await loadApp(page);
    await openConnections(page);
    await selectProfile(page, '<b>x</b>');
    const summary = summaryOf(page);
    await expect(summary).toHaveCount(1, { timeout: SUMMARY_TIMEOUT_MS });
    await expect(summary.locator('.toast-title')).toHaveText('<b>x</b>');
    await expect(summary.locator('b')).toHaveCount(0);
    await expect(summary.locator('li', { hasText: 'Start Reply With' })).toHaveText('Start Reply With: <Empty> → <u>y</u>');
    await expect(summary.locator('li u')).toHaveCount(0);
});

test('a TC profile with instruct on shows one Instruct Template row and no snapshot duplicate', async ({ page }) => {
    await loadApp(page);
    await openConnections(page);
    await selectProfile(page, 'TC_A');
    const labels = await readViewLabels(page);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.filter(label => label === 'Instruct Template')).toHaveLength(1);
    expect(labels).not.toContain('System Prompt');
});

test('a Text Completions to Chat Completions switch reports the Chat Completions lines', async ({ page }) => {
    test.slow(); // Two switches across backends, each waiting for its summary.
    await loadApp(page);
    await openConnections(page);
    await startFrom(page, 'TC_A');
    await selectProfile(page, 'CC_A');
    await expectSummaryFor(page, 'CC_A');
    const summary = summaryOf(page);
    await expect(summary.locator('li', { hasText: 'Reasoning Effort' })).toHaveText('Reasoning Effort: None → High');
    await expect(summary.locator('li', { hasText: 'Verbosity' })).toHaveText('Verbosity: Auto → Low');
});

test('legacy exclude entries survive View and Edit', async ({ page }) => {
    await loadApp(page, { profiles: [...PROFILES, CC_LEGACY] });
    await openConnections(page);
    await selectProfile(page, 'CC_LEGACY');

    await page.locator('#view_connection_profile').click();
    const view = page.locator('dialog[open]', { has: page.locator('.profile-summary-scope') });
    await expect(view.locator('div.margin5', { hasText: 'Omitted Settings:' }).locator('span')).toHaveText('Instruct Template, System Prompt, sb-unknown');
    await view.locator('.popup-button-ok').click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);

    await page.locator('#edit_connection_profile').click();
    const edit = page.locator('dialog[open]', { has: page.locator('input[name="exclude"]') });
    await expect(edit).toBeVisible();
    await recordToastTexts(page);
    await edit.locator('.popup-button-ok', { hasText: /^Save$/ }).click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await sleep(page, EDIT_TOAST_WAIT_MS);
    expect((await readToastTexts(page)).filter(text => text.includes('Included settings list updated'))).toEqual([]);
    const exclude = await page.evaluate(id => window.SillyTavern.getContext().extensionSettings.connectionManager.profiles.find(item => item.id === id).exclude, CC_LEGACY.id);
    expect(exclude).toEqual(CC_LEGACY.exclude);
});

test('a same-override-set switch writes nothing to the card line', async ({ page }) => {
    await loadApp(page);
    await openConnections(page);
    await selectProfile(page, 'CC_A');
    await expectSummaryFor(page, 'CC_A');
    await expect(page.locator('#sb-connection-profile-sets')).toBeVisible();
    // CC_B applies the same override ids as CC_A, so neither the card line nor the hidden details need a write. The
    // whole card is not watched: upstream's toggleProfileSpecificButtons rewrites aria-disabled on its buttons.
    await startRecordingMutations(page, ['#sb-connection-profile-sets', '#connection_profile_details_content']);
    await selectProfile(page, 'CC_B');
    await expectSummaryFor(page, 'CC_B');
    expect(await stopRecordingMutations(page)).toEqual([]);
});

test('a same-id regex reapply with a slow save still reports the scoped change', async ({ page }) => {
    test.slow(); // The Regex apply holds on a 1.8 s preset save.
    await loadApp(page);
    await openConnections(page);
    // SB Regex B, which CC_REGEX applies, is already selected and shown, and it enables a scoped script that is disabled
    // on the bundled character: the switch reapplies the same preset id and only the scoped script changes.
    await page.evaluate(async ({ presetId, script }) => {
        const { characters, setCharacterId } = await import('/script.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        setCharacterId(0);
        characters[0].data.extensions.regex_scripts = [{ ...script }];
        extension_settings.regex_presets.find(preset => preset.id === presetId).scoped = [{ id: script.id }];
        extension_settings.regex_presets.forEach(preset => {
            preset.isSelected = preset.id === presetId;
        });
        document.getElementById('regex_presets').value = presetId;
    }, { presetId: REGEX_PRESET_B.id, script: SCOPED_REGEX_SCRIPT });
    // The Regex apply saves the completion preset's scripts before the scoped ones, so the scoped script stays disabled
    // until this save returns.
    await delayPresetSaves(page, REGEX_SAVE_DELAY_MS);
    await selectProfile(page, 'CC_REGEX');
    const summary = summaryOf(page).filter({ has: page.locator('.toast-title', { hasText: 'CC_REGEX' }) });
    await expect(summary.locator('li', { hasText: 'Regex Presets' })).toHaveText('Regex Presets (content reloaded)', { timeout: SUMMARY_TIMEOUT_MS });
    const scopedDisabled = await page.evaluate(async () => (await import('/script.js')).characters[0].data.extensions.regex_scripts[0].disabled);
    expect(scopedDisabled).toBe(false);
});
