/* global globalThis */
import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';

// The editors' shared rules live in a deferred sheet. The sheet is held back here until the test lets it go, so an
// editor that painted before the sheet applied would show its header unstyled. A service worker would answer the held
// request from its cache.
test.use({ serviceWorkers: 'block' });

const CHROME_SHEET = '**/css/sillybunny-character-editor.css*';
const HELD_FRAMES = 12;
const SETTLE_FRAMES = 60;
const STARTUP_TIMEOUT = 60_000;
const BOOK = `EDITOR_FIRST_FRAME_${Date.now()}`;
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    const entry = (uid, comment) => ({
        uid, comment, key: [comment.toLowerCase()], keysecondary: [], content: `${comment} content`,
        constant: false, vectorized: false, selective: true, order: 100, position: 0, disable: false, displayIndex: uid,
    });
    const books = new Map([[BOOK, { entries: { 0: entry(0, 'Alpha'), 1: entry(1, 'Beta') } }]]);
    await page.route('**/api/settings/get', async route => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        applyWelcomeSettings(settings);
        settings.power_user.world_import_dialog = false;
        settings.power_user.reduced_motion = false;
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings), world_names: [...books.keys()] } });
    });
    await page.route('**/api/worldinfo/**', route => {
        const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
        const buffer = route.request().postDataBuffer();
        const payload = buffer ? JSON.parse((route.request().headers()['content-encoding'] === 'gzip' ? gunzipSync(buffer) : buffer).toString()) : {};
        if (endpoint === 'get') return route.fulfill({ status: books.has(payload.name) ? 200 : 404, json: books.get(payload.name) ?? {} });
        if (endpoint === 'list') return route.fulfill({ json: [...books].map(([name, data]) => ({ name, ...data })) });
        return route.abort();
    });
    // Browser QA must not change the running instance's saved preferences.
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip'
            ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
});

/**
 * Boots the app after a reload, with the editors' shared sheet held back until `release()` is called.
 * @returns {Promise<{ requested: string[], release: () => void }>}
 */
async function bootWithHeldSheet(page, viewport) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: STARTUP_TIMEOUT });
    const requested = [];
    let release;
    const released = new Promise(resolve => { release = resolve; });
    await page.route(CHROME_SHEET, async route => {
        requested.push(route.request().url());
        await released;
        await route.continue().catch(() => {});
    });
    // The held request keeps the load event from firing, so the boot is awaited by its own signal.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: STARTUP_TIMEOUT });
    return { requested, release };
}

/** Lets the browser paint a number of frames, so an editor that was going to show has done so by now. */
function waitForFrames(page, count) {
    return page.evaluate(frames => new Promise(resolve => {
        let left = frames;
        const tick = () => (--left > 0 ? requestAnimationFrame(tick) : resolve());
        requestAnimationFrame(tick);
    }), count);
}

/**
 * Records every animation frame from now on: whether the editor header is visible, whether the sheet is applied, and
 * the header height and the Save background as that frame has them. `requestAnimationFrame` runs just before the
 * browser paints, so a frame holds what the user sees.
 */
async function recordFrames(page, { opened, header, save }) {
    await page.evaluate(selectors => {
        const frames = [];
        const state = { frames, stopped: false };
        globalThis.__editorFrames = state;
        const sheetApplied = () => {
            const link = document.querySelector('link[href*="sillybunny-character-editor.css"]');
            return Boolean(link?.sheet) && link.media !== 'print' && link.rel === 'stylesheet';
        };
        const sample = () => {
            const headerElement = document.querySelector(selectors.header);
            const saveElement = document.querySelector(selectors.save);
            const shown = Boolean(headerElement)
                && headerElement.getClientRects().length > 0
                && getComputedStyle(headerElement).visibility !== 'hidden';
            frames.push({
                opened: Boolean(document.querySelector(selectors.opened)),
                shown,
                sheet: sheetApplied(),
                headerHeight: shown ? headerElement.getBoundingClientRect().height : null,
                saveBackground: shown && saveElement ? getComputedStyle(saveElement).backgroundColor : null,
            });
            if (!state.stopped) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    }, { opened, header, save });
}

async function stopFrames(page) {
    // Long enough for a transition that the sheet starts to end, so the last frame is the settled one.
    await waitForFrames(page, SETTLE_FRAMES);
    return page.evaluate(() => {
        globalThis.__editorFrames.stopped = true;
        return globalThis.__editorFrames.frames;
    });
}

/** The first frame that shows the header must already have the sheet, the styled height and the styled Save fill. */
function expectStyledFromFirstFrame(frames, { mountedWhileHeld }) {
    const shownFrames = frames.filter(frame => frame.shown);
    expect(shownFrames.length, 'the editor header was never visible').toBeGreaterThan(0);
    const settled = shownFrames.at(-1);
    expect(settled.sheet, 'the sheet applied').toBe(true);
    expect(settled.headerHeight).toBeGreaterThan(40);
    expect(settled.saveBackground).not.toBe('rgba(0, 0, 0, 0)');

    const first = shownFrames[0];
    expect(first.sheet, 'the first visible frame has the sheet').toBe(true);
    expect(first.headerHeight).toBe(settled.headerHeight);
    expect(first.saveBackground).toBe(settled.saveBackground);
    expect(shownFrames.filter(frame => !frame.sheet), 'frames that showed the header without the sheet').toEqual([]);

    // The editor was opened while the sheet was held, so the frames before the sheet arrived were held back, not skipped.
    const held = frames.filter(frame => !frame.sheet);
    expect(held.length, 'frames were recorded while the sheet was held').toBeGreaterThanOrEqual(HELD_FRAMES - 1);
    expect(held.some(frame => frame.opened), mountedWhileHeld ? 'the editor was open while it was held' : 'the editor was mounted before its sheet').toBe(mountedWhileHeld);
}

for (const viewport of VIEWPORTS) {
    test.describe(`${viewport.width}px`, () => {
        test('the character editor paints its first frame with the styled header', async ({ page }) => {
            const { requested, release } = await bootWithHeldSheet(page, viewport);
            try {
                await page.evaluate(async () => { window.qaApp = await import('/script.js'); });
                await page.waitForFunction(() => window.qaApp.characters.length > 0, null, { timeout: STARTUP_TIMEOUT });
                await page.locator('#sb-character-toggle').click();
                await recordFrames(page, {
                    opened: '#rm_ch_create_block.sb-active-right-menu',
                    header: '#sb_character_editor_header',
                    save: '#sb_character_editor_save',
                });
                await page.evaluate(() => {
                    window.qaApp.setCharacterId(0);
                    window.qaApp.select_selected_character(0);
                });
                await waitForFrames(page, HELD_FRAMES);
            } finally {
                release();
            }
            await expect(page.locator('#sb_character_editor_header')).toBeVisible({ timeout: 15_000 });
            expectStyledFromFirstFrame(await stopFrames(page), { mountedWhileHeld: true });
            expect(requested.length, 'the held sheet was requested').toBeGreaterThan(0);
        });

        test('a World Info entry paints its first frame with the styled header', async ({ page }) => {
            const { requested, release } = await bootWithHeldSheet(page, viewport);
            const editor = page.locator('#WorldInfo .sb-wi-editor');
            try {
                await recordFrames(page, {
                    opened: '#WorldInfo .sb-wi-editor',
                    header: '#WorldInfo .sb-wi-entry .sb-wi-entry-header',
                    save: '#WorldInfo .sb-wi-entry .sb-wi-entry-header .sb-editor-action--primary',
                });
                await page.evaluate(async name => {
                    const { openWorldInfoEditor } = await import('/scripts/world-info.js');
                    openWorldInfoEditor(name);
                }, BOOK);
                await waitForFrames(page, HELD_FRAMES);
            } finally {
                release();
            }
            await expect(editor.locator('.sb-wi-row')).toHaveCount(2, { timeout: 30_000 });
            await editor.locator('.sb-wi-row', { hasText: 'Alpha' }).click();
            await expect(page.locator('#WorldInfo .sb-wi-entry .sb-wi-entry-header')).toBeVisible();
            expectStyledFromFirstFrame(await stopFrames(page), { mountedWhileHeld: false });
            expect(requested.length, 'the held sheet was requested').toBeGreaterThan(0);
        });
    });
}
