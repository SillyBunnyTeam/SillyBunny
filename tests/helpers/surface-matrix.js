/**
 * The capture matrix of the UI audit tools as data, and the function that puts a page into one cell
 * of it. The surface registry (`surfaces/`) lists what to open; this file lists the sizes and variants to open it at.
 *
 * A size with a coarse pointer needs a touch context, which Playwright fixes when the context is created. So a spec
 * creates its context from `variantContextOptions()` (or `test.use()` of it) and then calls `applyVariant()` once the
 * app has booted; `applyVariant()` refuses a page whose pointer type does not match the viewport.
 */

import { DESKTOP, LANDSCAPE_PHONE, PHONE, SMALL_PHONE } from './matrix.js';

/**
 * What a viewport applies to. `every` is every surface; the others limit it to the surfaces that carry that scope
 * (see `viewportsFor`).
 * @typedef {'every' | 'top-bar-and-overlays' | 'overlays-and-primary-flows' | 'primary-flows'} AppliesTo
 */

/**
 * @typedef {object} MatrixViewport
 * @property {string} id `<width>x<height>`, the id that a surface's `viewports` list uses.
 * @property {number} width
 * @property {number} height
 * @property {'fine' | 'coarse'} pointer Coarse means a touch context: `hasTouch` and `isMobile`.
 * @property {AppliesTo} appliesTo
 * @property {string} purpose
 */

const size = ({ width, height }) => ({ id: `${width}x${height}`, width, height });

/** @type {readonly MatrixViewport[]} */
export const MATRIX_VIEWPORTS = Object.freeze([
    { ...size({ width: 3440, height: 1440 }), pointer: 'fine', appliesTo: 'every', purpose: 'Ultrawide reference' },
    { ...size({ width: 1920, height: 1080 }), pointer: 'fine', appliesTo: 'every', purpose: 'Common desktop monitor' },
    { ...size(DESKTOP), pointer: 'fine', appliesTo: 'every', purpose: 'Desktop reference' },
    { ...size({ width: 1024, height: 600 }), pointer: 'fine', appliesTo: 'every', purpose: 'The HIG\'s smallest desktop size' },
    { ...size({ width: 900, height: 700 }), pointer: 'fine', appliesTo: 'every', purpose: 'The 769 to 1000px band, where the desktop shell meets upstream\'s mobile rules' },
    { ...size({ width: 768, height: 1024 }), pointer: 'coarse', appliesTo: 'every', purpose: 'Tablet at the shell breakpoint' },
    { ...size(LANDSCAPE_PHONE), pointer: 'coarse', appliesTo: 'every', purpose: 'Phone in landscape' },
    { ...size({ width: 820, height: 360 }), pointer: 'coarse', appliesTo: 'top-bar-and-overlays', purpose: 'Landscape under the 360px height rule for sheets' },
    { ...size(PHONE), pointer: 'coarse', appliesTo: 'every', purpose: 'Phone reference' },
    { ...size(SMALL_PHONE), pointer: 'coarse', appliesTo: 'every', purpose: 'The supported floor' },
    { ...size({ width: 360, height: 294 }), pointer: 'coarse', appliesTo: 'overlays-and-primary-flows', purpose: 'The HIG\'s smallest phone size' },
    { ...size({ width: 320, height: 568 }), pointer: 'coarse', appliesTo: 'primary-flows', purpose: 'No overlap and no horizontal scroll' },
].map(viewport => Object.freeze(viewport)));

export const VIEWPORT_IDS = Object.freeze(MATRIX_VIEWPORTS.map(viewport => viewport.id));

/** The two sizes the extra variant axes (legacy themes, forced colours, text size, reduced motion) run at. */
export const EXTRA_AXIS_VIEWPORT_IDS = Object.freeze([size(DESKTOP).id, size(PHONE).id]);

/** Families whose surfaces are overlays, for the viewports that apply to overlays. An entry of another family opts in with `overlay: true`. */
const OVERLAY_FAMILIES = new Set(['dialog', 'menu', 'panel']);

/**
 * Whether a surface is an overlay: its family is an overlay family, or it sets `overlay`.
 * @param {{ family: string, overlay?: boolean }} surface
 */
export function isOverlaySurface(surface) {
    return OVERLAY_FAMILIES.has(surface.family) || surface.overlay === true;
}

/**
 * A viewport on its own by id.
 * @param {string} id
 * @returns {MatrixViewport}
 */
export function viewportById(id) {
    const viewport = MATRIX_VIEWPORTS.find(candidate => candidate.id === id);
    if (!viewport) {
        throw new Error(`Unknown matrix viewport "${id}". Known: ${VIEWPORT_IDS.join(', ')}.`);
    }
    return viewport;
}

/**
 * The viewport ids that a surface is captured at: the matrix rows that apply to it, cut down by its own `viewports`.
 * `top-bar-and-overlays` applies to header surfaces and overlays; `primary-flows` to surfaces that set `primaryFlow`;
 * `overlays-and-primary-flows` to both of those. A surface is an overlay when its family is an overlay family
 * or when it sets `overlay`, which is how a window of another family (Help, About) gets the overlay viewports.
 * @param {{ family: string, primaryFlow?: boolean, overlay?: boolean, viewports?: string[] }} surface
 * @returns {string[]}
 */
export function viewportsFor(surface) {
    const isOverlay = isOverlaySurface(surface);
    const isTopBar = surface.family === 'header';
    const isPrimaryFlow = surface.primaryFlow === true;
    const applies = {
        'every': true,
        'top-bar-and-overlays': isTopBar || isOverlay,
        'overlays-and-primary-flows': isOverlay || isPrimaryFlow,
        'primary-flows': isPrimaryFlow,
    };
    return MATRIX_VIEWPORTS
        .filter(viewport => applies[viewport.appliesTo])
        .filter(viewport => !surface.viewports || surface.viewports.includes(viewport.id))
        .map(viewport => viewport.id);
}

export const DENSITIES = Object.freeze([
    { id: 'normal', compact: false },
    { id: 'compact', compact: true },
]);

/** The two Libadwaita themes, by the name the theme selector uses. `tone` is the `data-sb-surface-tone` they produce. */
export const THEMES = Object.freeze([
    { id: 'libadwaita', name: 'Libadwaita Dark', tone: 'dark' },
    { id: 'libadwaita-light', name: 'Libadwaita Light', tone: 'light' },
]);

/**
 * Themes that other tools check for legibility only, at the extra-axis sizes: one translucent dark upstream theme and one
 * light non-Libadwaita theme. A tool that needs them skips an empty list.
 * @type {readonly { id: string, name: string, tone: 'dark' | 'light' }[]}
 */
export const LEGACY_THEMES = Object.freeze([
    { id: 'azure', name: 'Azure', tone: 'dark' },
    { id: 'solarized-light', name: 'Solarized Light', tone: 'light' },
]);

/**
 * Axes that run at `EXTRA_AXIS_VIEWPORT_IDS` only. Each is a switch on top of the default variant.
 * `text-200` doubles the app's own text scale (`--fontScale`), which is how a user's text size reaches the shell.
 */
export const EXTRA_AXES = Object.freeze([
    { id: 'forced-colors', variant: { forcedColors: 'active' } },
    { id: 'text-200', variant: { textScale: 2 } },
    { id: 'reduced-motion', variant: { reducedMotion: 'reduce' } },
]);

/**
 * One cell of the matrix.
 * @typedef {object} Variant
 * @property {string} viewport A viewport id.
 * @property {'normal' | 'compact'} density
 * @property {string} theme A theme id of `THEMES` or `LEGACY_THEMES`.
 * @property {'active' | 'none'} forcedColors
 * @property {number} textScale 1 is the app's default.
 * @property {'reduce' | 'no-preference'} reducedMotion `no-preference` runs the animated path, which is what the app does by default;
 * the `reduced-motion` axis is the cell that sets `reduce`. A capture tool turns animations off through Playwright's screenshot options.
 */

/** @type {Readonly<Variant>} */
export const DEFAULT_VARIANT = Object.freeze({
    viewport: size(DESKTOP).id,
    density: 'normal',
    theme: 'libadwaita',
    forcedColors: 'none',
    textScale: 1,
    reducedMotion: 'no-preference',
});

/**
 * @param {Partial<Variant>} [variant]
 * @returns {Variant}
 */
export function resolveVariant(variant = {}) {
    const resolved = { ...DEFAULT_VARIANT, ...variant };
    viewportById(resolved.viewport);
    if (!DENSITIES.some(density => density.id === resolved.density)) {
        throw new Error(`Unknown density "${resolved.density}".`);
    }
    if (![...THEMES, ...LEGACY_THEMES].some(theme => theme.id === resolved.theme)) {
        throw new Error(`Unknown theme "${resolved.theme}".`);
    }
    return resolved;
}

/**
 * The Playwright context options of a variant: the window size, a touch context for a coarse pointer, and the media
 * features that a context can emulate from the start. `serviceWorkers` is blocked because the app's worker takes over
 * requests that a spec stubs with `page.route`.
 * @param {Partial<Variant>} [variant]
 */
export function variantContextOptions(variant) {
    const resolved = resolveVariant(variant);
    const viewport = viewportById(resolved.viewport);
    const coarse = viewport.pointer === 'coarse';
    return {
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: coarse,
        isMobile: coarse,
        forcedColors: resolved.forcedColors,
        reducedMotion: resolved.reducedMotion,
        serviceWorkers: /** @type {const} */ ('block'),
    };
}

const COMPACT_STORAGE_KEY = 'sb-compact-mode';

/**
 * A script for `page.addInitScript()` that stores the compact setting before the app reads it, so a booted app starts
 * in the density of the variant the way a returning user's would.
 * @param {Partial<Variant>} [variant]
 * @returns {[(args: { key: string, value: string }) => void, { key: string, value: string }]}
 */
export function densityInitScript(variant) {
    const { density } = resolveVariant(variant);
    return [
        ({ key, value }) => { try { localStorage.setItem(key, value); } catch { /* The page may not allow storage. */ } },
        { key: COMPACT_STORAGE_KEY, value: String(density === 'compact') },
    ];
}

/**
 * Puts a booted app into a variant: window size, theme, density, text size, and the media features. The pointer type
 * cannot change on a live page, so the page must come from a context built with `variantContextOptions()`.
 * The theme, the density and the text size go through the app's own controls and handlers (the theme selector,
 * `SillyBunnyShell.setCompactMode`, which the Compact Mode switch calls, and the `#font_scale` slider), so the values are
 * in the app's state and in its stored settings, and they stay when the app applies its settings again. Each effect is checked afterwards: the `--fontScale` value and the
 * `data-sb-compact-mode` attribute, with the stored compact value.
 * Those handlers save settings, so the page must be guarded first (`protectMaintainerServer()`, which `bootSurfaceApp()` calls).
 * @param {import('@playwright/test').Page} page A page whose app has booted.
 * @param {Partial<Variant>} [variant]
 */
export async function applyVariant(page, variant) {
    // Imported here because the guard module loads Playwright, which the registry (loaded under Jest) must not.
    const { isMaintainerServerProtected } = await import('./maintainer-server.js');
    if (!isMaintainerServerProtected(page)) {
        throw new Error('applyVariant() changes the theme and text size through handlers that save settings. Call protectMaintainerServer(page) from helpers/maintainer-server.js first, or boot with bootSurfaceApp().');
    }
    const resolved = resolveVariant(variant);
    const viewport = viewportById(resolved.viewport);
    const theme = [...THEMES, ...LEGACY_THEMES].find(candidate => candidate.id === resolved.theme);

    const pointer = await page.evaluate(() => (matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine'));
    if (pointer !== viewport.pointer) {
        throw new Error(`Viewport ${viewport.id} needs a ${viewport.pointer} pointer, and this page has a ${pointer} one. Create the context from variantContextOptions().`);
    }

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ forcedColors: resolved.forcedColors, reducedMotion: resolved.reducedMotion });
    await page.evaluate(({ themeName }) => {
        const select = document.querySelector('#themes');
        if (select && select.value !== themeName) {
            window.$(select).val(themeName).trigger('change');
        }
    }, { themeName: theme.name });
    if (theme.tone) {
        await page.waitForFunction(tone => document.documentElement.getAttribute('data-sb-surface-tone') === tone, theme.tone);
    }

    // The Compact Mode switch is built into the Appearance page only when that page is mounted, and opening the page would leave a
    // panel open under the surface that is measured. The switch's change handler calls this same function.
    const compact = resolved.density === 'compact';
    await page.evaluate(wanted => window.SillyBunnyShell.setCompactMode(wanted), compact);
    // The slider stops at 150%, so a larger scale lifts its limit first; the handler then stores and applies the value as it does for a typed one.
    await page.evaluate(scale => {
        const slider = document.querySelector('#font_scale');
        if (Number(slider.max) < scale) {
            slider.max = String(scale);
        }
        slider.value = String(scale);
        window.$(slider).trigger('input', { forced: true });
    }, resolved.textScale);

    try {
        await page.waitForFunction(({ compact, key, scale }) => {
            const root = document.documentElement;
            return root.dataset.sbCompactMode === String(compact)
                && document.body.classList.contains('sb-compact-mode') === compact
                && localStorage.getItem(key) === String(compact)
                && Number(root.style.getPropertyValue('--fontScale')) === scale;
        }, { compact, key: COMPACT_STORAGE_KEY, scale: resolved.textScale }, { timeout: 5000 });
    } catch {
        const seen = await page.evaluate(key => ({
            compact: document.documentElement.dataset.sbCompactMode,
            stored: localStorage.getItem(key),
            fontScale: document.documentElement.style.getPropertyValue('--fontScale'),
        }), COMPACT_STORAGE_KEY);
        throw new Error(`The variant did not take effect: wanted compact ${compact} and --fontScale ${resolved.textScale}, the app has ${JSON.stringify(seen)}.`);
    }
    await page.evaluate(() => document.fonts.ready);
}
