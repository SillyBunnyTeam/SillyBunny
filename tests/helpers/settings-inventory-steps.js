/**
 * The Playwright half of the settings inventory: boot a page with nothing able to reach a real settings save, open a section,
 * collect its controls, reach each one, and change a value through the control the user sees while reading what the app
 * would save. A second module holds the half that runs in the page.
 */

import { gunzipSync } from 'node:zlib';
import { bootSurfaceApp, openSurface, readySelectors } from './surfaces/boot.js';
import { settle, expandAll } from './surfaces/steps.js';
import { installInventoryApi } from './settings-inventory-collect.js';
import { diffSettings, driftPaths, getPath, nextNumber, sameValue, textCandidates } from './settings-inventory.js';
import { isIgnoredPath, readyExtrasFor } from './settings-inventory-rules.js';

export const EXTENSIONS_PANEL = '[data-sb-panel="extensions"]';
export const EXTENSION_DETAIL = `${EXTENSIONS_PANEL} .sb-subpage-detail[aria-hidden="false"]`;

/**
 * The delay of the app's debounced save: `saveSettingsDebounced` waits `DEFAULT_SAVE_EDIT_TIMEOUT` (public/script.js), which is
 * `debounce_timeout.relaxed`, 1000 ms (public/scripts/constants.js). A control that saves by itself has saved within it.
 */
export const SAVE_DEBOUNCE_MS = 1000;
/** How long a change is watched for a save of the app's own, with no forced save: the debounce and a margin for a slow page. */
export const SAVE_WATCH_MS = SAVE_DEBOUNCE_MS + 600;

/** Writes that a page makes on its own, which say nothing about the control that was changed. */
const BACKGROUND_REQUESTS = /^POST \/api\/(?:settings\/(?:get|save)|users\/me|characters\/(?:all|chats)|groups\/all|backgrounds\/all|avatars\/get|stats\/update|tokenizers\/[\w-]+\/(?:encode|decode|count)|chats\/(?:group\/)?(?:get|search)|extensions\/discover|assets\/get)$/;

/** The outbound endpoints. A value change must not reach them from a test, so they answer as an unreachable backend would. */
const OUTBOUND = /\/api\/(?:backends|novelai|horde|openai|openrouter|nanogpt|anthropic|google|speech|azure|volcengine|minimax|sd|translate|search|extra|vector)\//;

/**
 * The writes of the server admin API. They change files outside the data root (config.yaml of the checkout the server runs from),
 * which the guard of the boot does not cover, so they are answered here.
 */
const SERVER_ADMIN_WRITES = /\/api\/server-admin\/(?!(?:install-type|status|logs|branches|server-plugins\/capabilities|config\/get|config\/[a-z-]+\/get)$)/;

/**
 * The reads that the Data & Security page builds itself from, answered with fixed data: what the real ones say depends on the git
 * state of the checkout that the server runs from (whether an update is ready, which branches exist) and on its config.yaml.
 */
const SERVER_ADMIN_FIXED = Object.freeze({
    '/api/server-admin/status': {
        runtime: 'Node.js',
        configPath: 'config.yaml',
        installType: 'git',
        version: { pkgVersion: '0.0.0', gitBranch: 'staging', gitRevision: 'aaaaaaa' },
        repository: {
            supported: true, isRepo: true, branch: 'staging', displayBranch: 'staging', currentCommit: 'aaaaaaa', trackingBranch: 'origin/staging',
            ahead: 0, behind: 1, canUpdate: true, hasLocalChanges: false, autoStash: false, changedFilesCount: 0, changedFiles: [], message: 'An update is ready.',
        },
    },
    '/api/server-admin/branches': { branches: ['release', 'staging'] },
    '/api/server-admin/config/get': { path: 'config.yaml', content: 'listen: false\n', lastModifiedMs: 1 },
});

function readPayload(request) {
    const buffer = request.postDataBuffer();
    return JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(buffer) : buffer).toString());
}

/** Waits until `condition()` holds, polling in short steps; resolves to whether it did within `timeout`. */
async function poll(condition, timeout, interval = 50) {
    for (const end = Date.now() + timeout; Date.now() < end;) {
        if (condition()) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    return condition();
}

/** How long no new request may arrive before the requests of a change are taken as complete. */
const REQUEST_QUIET_MS = 500;

/** Resolves once `read()` has stayed the same for `quiet` ms, and gives up after four times as long. */
async function untilQuiet(read, quiet) {
    let last = read();
    let since = Date.now();
    for (const end = Date.now() + quiet * 4; Date.now() < end && Date.now() - since < quiet;) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const now = read();
        if (now !== last) {
            last = now;
            since = Date.now();
        }
    }
}

/**
 * Waits until the page has stopped writing to the server for a while: a module that saves on its own debounce can do it seconds after the
 * control that caused it, when the next section is already open and its first control would be given the write.
 */
export const settleRequests = recorder => untilQuiet(() => recorder.requests.length, SECTION_QUIET_MS);

const SECTION_QUIET_MS = 1500;

/** Lets the page run its microtasks and paint twice: what an `input` handler that awaits something has finished by then. */
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/**
 * Waits until the number of elements that match `selector` has stayed the same for `count` animation frames: a container mounts its
 * rows and controls over several frames after its page opens, and nothing else says when it is done.
 */
function waitForStableCount(page, selector, count = 30) {
    return page.waitForFunction(({ selector: target, count: needed }) => {
        const state = window.__sbInventoryStable ?? (window.__sbInventoryStable = { target: '', last: -1, same: 0 });
        const now = document.querySelectorAll(target).length;
        state.same = state.target === target && state.last === now ? state.same + 1 : 0;
        state.target = target;
        state.last = now;
        return state.same >= needed;
    }, { selector, count }, { polling: 'raf', timeout: 30_000 });
}

/**
 * Boots the app the way the surface audits do (a throwaway server, every write stubbed) and keeps what the
 * page tries to save. Nothing that is saved leaves the page; the outbound endpoints answer 503.
 * @param {import('@playwright/test').Page} page
 * @param {string} baseURL
 * @param {{ needs?: readonly string[], viewport: string, mode?: 'record' | 'check' }} options
 */
export async function bootInventoryPage(page, baseURL, { needs = [], viewport, mode = 'check' }) {
    await page.route(OUTBOUND, route => route.fulfill({ status: 503, json: { error: 'blocked by the settings inventory' } }));
    await page.route(SERVER_ADMIN_WRITES, route => route.fulfill({ json: { ok: true, restarting: false } }));
    await page.route(/\/api\/server-admin\/(?:status|branches|config\/get)$/, route => route.fulfill({ json: SERVER_ADMIN_FIXED[new URL(route.request().url()).pathname] }));
    await bootSurfaceApp(page, baseURL, { variant: { viewport }, needs });

    const recorder = { settings: null, saves: 0, requests: [], mode };
    await page.route('**/api/settings/save', route => {
        recorder.settings = readPayload(route.request());
        recorder.saves++;
        return route.fulfill({ json: { result: 'ok', version: (recorder.settings._version ?? 0) + 1 } });
    });
    page.on('request', request => {
        const { pathname } = new URL(request.url());
        const label = `${request.method()} ${pathname}`;
        if (pathname.startsWith('/api/') && request.method() !== 'GET' && !BACKGROUND_REQUESTS.test(label)) {
            recorder.requests.push(label);
        }
    });
    await page.waitForFunction(async () => (await import('/script.js')).settingsReady, null, { timeout: 60_000 });
    const secretNames = await page.evaluate(async () => Object.values((await import('/scripts/secrets.js')).SECRET_KEYS));
    await page.evaluate(installInventoryApi, { secretNames, saveDelay: SAVE_DEBOUNCE_MS });
    await primeBaseline(page, recorder);
    return recorder;
}

/** Waits until no debounced save of the app is still waiting for its timer; the save it makes lands in the recorder. */
const drainSaves = page => page.waitForFunction(() => window.__sbInventory.savesPending() === 0, null, { polling: 50, timeout: SAVE_WATCH_MS }).catch(() => {});

/** Asks the app to save now, so that a change is read without waiting for the debounce. A save that changes nothing sends no request. */
export async function flushSettings(page) {
    await page.evaluate(async () => {
        const app = await import('/script.js');
        await app.saveSettings(0, { returnResult: true });
    });
}

/**
 * Gets the settings that the page holds into the recorder. A page that has changed nothing since it loaded sends no request, so a
 * value that lives only in the saved object is added and taken away again, which makes two saves of the page's own state.
 */
async function primeBaseline(page, recorder) {
    // Extensions fill in their defaults on the first saves after the page is ready, so the baseline is the settings of a round
    // that changed nothing from the round before.
    let previous = null;
    for (let round = 0; round < 8; round++) {
        await page.evaluate(async () => {
            const { extension_settings: extensionSettings } = await import('/scripts/extensions.js');
            const app = await import('/script.js');
            extensionSettings.__sbInventoryProbe = Date.now();
            await app.saveSettings(0, { returnResult: true });
            delete extensionSettings.__sbInventoryProbe;
            await app.saveSettings(0, { returnResult: true });
        });
        await frames(page);
        await flushSettings(page);
        const current = recorder.settings;
        if (!current || current.extension_settings?.__sbInventoryProbe !== undefined) {
            throw new Error('The settings of the page could not be read: the baseline save did not arrive.');
        }
        if (previous && diffSettings(previous, current).length === 0) {
            // A save that the page's own debounce still holds would land inside the first change that is watched.
            await drainSaves(page);
            await frames(page);
            return;
        }
        previous = current;
    }
    throw new Error(`The saved settings of the page did not settle after 8 rounds; the last still changed ${diffSettings(previous, recorder.settings).slice(0, 5).join(', ')}.`);
}

const readStorage = page => page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));

function diffStorage(before, after) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => before[key] !== after[key]).sort();
}

/**
 * Runs `change` and reports where the change landed: the paths of the saved settings that differ, the local storage keys that
 * changed, and the writes to the server (every other write is answered by the guard).
 *
 * With `watch`, the change is first given SAVE_WATCH_MS to be saved by the app itself, with no forced save: `saveSettings()` writes
 * what is in memory, so a row that sets a value in memory and never asks for a save would still show its key after a forced one.
 * The change starts once no earlier debounced save is pending, because that one would fire inside the watch and carry the value.
 * `selfSaves` says that a save arrived by itself and held a key of the change. The state that the report reads is the one after a
 * forced save, which also finds what a module keeps until its own save.
 * @param {import('@playwright/test').Page} page
 * @param {{ settings: any, saves: number, requests: string[] }} recorder What `bootInventoryPage()` returned.
 * @param {() => Promise<void>} change
 * @param {{ watch?: boolean }} [options]
 */
export async function observeChange(page, recorder, change, { watch = false } = {}) {
    await drainSaves(page);
    await flushSettings(page);
    const before = recorder.settings;
    const storage = await readStorage(page);
    const requests = recorder.requests.length;
    const saves = recorder.saves;
    await change();
    let selfSettings = null;
    if (watch && await poll(() => recorder.saves > saves, SAVE_WATCH_MS)) {
        await frames(page);
        selfSettings = recorder.settings;
    }
    await dismissOpenedDialogs(page);
    await flushSettings(page);
    await frames(page);
    await flushSettings(page);
    // A module may save its own part after its own debounce, so a change that has not been saved at all is waited for, once.
    if (!watch && recorder.saves === saves && await poll(() => recorder.saves > saves, SAVE_WATCH_MS)) {
        await flushSettings(page);
    }
    // A request that a change makes late (a module saves on its own debounce) is waited for, so that it is not taken for the next control's.
    if (recorder.requests.length > requests) {
        await untilQuiet(() => recorder.requests.length, REQUEST_QUIET_MS);
    }
    const keys = diffSettings(before, recorder.settings).filter(path => !isIgnoredPath(path));
    const selfPaths = selfSettings ? diffSettings(before, selfSettings) : [];
    return {
        keys,
        selfSaves: keys.some(key => selfPaths.includes(key)),
        storage: diffStorage(storage, await readStorage(page)),
        requests: [...new Set(recorder.requests.slice(requests))].sort(),
        settings: recorder.settings,
        before,
    };
}

/** Remembers the dialogs that are open, so that a dialog that a control opens can be told from the page the control is on. */
export const markOpenDialogs = page => page.evaluate(() => window.__sbInventory.markDialogs());

/**
 * Closes the dialogs that opened since `markOpenDialogs()` (a confirmation that a control asks for), so that one of them does not
 * cover every control that follows. Escape is a cancel in the app's dialogs.
 */
export async function dismissOpenedDialogs(page) {
    for (let attempt = 0; attempt < 4; attempt++) {
        if (!await page.evaluate(() => window.__sbInventory.openedDialogs())) {
            return;
        }
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !window.__sbInventory.openedDialogs(), null, { timeout: 2000 }).catch(() => {});
    }
}

/**
 * Opens a section of the inventory and returns its root selector.
 * @param {import('@playwright/test').Page} page
 * @param {{ surface: any, backend?: string, stateId?: string, viewport: string }} target
 */
export async function openSection(page, { surface, backend, stateId, viewport }) {
    const options = { backend, viewport };
    const root = await openSurface(page, surface, { ...options, stateId });
    for (const selector of readySelectors(surface, { ...options, stateId })) {
        await page.locator(selector).first().waitFor({ state: 'visible', timeout: 15_000 });
    }
    for (const selector of readyExtrasFor(surface.id)) {
        await page.locator(selector).first().waitFor({ state: 'attached', timeout: 30_000 });
    }
    return root;
}

/** The element that scrolls a section, for `expandAll()`: the panel's scroller for a shell page, the root itself otherwise. */
export const scrollerOf = root => (/^\[data-sb-panel="[^"]+"\]$/.test(root) ? `${root} .sb-shell-panel-scroller` : root);

/**
 * Collects the controls of a section twice: as the page opens, and once every expander is open.
 * @param {import('@playwright/test').Page} page
 * @param {string} root
 * @param {string[]} [skip] Selectors of data-driven lists that are not part of the inventory.
 */
export async function collectSection(page, root, skip = []) {
    await settle(page, { root });
    const before = await page.evaluate(({ root, skip }) => window.__sbInventory.collect(root, { skip }), { root, skip });
    await expandAll(page, scrollerOf(root));
    await waitForAnimations(page, root);
    await settle(page, { root });
    const after = await page.evaluate(({ root, skip }) => window.__sbInventory.collect(root, { skip }), { root, skip });
    return { before, after };
}

/**
 * Waits until nothing under `root` is animating. A drawer that opens by a jQuery slide clips what it holds to the height that it has
 * reached, and a control below that height is not shown yet.
 */
export function waitForAnimations(page, root) {
    return page.evaluate(async scope => {
        const node = document.querySelector(scope);
        const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const busy = () => (window.jQuery ? window.jQuery(node).find(':animated').length : 0) + (node?.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length ?? 0);
        const deadline = Date.now() + 8000;
        for (let quiet = 0; quiet < 3 && Date.now() < deadline;) {
            await frame();
            quiet = busy() === 0 ? quiet + 1 : 0;
        }
    }, root);
}

/**
 * Lists the rows of the Extensions page once the list has stopped growing (a container mounts its settings long after the panel opens).
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ container: string, title: string }[]>}
 */
export async function listExtensionRows(page) {
    await waitForStableCount(page, `${EXTENSIONS_PANEL} [data-sb-subpage-row]`);
    return page.evaluate(panel => [...document.querySelectorAll(`${panel} [data-sb-subpage-row]`)].map(row => ({
        container: row.getAttribute('data-sb-subpage-row'),
        title: (row.querySelector('.sb-subpage-row-title')?.textContent ?? row.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    })), EXTENSIONS_PANEL);
}

/** Opens the settings subpage of one extension from the Extensions page and waits until it has built its controls. */
export async function openExtensionSubpage(page, container) {
    const row = page.locator(`${EXTENSIONS_PANEL} [data-sb-subpage-row="${container}"]`);
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await page.locator(EXTENSION_DETAIL).waitFor({ state: 'visible' });
    await settle(page, { root: EXTENSION_DETAIL });
    // Some extensions fill their page after it opens.
    await waitForStableCount(page, `${EXTENSION_DETAIL} :is(input, select, textarea, button)`);
    return EXTENSION_DETAIL;
}

/** The values that a select offers, as the page holds it. */
export const sourcesOf = (page, selector) => page.evaluate(target => [...document.querySelector(target).options].map(option => option.value).filter(Boolean), selector);

/**
 * Chooses a provider on the Connections page the way the surface audits choose a backend's source, and says whether the page took it.
 * A page that throws while it shows a provider that has no connection (Ollama does without a model) is reported, not used.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function selectSource(page, selector, value, root) {
    const errors = [];
    const onError = error => errors.push(error.message);
    page.on('pageerror', onError);
    try {
        await page.evaluate(({ target, wanted }) => window.$(target).val(wanted).trigger('change'), { target: selector, wanted: value });
        await frames(page);
        await settle(page, { root });
    } finally {
        page.off('pageerror', onError);
    }
    if (errors.length) {
        return { ok: false, reason: `choosing "${value}" throws without a connection: ${errors[0].split('\n')[0]}` };
    }
    const held = await page.evaluate(({ target, wanted }) => document.querySelector(target).value === wanted, { target: selector, wanted: value });
    return held ? { ok: true } : { ok: false, reason: `the select does not keep "${value}"` };
}

/** Leaves the open extension subpage. */
export async function closeExtensionSubpage(page) {
    await page.locator(`${EXTENSION_DETAIL} .sb-subpage-back`).click();
    await page.locator(`${EXTENSIONS_PANEL} .sb-subpage-detail[aria-hidden="true"]`).first().waitFor({ state: 'attached' });
    await page.locator(EXTENSION_DETAIL).waitFor({ state: 'detached' });
    await settle(page, { root: EXTENSIONS_PANEL });
}

const TARGET = '[data-sb-inventory-target="control"]';
const DRIVER = '[data-sb-inventory-target="driver"]';

/**
 * Tags a control and returns what is known of it, or `{ found: false }`.
 * @param {import('@playwright/test').Page} page
 * @param {string} root
 * @param {string} identity
 * @param {{ skip?: string[], anywhere?: boolean }} [options]
 */
export function markControl(page, root, identity, { skip = [], anywhere = false } = {}) {
    return page.evaluate(({ root, identity, skip, anywhere }) => window.__sbInventory.mark(root, identity, { skip, anywhere }), { root, identity, skip, anywhere });
}

/**
 * Scrolls the marked control into view and reads its box and what is at its centre.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ width: number, height: number, disabled: boolean, covered: boolean, coveredBy?: string, inViewport: boolean }>}
 */
export function reachMarked(page) {
    return page.evaluate(async () => {
        const driver = document.querySelector('[data-sb-inventory-target="driver"]') ?? document.querySelector('[data-sb-inventory-target="control"]');
        driver?.scrollIntoView({ block: 'center', inline: 'center' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return window.__sbInventory.reach();
    });
}

const valueOfMarked = page => page.evaluate(() => window.__sbInventory.valueOf());

/** The locator of what the user operates: the visible element that drives the control, else the control itself. */
const operated = (page, via) => page.locator(via && via !== 'self' ? DRIVER : TARGET);

const ACTION = { timeout: 4000 };

async function pickFromPicker(page, label, occurrence) {
    const option = page.locator('.sb-picker:visible .sb-picker__option, .sb-picker-sheet:visible .sb-picker__option')
        .filter({ has: page.locator('.sb-picker__label', { hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }) });
    await option.nth(occurrence).click(ACTION);
}

/**
 * Chooses an option of the marked select through the control that the user sees: the native select, the button of a select row,
 * or a select2 box.
 */
async function chooseOption(page, via, option) {
    if (via === 'self') {
        await page.locator(TARGET).selectOption(option.value, ACTION);
    } else if (via === 'select-row') {
        await page.locator(DRIVER).click(ACTION);
        await pickFromPicker(page, option.label, option.occurrence);
    } else if (via === 'select2') {
        await page.locator(`${DRIVER} .select2-selection`).first().click(ACTION);
        await page.locator('.select2-results__option', { hasText: option.label }).nth(option.occurrence).click(ACTION);
    } else {
        throw new Error(`a select driven by ${via} cannot be operated`);
    }
}

/** Which of the select's options that have this label this one is, since a picker is found by label. */
function withOccurrence(options, chosen) {
    return { ...chosen, occurrence: options.filter(option => option.label === chosen.label).findIndex(option => option.value === chosen.value) };
}

/** Marks the control again, because a page may build its rows again when a value changes. Returns how the control is driven. */
async function remark(page, ctx, identity) {
    const marked = await markControl(page, ctx.root, identity, { skip: ctx.skip });
    if (!marked.found || !marked.shown) {
        throw new Error(`${identity} is not shown after the change`);
    }
    return marked.via;
}

/**
 * Changes the marked control through the control the user sees, reads where the change landed, changes it back, and checks the
 * saved settings are the ones they were. The control must already be marked and scrolled into view.
 * @param {import('@playwright/test').Page} page
 * @param {any} recorder
 * @param {{ identity: string, kind: string, multiple?: boolean, keyboard?: boolean }} control `keyboard: false` says a range ignores the arrow keys.
 * @param {string | null} via How the control is driven, from `markControl()`.
 * @param {{ root: string, skip: string[] }} ctx Where the control is, to mark it again.
 * @returns {Promise<{ keys: string[], selfSaves: boolean, storage: string[], requests: string[], keyboard?: boolean, problem?: string, restoreProblem?: string, drift?: string[] }>}
 * `drift` lists the saved settings that were not as they had been once the value was put back. The limits of a number or a range are
 * read from the live element, so that a control that states the same limits as before passes whatever it is built from.
 */
export async function roundTrip(page, recorder, control, via, ctx) {
    const { kind } = control;
    const nothing = problem => ({ keys: [], selfSaves: false, storage: [], requests: [], problem });
    if (control.multiple) {
        return nothing('a multiple select is not round-tripped');
    }
    await markOpenDialogs(page);
    const original = await valueOfMarked(page);
    const limits = ['number', 'range', 'text', 'textarea'].includes(kind) ? await page.evaluate(() => window.__sbInventory.limits()) : {};
    const operate = async work => work(page.locator(await remark(page, ctx, control.identity).then(next => (next && next !== 'self' ? DRIVER : TARGET))));
    const watched = change => observeChange(page, recorder, change, { watch: true });
    let undo = null;
    let landed;
    let keyboard;
    try {
        if (kind === 'switch' || kind === 'checkbox') {
            undo = () => operate(locator => locator.click(ACTION));
            landed = await watched(() => operated(page, via).click(ACTION));
        } else if (kind === 'select') {
            const options = await page.evaluate(() => window.__sbInventory.selectOptions());
            const target = options.find(option => option.value !== original && option.label !== '' && !option.selected);
            const back = options.find(option => option.value === original);
            if (!target) {
                return nothing('the select has no other option to choose');
            }
            undo = async () => {
                const next = await remark(page, ctx, control.identity);
                if (back && (next === 'self' || back.label !== '')) {
                    await chooseOption(page, next, withOccurrence(options, back));
                } else {
                    // An option with no label cannot be picked from a row's list; the native select puts it back.
                    await page.locator(TARGET).evaluate((select, value) => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }, original);
                }
            };
            landed = await watched(() => chooseOption(page, via, withOccurrence(options, target)));
        } else if (kind === 'number' || kind === 'text' || kind === 'textarea') {
            const candidates = kind === 'number' ? [nextNumber(original, limits)] : textCandidates(original, limits);
            if (candidates[0] === null) {
                return nothing('the number has no other value inside its limits');
            }
            const type = value => locator => async () => {
                await locator.fill(value, ACTION);
                await locator.press('Tab', ACTION);
            };
            undo = () => operate(locator => type(String(original ?? ''))(locator)());
            for (const [index, next] of candidates.entries()) {
                landed = await watched(async () => {
                    await type(next)(operated(page, via))();
                    const held = kind === 'number' ? await valueOfMarked(page) : next;
                    if (!sameValue(kind, held, next)) {
                        throw new Error(`${next} was typed and the control holds ${held}: it limits its values differently from the range it states (${limits.min ?? 'no minimum'} to ${limits.max ?? 'no maximum'}, step ${limits.step ?? 'none'})`);
                    }
                });
                // A request is not a reason to stop: a panel that autosaves its preset sends one at a time that varies from run to run.
                if (landed.keys.length || landed.storage.length || index === candidates.length - 1) {
                    break;
                }
                // Nothing was saved for this value; put the original back before a value in another format is tried.
                await observeChange(page, recorder, undo);
            }
        } else if (kind === 'range') {
            const up = Number(original) < Number(limits.max ?? 100);
            // A value that is not on a step cannot be reached again by the arrow keys, so it is put back as it was typed.
            undo = () => operate(locator => locator.fill(String(original), ACTION));
            landed = await watched(async () => {
                keyboard = false;
                if (control.keyboard !== false) {
                    await operated(page, via).focus(ACTION);
                    await operated(page, via).press(up ? 'ArrowRight' : 'ArrowLeft', ACTION);
                    keyboard = !sameValue(kind, await valueOfMarked(page), original);
                    if (!keyboard && control.keyboard === true) {
                        throw new Error('the range no longer changes with the arrow keys, and it was recorded as operable by the keyboard');
                    }
                }
                if (!keyboard) {
                    const next = nextNumber(original, limits);
                    if (next !== null) {
                        await operated(page, via).fill(next, ACTION);
                    }
                }
            });
        } else if (kind === 'radio') {
            const peer = await page.evaluate(({ root, skip }) => window.__sbInventory.radioPeer(root, { skip }), ctx);
            if (!peer?.other) {
                return nothing('the radio has no other member in its group');
            }
            const clickIdentity = identity => async () => {
                const next = await remark(page, ctx, identity);
                await operated(page, next).click(ACTION);
            };
            if (original === true) {
                undo = clickIdentity(control.identity);
                landed = await watched(clickIdentity(peer.other));
            } else if (peer.on) {
                undo = clickIdentity(peer.on);
                landed = await watched(() => operated(page, via).click(ACTION));
            } else {
                return nothing('no member of the radio group is on, so it cannot be put back');
            }
        } else {
            return nothing(`${kind} is not round-tripped`);
        }
    } catch (error) {
        // A change that failed half way may have left the control changed; put it back before the next control is tried.
        await observeChange(page, recorder, undo ?? (async () => {})).catch(() => {});
        return nothing(String(error.message).split('\n')[0]);
    }

    const result = { keys: landed.keys, selfSaves: landed.selfSaves, storage: landed.storage, requests: landed.requests, ...(keyboard !== undefined && { keyboard }) };
    try {
        await remark(page, ctx, control.identity);
        if (kind !== 'radio' && sameValue(kind, await valueOfMarked(page), original)) {
            result.problem = 'the control did not take the new value';
        }
    } catch (error) {
        result.problem = String(error.message).split('\n')[0];
        return result;
    }
    try {
        const restored = await observeChange(page, recorder, undo);
        await remark(page, ctx, control.identity);
        const after = await valueOfMarked(page);
        if (!sameValue(kind, after, original)) {
            result.restoreProblem = `the value is ${JSON.stringify(after)} after it was put back, not ${JSON.stringify(original)}`;
        }
        const drift = driftPaths(landed.before, restored.settings).filter(path => !isIgnoredPath(path));
        if (drift.length) {
            result.drift = drift;
            const show = value => JSON.stringify(value)?.slice(0, 40);
            result.driftDetail = drift.map(path => `${path} was ${show(getPath(landed.before, path))} and is ${show(getPath(restored.settings, path))}`);
        }
    } catch (error) {
        result.restoreProblem = String(error.message).split('\n')[0];
    }
    return result;
}
