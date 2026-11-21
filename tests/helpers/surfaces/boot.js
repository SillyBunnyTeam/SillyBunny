/**
 * Boots the app for a surface run and opens a surface. For specs under `tests/audit/` that iterate over the registry.
 *
 * A run reads the seeded throwaway server (`seedServer()` in `fixtures.js`) and saves nothing: settings, chat and
 * character writes are answered by `protectMaintainerServer()`, and the settings of the boot carry the settings-side
 * fixtures for the surface's `needs`.
 */

import { gunzipSync } from 'node:zlib';
import { applyVariant, densityInitScript } from '../surface-matrix.js';
import { assertIsolatedServer, protectMaintainerServer } from '../maintainer-server.js';
import { fetchJsonOrSkip } from '../route-fetch.js';
import { applyWelcomeSettings } from '../welcome-dialog.js';
import { applyAnswerFixtures, applySettingsFixtures } from './fixture-data.js';
import { SERVER_ADMIN_FIXED, SERVER_ADMIN_FIXED_ROUTE } from './server-admin-fixed.js';
import { seedFailuresOf } from './seed-guard.js';
import { labelPage, settle } from './steps.js';

const ARCHIVE_ORGANIZATION_FILE = '_sbca_organization.json';

/**
 * The Chats Archive keeps its saved views, folders and the view it last showed in a file on the server, which its search and
 * filters write half a second after any change. Left alone, the search of one surface is the filter of the next boot on the same
 * server, so the write is answered without happening, and the file reads as absent.
 * @param {import('@playwright/test').Page} page
 */
async function keepArchiveOrganizationOffServer(page) {
    await page.route('**/api/files/upload', route => {
        const request = route.request();
        const body = request.postDataBuffer();
        let name;
        try {
            name = JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString())?.name;
        } catch {
            return route.fallback();
        }
        return name === ARCHIVE_ORGANIZATION_FILE ? route.fulfill({ json: { path: `user/files/${ARCHIVE_ORGANIZATION_FILE}` } }) : route.fallback();
    });
    await page.route(`**/user/files/${ARCHIVE_ORGANIZATION_FILE}`, route => route.fulfill({ status: 404, body: 'Not found' }));
}

/**
 * Boots the app on the server at `baseURL` and waits until it is ready, in the cell of the matrix given by `variant`.
 * Must run inside a test, because the write guard reads the running test. It fails at once when the global setup could not
 * seed one of `needs`, and when the settings of the boot cannot be built, instead of waiting for the app to time out.
 * @param {import('@playwright/test').Page} page A page from a context built with `variantContextOptions(variant)`.
 * @param {string} baseURL
 * @param {{ variant?: Partial<import('../surface-matrix.js').Variant>, needs?: readonly string[] }} [options]
 */
export async function bootSurfaceApp(page, baseURL, { variant, needs = [] } = {}) {
    assertIsolatedServer(baseURL, 'Surface audit');
    const unseeded = Object.entries(seedFailuresOf(baseURL, needs));
    if (unseeded.length) {
        throw new Error(`Fixture data is missing, because seeding failed: ${unseeded.map(([need, message]) => `${need} (${message})`).join('; ')}`);
    }
    await protectMaintainerServer(page);
    await keepArchiveOrganizationOffServer(page);
    await page.addInitScript(...densityInitScript(variant));
    let failBoot;
    const bootFailed = new Promise((_, reject) => { failBoot = reject; });
    bootFailed.catch(() => {});
    await page.route('**/api/settings/get', async route => {
        try {
            const data = await fetchJsonOrSkip(route);
            if (!data) {
                return;
            }
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            applyWelcomeSettings(settings);
            applySettingsFixtures(settings, needs);
            await route.fulfill({ json: applyAnswerFixtures({ ...data, settings: JSON.stringify(settings) }, needs) });
        } catch (error) {
            failBoot(new Error(`The settings of the boot could not be built for needs [${needs.join(', ')}]: ${error?.message ?? error}`));
            await route.abort().catch(() => {});
        }
    });
    // The page that shows the server's state reads the git state of the checkout, which differs between checkouts and moments.
    await page.route(SERVER_ADMIN_FIXED_ROUTE, route => route.fulfill({ json: SERVER_ADMIN_FIXED[new URL(route.request().url()).pathname] }));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await finishBoot(page, variant, bootFailed);
}

/**
 * Waits until the app that a page loaded is ready, and puts it in `variant`.
 * @param {import('@playwright/test').Page} page
 * @param {Partial<import('../surface-matrix.js').Variant> | undefined} variant
 * @param {Promise<never>} [bootFailed] Rejects when the settings of the boot cannot be built.
 */
async function finishBoot(page, variant, bootFailed) {
    // getContext() throws while the app's modules are still initialising, so a throw means not ready yet.
    const ready = page.waitForFunction(() => {
        try {
            return Boolean(window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'));
        } catch {
            return false;
        }
    }, null, { timeout: 60_000 });
    ready.catch(() => {});
    await Promise.race(bootFailed ? [ready, bootFailed] : [ready]);
    await page.waitForFunction(() => !document.getElementById('preloader'));
    // Scrolling is not an animation that `settle()` can see, so reads of a scroll position must not wait for a smooth one.
    await page.addStyleTag({ content: '*, *::before, *::after { scroll-behavior: auto !important; }' });
    await applyVariant(page, variant);
}

/**
 * Loads the app again on a page that `bootSurfaceApp()` booted, and puts it in `variant`. The routes and scripts of the boot
 * stay on the page. A surface that is captured in several cells on one page starts each cell from here, because the last state
 * of the cell before (a search that is typed, a filter that is set, a menu that is open) is still on the page, and an open step
 * that toggles a control would then undo it and wait for what never shows.
 * @param {import('@playwright/test').Page} page
 * @param {{ variant?: Partial<import('../surface-matrix.js').Variant> }} [options]
 */
export async function rebootSurfaceApp(page, { variant } = {}) {
    // An editor with a draft that is not saved asks "leave site?", and a dialog that nobody answers is dismissed, which
    // cancels the reload and leaves it waiting.
    const leave = dialog => dialog.accept().catch(() => {});
    page.on('dialog', leave);
    try {
        await page.reload({ waitUntil: 'domcontentloaded' });
    } finally {
        page.off('dialog', leave);
    }
    await finishBoot(page, variant);
}

/**
 * Opens a surface, and one of its states when `stateId` is given (the surface is opened first, as the registry
 * defines states to open on top of it). Returns the root selector to measure.
 * @param {import('@playwright/test').Page} page
 * @param {import('./index.js').Surface} surface
 * @param {{ stateId?: string, backend?: string, viewport?: string }} [options]
 * @returns {Promise<string>}
 */
export async function openSurface(page, surface, { stateId, backend, viewport } = {}) {
    const ctx = { backend, viewport };
    const label = [surface.id, backend && `[${backend}]`, stateId && `state ${stateId}`].filter(Boolean).join(' ');
    labelPage(page, label);
    await surface.open(page, ctx);
    if (stateId === undefined) {
        await settle(page, { root: surface.root });
        return surface.root;
    }
    const state = surface.states?.find(candidate => candidate.id === stateId);
    if (!state) {
        throw new Error(`${surface.id} has no state "${stateId}".`);
    }
    await state.open(page, ctx);
    await settle(page, { root: state.root ?? surface.root });
    return state.root ?? surface.root;
}

/**
 * The selectors that must be shown once a surface, or one of its states, is open: the `ready` of the surface, or for a
 * state its own `ready`; a state with neither `ready` nor `root` is the surface with more shown, so it keeps the surface's.
 * @param {import('./index.js').Surface} surface
 * @param {{ stateId?: string, backend?: string, viewport?: string }} [options]
 * @returns {string[]}
 */
export function readySelectors(surface, { stateId, backend, viewport } = {}) {
    const ctx = { backend, viewport };
    const state = stateId === undefined ? undefined : surface.states?.find(candidate => candidate.id === stateId);
    const declared = state === undefined ? surface.ready : state.ready ?? (state.root ? undefined : surface.ready);
    return [declared].flatMap(ready => {
        const value = typeof ready === 'function' ? ready(ctx) : ready;
        return value === undefined ? [] : [value].flat();
    });
}
