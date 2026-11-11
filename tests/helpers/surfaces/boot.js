/**
 * Boots the app for a surface run and opens a surface. For specs under `tests/audit/` that iterate over the registry.
 *
 * A run reads the seeded throwaway server (`seedServer()` in `fixtures.js`) and saves nothing: settings, chat and
 * character writes are answered by `protectMaintainerServer()`, and the settings of the boot carry the settings-side
 * fixtures for the surface's `needs`.
 */

import { applyVariant, densityInitScript } from '../surface-matrix.js';
import { assertIsolatedServer, protectMaintainerServer } from '../maintainer-server.js';
import { fetchJsonOrSkip } from '../route-fetch.js';
import { applyWelcomeSettings } from '../welcome-dialog.js';
import { applySettingsFixtures } from './fixture-data.js';
import { seedFailuresOf } from './seed-guard.js';
import { labelPage, settle } from './steps.js';

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
            await route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
        } catch (error) {
            failBoot(new Error(`The settings of the boot could not be built for needs [${needs.join(', ')}]: ${error?.message ?? error}`));
            await route.abort().catch(() => {});
        }
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // getContext() throws while the app's modules are still initialising, so a throw means not ready yet.
    const ready = page.waitForFunction(() => {
        try {
            return Boolean(window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'));
        } catch {
            return false;
        }
    }, null, { timeout: 60_000 });
    ready.catch(() => {});
    await Promise.race([ready, bootFailed]);
    await page.waitForFunction(() => !document.getElementById('preloader'));
    // Scrolling is not an animation that `settle()` can see, so reads of a scroll position must not wait for a smooth one.
    await page.addStyleTag({ content: '*, *::before, *::after { scroll-behavior: auto !important; }' });
    await applyVariant(page, variant);
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
