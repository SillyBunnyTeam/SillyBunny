import { readDialogAside, writeDialogAside } from '../sillybunny-editor/dialog-aside.js';
import { getPixelArt } from './art-sources.js';
import {
    alignToDevicePixels,
    bannerRows,
    createPixelFigure,
    describeFit,
    hasTransformedAncestor,
    largestStepThatFits,
    pixelCssSize,
    pixelStep,
    readDevicePixelRatio,
    sizePixelFigure,
    watchPixelScale,
} from './pixel-art.js';

/*
 * Where a character's art goes in a window or on Home. Wide enough: a panel beside the content, the whole figure.
 * Otherwise a banner above the content, from the head down to the hips at most, with a faded bottom edge. The panel
 * keeps the fixed step of the screen, so one character is the same size in every window. A banner may use a smaller
 * whole step when the row is too wide or the screen too short, and the art is hidden when even that leaves too few
 * rows. The choice depends on the size of each picture and on the room the host has, which only this code knows, so
 * the CSS holds a floor under it and never has to decide.
 */

/** The content column keeps at least this width beside a panel, at the default text size. */
export const MIN_CONTENT_WIDTH = 360;
/** Space between a panel and the content, and between rows of a window body. */
export const ART_GAP = 16;
/** Inside a panel, around the figures. Passed to the CSS as `--sb-art-pad`. */
export const PANEL_PADDING = 12;
/** Between two figures of one panel. Passed to the CSS as `--sb-art-figure-gap`. */
export const FIGURE_GAP = 8;
/** A panel that is already beside the content stays until the content column is this much too narrow. It stops a scrollbar from flipping the choice at the edge. */
const KEEP_TOLERANCE = 16;
/** A Dialog or Window is at most 90% of the viewport tall, and never closer than 16px to an edge. */
const WINDOW_HEIGHT_SHARE = 0.9;
const WINDOW_EDGE = 32;
/** A window that gets less than this share of an added width, such as a window the screen already limits, is not widened again. */
const MIN_WIDENING_GAIN = 0.05;
/** A widening is at most a probe and a correction. */
const MAX_WIDENING_ROUNDS = 2;
/** A transform above the art, such as the open animation of a window, ends within this many frames. */
const ALIGN_WAIT_FRAMES = 90;
/** A banner is at most this share of the viewport height, so the content under it keeps the room on a short screen. */
export const BANNER_HEIGHT_SHARE = 0.3;
/**
 * A banner that could show fewer art rows than this is not shown. Fewer rows are a sliver of the head, which
 * says nothing about the character and still takes the room of the content.
 */
export const MIN_BANNER_ROWS = 90;
/** Room for the rounding of a division that lands exactly on a whole row. */
const ROW_EPSILON = 1e-6;

/** The text size that the app applies through `--fontScale`. */
function readTextScale() {
    return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fontScale')) || 1;
}

/**
 * The scale of the screen: the fixed step and the ratio it was made for.
 * @returns {{ step: number, ratio: number }}
 */
function readFixedScale() {
    const ratio = readDevicePixelRatio();
    return { step: pixelStep(ratio), ratio };
}

/**
 * The sizes of a panel for one set of figures, at the fixed step. Figures stand on one line, bottom aligned.
 * @param {string[]} ids
 * @param {{ step: number, ratio: number }} scale
 * @returns {{ panelWidth: number, panelHeight: number }}
 */
export function measureArtPanel(ids, { step, ratio }) {
    const arts = ids.map(getPixelArt);
    const widths = arts.reduce((sum, art) => sum + pixelCssSize(art.width, step, ratio), 0);
    const tallest = Math.max(...arts.map(art => pixelCssSize(art.height, step, ratio)));
    return {
        panelWidth: widths + FIGURE_GAP * (arts.length - 1) + 2 * PANEL_PADDING,
        panelHeight: tallest + 2 * PANEL_PADDING,
    };
}

/**
 * How many art rows a banner may show at this scale without being taller than `BANNER_HEIGHT_SHARE` of the viewport.
 * A whole number of rows, so the cut falls between two art pixels.
 * @param {{ viewportHeight: number, step: number, ratio: number }} input
 * @returns {number} Can be below `MIN_BANNER_ROWS`, and below zero on a viewport that is shorter than the padding.
 */
export function maxBannerRows({ viewportHeight, step, ratio }) {
    const room = BANNER_HEIGHT_SHARE * viewportHeight - PANEL_PADDING;
    return Math.floor((room * ratio) / step + ROW_EPSILON);
}

/**
 * The scale and the rows of a banner on a viewport of this height. The step is the largest whole one, from the
 * given scale down, that still shows `MIN_BANNER_ROWS`: a 1.5 screen cannot show 90 rows of step 2 in a landscape
 * phone, and shows them at step 1. Each figure shows its usual crop, cut shorter where the room is short. The head and
 * the shoulders are the top rows, so they stay.
 * @param {{ ids: string[], scale: { step: number, ratio: number }, viewportHeight: number }} input
 * @returns {{ scale: { step: number, ratio: number }, rows: number[] } | null} Null when even step 1 shows fewer rows.
 */
export function planBanner({ ids, scale, viewportHeight }) {
    for (let step = scale.step; step >= 1; step--) {
        const limit = maxBannerRows({ viewportHeight, step, ratio: scale.ratio });
        if (limit >= MIN_BANNER_ROWS) {
            return {
                scale: { step, ratio: scale.ratio },
                rows: ids.map(id => Math.min(bannerRows(getPixelArt(id).height), limit)),
            };
        }
    }
    return null;
}

/**
 * A panel when the content column beside it keeps `minContentWidth` and the whole panel fits the height, a banner otherwise.
 * @param {{ contentWidth: number, availableHeight: number, panelWidth: number, panelHeight: number, current?: 'panel' | 'banner', minContentWidth?: number }} input
 *   `contentWidth` is the width of the host between its paddings, as it would be without a panel. `current` is the
 *   mode that is shown, which gets a little more room to stay.
 * @returns {'panel' | 'banner'}
 */
export function planArtMode({ contentWidth, availableHeight, panelWidth, panelHeight, current = 'banner', minContentWidth = MIN_CONTENT_WIDTH }) {
    const column = contentWidth - panelWidth - ART_GAP;
    const floor = current === 'panel' ? minContentWidth - KEEP_TOLERANCE : minContentWidth;
    return column >= floor && panelHeight <= availableHeight ? 'panel' : 'banner';
}

/**
 * @typedef {'panel' | 'banner' | 'hidden'} ArtMode A hidden panel takes no room, because the viewport is too short for a banner.
 */

/**
 * @typedef {object} ArtController
 * @property {HTMLElement} panel
 * @property {string[]} ids
 * @property {{ id: string, figure: HTMLElement }[]} figures
 * @property {HTMLElement | null} host The element that holds the panel as a child: a window body, a Help page, or the Home empty state.
 * @property {boolean} seen Whether the panel has been in the document.
 * @property {boolean} alignQueued
 * @property {'panel' | 'hero'} [kind] A hero is one figure fitted to the width of its band, with no panel, mode or window.
 */

/** @type {Set<ArtController>} */
const controllers = new Set();
let frame = 0;
let resizeObserver = null;
let stopScaleWatch = null;

/**
 * What the host itself spends around its content, read where it is laid out. The host pads and spaces its children
 * by its own rules, which change with the density and the presentation of the window.
 * @param {HTMLElement} host
 * @returns {{ inset: number, insetBlock: number, rowGap: number }}
 */
function readHostMetrics(host) {
    const style = getComputedStyle(host);
    const read = value => Number.parseFloat(value) || 0;
    return {
        inset: read(style.paddingInlineEnd),
        insetBlock: read(style.paddingBlockStart) + read(style.paddingBlockEnd),
        rowGap: read(style.rowGap),
    };
}

/**
 * The width of the host between its paddings, as it would be without a panel. A panel adds to the start padding, so
 * the end padding stands for the start padding that a panel would replace: every host pads both sides alike.
 * @param {HTMLElement} host
 */
function contentWidthOf(host) {
    return host.clientWidth - 2 * readHostMetrics(host).inset;
}

/**
 * What the window spends on everything but the host. While a slide brings in a page, the old and the new page both
 * stand in the surface, so the height of the surface minus the host would count the old page as frame. The surface
 * minus its pages, plus the page minus the host, leaves out every page but the one of the host.
 * @param {HTMLElement} host
 * @param {HTMLElement} surface
 */
function frameHeightOf(host, surface) {
    const pages = host.closest('.sb-dialog__pages');
    const page = host.closest('.sb-dialog__page');
    if (!pages || !page || !surface.contains(pages)) {
        return surface.offsetHeight - host.offsetHeight;
    }
    return (surface.offsetHeight - pages.offsetHeight) + (page.offsetHeight - host.offsetHeight);
}

/**
 * The height that the content of a host can use: what the window may be tall, less its own frame and the padding of
 * the host. A host outside a window has no limit.
 * @param {HTMLElement} host
 * @param {HTMLElement | null} surface
 * @param {number} viewportHeight
 */
function availableHeightOf(host, surface, viewportHeight) {
    if (!surface) {
        return Number.POSITIVE_INFINITY;
    }
    const frameHeight = frameHeightOf(host, surface);
    const tallest = Math.min(viewportHeight * WINDOW_HEIGHT_SHARE, viewportHeight - WINDOW_EDGE);
    return tallest - frameHeight - readHostMetrics(host).insetBlock;
}

/** A sheet is as wide as the screen, so adding width to it changes nothing. */
function isSheet(surface) {
    return surface.closest('.sb-dialog-host')?.dataset.presentation === 'sheet';
}

/**
 * The next step of the widening of a window that still lacks `shortfall` of content width. A window with a sidebar,
 * such as Help, shares an added width between the sidebar and the page in its own proportions, so what a window needs
 * is worked out from the width that an earlier widening gained.
 * @param {object} input
 * @param {number} input.shortfall What the content column lacks. Zero or less when it has enough.
 * @param {number | null} input.gain The share of an added width that went to the content, or null when none was measured.
 * @param {boolean} input.probed Whether the gain comes from a probe, which is added only to measure it.
 * @param {number} input.room The width that the screen still lets the window grow by.
 * @returns {{ action: 'done' } | { action: 'take-back' } | { action: 'probe' | 'correct', extra: number }}
 *   `probe` adds the shortfall once to measure the gain. `correct` adds what the gain says is needed. `take-back`
 *   removes a probe that gained next to nothing, because the screen limits the window.
 */
export function planWidening({ shortfall, gain, probed, room }) {
    if (shortfall <= 0 || room <= 0) {
        return { action: 'done' };
    }
    if (gain === null) {
        return { action: 'probe', extra: Math.min(Math.ceil(shortfall), room) };
    }
    if (gain < MIN_WIDENING_GAIN) {
        return probed ? { action: 'take-back' } : { action: 'done' };
    }
    return { action: 'correct', extra: Math.min(Math.ceil(shortfall / Math.min(gain, 1)), room) };
}

/**
 * Widens the window by the width of the panel and its gap, and then by what the content column still lacks, never past
 * the screen. A window that was widened by an earlier layout has no first widening to measure, so the shortfall is
 * added once and measured. The sidebar of such a window may follow the new width a frame later, and the next layout
 * then corrects what is left.
 * @param {object} input
 * @param {HTMLElement} input.host
 * @param {HTMLElement} input.surface
 * @param {number} input.panelWidth
 * @param {number} input.asideBefore The width that the window has already been given, which it never gives back while it is open.
 * @param {number} input.contentBefore The content width at `asideBefore`.
 * @param {number} input.minContentWidth
 * @param {number} input.room The width that the screen lets the window grow by from `asideBefore`.
 * @returns {number} The content width at the width that the window was left at.
 */
function widenForPanel({ host, surface, panelWidth, asideBefore, contentBefore, minContentWidth, room }) {
    const wanted = panelWidth + ART_GAP;
    const shortfallAt = content => minContentWidth - (content - wanted);
    let state = { aside: Math.max(asideBefore, wanted), content: contentBefore, gain: null, probed: false };
    if (state.aside !== asideBefore) {
        writeDialogAside(surface, state.aside);
        const content = contentWidthOf(host);
        state = { ...state, content, gain: (content - contentBefore) / (state.aside - asideBefore) };
    }
    let previous = state;
    for (let round = 0; round < MAX_WIDENING_ROUNDS; round++) {
        const step = planWidening({
            shortfall: shortfallAt(state.content),
            gain: state.gain,
            probed: state.probed,
            room: room - (state.aside - asideBefore),
        });
        if (step.action === 'done') {
            return state.content;
        }
        if (step.action === 'take-back') {
            writeDialogAside(surface, previous.aside);
            return previous.content;
        }
        const aside = state.aside + step.extra;
        writeDialogAside(surface, aside);
        const content = contentWidthOf(host);
        previous = state;
        state = { aside, content, gain: (content - state.content) / step.extra, probed: step.action === 'probe' };
        if (step.action === 'correct') {
            return state.content;
        }
    }
    return state.content;
}

function setFigures(controller, ids) {
    controller.ids = ids;
    controller.figures = ids.map(id => ({ id, figure: createPixelFigure(id) }));
    controller.panel.replaceChildren(...controller.figures.map(({ figure }) => figure));
}

/**
 * @param {ArtController} controller
 * @param {{ step: number, ratio: number }} scale
 * @param {number[]} [rows] The rows that each figure shows. A figure shows all of its rows when this is left out.
 */
function sizeFigures(controller, scale, rows) {
    controller.figures.forEach(({ figure }, index) => {
        sizePixelFigure(figure, { ...scale, rows: rows?.[index] });
    });
}

/**
 * @param {ArtController} controller
 * @param {object} layoutResult
 * @param {ArtMode} layoutResult.mode
 * @param {{ panelWidth: number, panelHeight: number }} layoutResult.size
 * @param {{ step: number, ratio: number }} layoutResult.scale The scale that the figures are drawn at.
 * @param {{ step: number, ratio: number }} layoutResult.fixed The fixed scale of the screen.
 * @param {number[]} [layoutResult.rows] The rows of a banner.
 * @param {{ inset: number, insetBlock: number, rowGap: number }} layoutResult.metrics What the host spends around its
 *   content, read before any write of this layout so that no read has to follow a write.
 */
function applyMode(controller, { mode, size, scale, fixed, rows, metrics }) {
    const { panel, host } = controller;
    panel.dataset.sbArtMode = mode;
    if (mode !== 'hidden') {
        sizeFigures(controller, scale, rows);
        panel.dataset.sbArtFit = describeFit(scale, fixed);
    }
    if (!host) {
        return;
    }
    // These writes come after every read of the layout, because the style sheets hold many `:has()` rules and a write
    // followed by a read restyles the whole document.
    host.classList.add('sbArtHost');
    // The surface is the container of the CSS floor. Its width does not change with the padding that a panel adds to the host.
    host.closest('.sb-dialog')?.classList.add('sbArtSurface');
    host.dataset.sbArtMode = mode;
    if (mode === 'panel') {
        host.style.setProperty('--sb-art-w', `${size.panelWidth}px`);
        host.style.setProperty('--sb-art-h', `${size.panelHeight}px`);
        host.style.setProperty('--sb-art-gap', `${ART_GAP}px`);
        host.style.setProperty('--sb-art-inset', `${metrics.inset}px`);
        host.style.setProperty('--sb-art-inset-block', `${metrics.insetBlock}px`);
        host.style.setProperty('--sb-art-row-gap', `${metrics.rowGap}px`);
        return;
    }
    for (const name of ['--sb-art-w', '--sb-art-h', '--sb-art-gap', '--sb-art-inset', '--sb-art-inset-block', '--sb-art-row-gap']) {
        host.style.removeProperty(name);
    }
}

function adoptHost(controller) {
    const host = controller.panel.parentElement;
    if (host === controller.host || !host) {
        return;
    }
    if (controller.host) {
        resizeObserver?.unobserve(controller.host);
        delete controller.host.dataset.sbArtMode;
        controller.host.classList.remove('sbArtHost');
    }
    controller.host = host;
    resizeObserver?.observe(host);
}

/**
 * A banner is as wide as the window body, so on a phone a pair can be wider than the banner. The row then takes the
 * largest step that fits.
 */
function fitBanner(ids, scale, availableWidth) {
    return largestStepThatFits({ widths: ids.map(id => getPixelArt(id).width), gap: FIGURE_GAP, ...scale, availableWidth });
}

/**
 * The hero is drawn at the fixed step when it fits the band, at the largest step that does when it does not, and
 * shrunk by a fraction only when one device pixel per art pixel is still wider than the band.
 * @param {ArtController} controller
 * @returns {{ kind: 'hero', fit: { step: number, ratio: number }, fixed: { step: number, ratio: number } } | null}
 */
function measureHero(controller) {
    const band = controller.panel.parentElement;
    if (!band) {
        return null;
    }
    if (band !== controller.host) {
        if (controller.host) {
            resizeObserver?.unobserve(controller.host);
        }
        controller.host = band;
        resizeObserver?.observe(band);
    }
    const style = getComputedStyle(band);
    const availableWidth = band.clientWidth - Number.parseFloat(style.paddingInlineStart) - Number.parseFloat(style.paddingInlineEnd);
    // A band that is not shown, such as in Compact, has no width. The figure keeps the size it had.
    if (availableWidth <= 0) {
        return null;
    }
    const fixed = readFixedScale();
    return { kind: 'hero', fit: largestStepThatFits({ widths: [getPixelArt(controller.ids[0]).width], ...fixed, availableWidth }), fixed };
}

/**
 * @param {ArtController} controller
 * @param {NonNullable<ReturnType<typeof measureHero>>} plan
 */
function applyHero(controller, { fit, fixed }) {
    sizePixelFigure(controller.panel, fit);
    controller.panel.dataset.sbArtFit = describeFit(fit, fixed);
}

/**
 * Everything that a panel needs to know about its place, read before anything is written.
 * @param {ArtController} controller
 */
function measurePanel(controller) {
    adoptHost(controller);
    const { host, panel } = controller;
    // A host that is not drawn, such as a page that a slide has covered, has no width to decide on. It keeps its mode,
    // so the page does not come back in the wrong one.
    if (!host || host.clientWidth === 0) {
        return null;
    }
    const fixed = readFixedScale();
    const size = measureArtPanel(controller.ids, fixed);
    const metrics = readHostMetrics(host);
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const surface = /** @type {HTMLElement | null} */ (host.closest('.sb-dialog'));
    const minContentWidth = MIN_CONTENT_WIDTH * readTextScale();
    // A window widens to hold the panel, and never narrows again while it is open, so moving between pages does not make it jump.
    const asideBefore = surface ? readDialogAside(surface) : 0;
    const contentBefore = contentWidthOf(host);
    const availableHeight = availableHeightOf(host, surface, viewport.height);
    // The window grows no further than the width of the screen. A window that a style rule limits sooner shows it as a
    // small gain, which `planWidening` takes back.
    const room = surface ? Math.max(0, viewport.width - surface.offsetWidth) : 0;
    // A window that cannot hold the panel in height or in width, and a sheet, are banners whatever their width, so they
    // are not widened to find out.
    const mayWiden = surface !== null
        && !isSheet(surface)
        && size.panelHeight <= availableHeight
        && Math.max(0, size.panelWidth + ART_GAP - asideBefore) <= room;
    const contentWidth = mayWiden
        ? widenForPanel({ host, surface, panelWidth: size.panelWidth, asideBefore, contentBefore, minContentWidth, room })
        : contentBefore;
    const mode = planArtMode({
        contentWidth,
        availableHeight,
        panelWidth: size.panelWidth,
        panelHeight: size.panelHeight,
        current: panel.dataset.sbArtMode === 'panel' ? 'panel' : 'banner',
        minContentWidth,
    });
    if (mode === 'panel') {
        return { kind: 'panel', mode, size, scale: fixed, fixed, metrics };
    }
    // The widening is taken back, and the banner is as wide as the host was before it.
    const restoreAside = surface && mayWiden ? { surface, aside: asideBefore } : null;
    const widthFit = fitBanner(controller.ids, fixed, contentBefore);
    const banner = planBanner({ ids: controller.ids, scale: widthFit, viewportHeight: viewport.height });
    return banner
        ? { kind: 'panel', mode: 'banner', size, scale: banner.scale, fixed, rows: banner.rows, metrics, restoreAside }
        : { kind: 'panel', mode: 'hidden', size, scale: widthFit, fixed, metrics, restoreAside };
}

/**
 * @param {ArtController} controller
 * @param {NonNullable<ReturnType<typeof measurePanel>>} plan
 */
function applyPanel(controller, plan) {
    if (plan.restoreAside) {
        writeDialogAside(plan.restoreAside.surface, plan.restoreAside.aside);
    }
    applyMode(controller, plan);
    queueAlignment(controller);
}

/**
 * Reads what a controller needs to be laid out. Nothing is written but the window width of a widening, which the
 * reads that follow it depend on. The style sheets hold many `:has()` rules, so a read after a write restyles the whole
 * document, and the reads of all controllers come before the first write of any.
 * @param {ArtController} controller
 */
function measure(controller) {
    if (!controller.panel.isConnected) {
        return null;
    }
    controller.seen = true;
    if (controller.kind === 'hero') {
        return measureHero(controller);
    }
    return measurePanel(controller);
}

/**
 * @param {ArtController} controller
 * @param {NonNullable<ReturnType<typeof measure>>} plan
 */
function apply(controller, plan) {
    if (plan.kind === 'hero') {
        applyHero(controller, plan);
        return;
    }
    applyPanel(controller, plan);
}

/** @param {ArtController} controller */
function layout(controller) {
    const plan = measure(controller);
    if (plan) {
        apply(controller, plan);
    }
}

function queueAlignment(controller) {
    if (controller.alignQueued) {
        return;
    }
    controller.alignQueued = true;
    let waited = 0;
    const tick = () => {
        if (!controller.panel.isConnected) {
            controller.alignQueued = false;
            return;
        }
        if (hasTransformedAncestor(controller.panel) && waited++ < ALIGN_WAIT_FRAMES) {
            requestAnimationFrame(tick);
            return;
        }
        controller.alignQueued = false;
        for (const { figure } of controller.figures) {
            alignToDevicePixels(figure);
        }
    };
    requestAnimationFrame(tick);
}

/**
 * Takes a controller out of the layout, and the observers with it when it was the last. A controller that is put
 * back by `register` starts them again.
 * @param {ArtController} controller
 */
function stop(controller) {
    controllers.delete(controller);
    if (controller.host) {
        resizeObserver?.unobserve(controller.host);
        controller.host = null;
    }
    resizeObserver?.unobserve(controller.panel);
    if (controllers.size > 0) {
        return;
    }
    stopScaleWatch?.();
    stopScaleWatch = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    window.removeEventListener('resize', scheduleLayout);
}

function run() {
    frame = 0;
    const plans = [];
    for (const controller of [...controllers]) {
        if (controller.seen && !controller.panel.isConnected) {
            stop(controller);
            continue;
        }
        plans.push([controller, measure(controller)]);
    }
    for (const [controller, plan] of plans) {
        if (plan) {
            apply(controller, plan);
        }
    }
}

function scheduleLayout() {
    if (!frame) {
        frame = requestAnimationFrame(run);
    }
}

function start() {
    if (stopScaleWatch) {
        return;
    }
    stopScaleWatch = watchPixelScale(scheduleLayout);
    window.addEventListener('resize', scheduleLayout);
    if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(scheduleLayout);
    }
}

/**
 * Puts a controller in the layout, and starts the observers when it is the first. It can be called again for a
 * controller that is already in.
 * @param {ArtController} controller
 */
function register(controller) {
    controllers.add(controller);
    start();
    resizeObserver?.observe(controller.panel);
}

const PANEL_TAG = 'sb-art-panel';

/**
 * The panel is a custom element for its connected callbacks. They run as soon as the panel enters the document, before
 * the code that inserted it goes on. A page that a slide brings in is measured right after it is inserted, so a panel
 * that decided its mode a frame later would give that measure the height of the wrong mode. They also take the panel
 * out of the layout when it leaves the document, and put it back when it returns. The panel holds the functions of
 * the module that made it, so a second copy of the module cannot leave a panel with the wrong controller.
 */
function definePanelElement() {
    if (customElements.get(PANEL_TAG)) {
        return;
    }
    customElements.define(PANEL_TAG, class extends HTMLElement {
        #hooks = null;

        bind(hooks) {
            this.#hooks = hooks;
        }

        connectedCallback() {
            this.#hooks?.connected();
        }

        disconnectedCallback() {
            this.#hooks?.disconnected();
        }
    });
}

/**
 * The art of a character as a panel or a banner. The panel is a direct child of the host once appended, so it takes
 * part in the host's own layout, and the host's other children stay where they are. It is `aria-hidden`.
 * It lays itself out when it enters the document and again whenever the host, the window or the screen scale changes.
 * @param {string[]} ids Names in the export spec. More than one stand side by side at the same step.
 * @returns {{ panel: HTMLElement, setArts: (ids: string[]) => void }}
 */
export function createArtPanel(ids) {
    definePanelElement();
    const panel = /** @type {HTMLElement & { bind: (hooks: { connected: () => void, disconnected: () => void }) => void }} */ (document.createElement(PANEL_TAG));
    panel.className = 'sbArtPanel';
    panel.setAttribute('aria-hidden', 'true');
    panel.dataset.sbArtMode = 'banner';
    /** @type {ArtController} */
    const controller = { panel, ids: [], figures: [], host: null, seen: false, alignQueued: false };
    const place = (next) => {
        setFigures(controller, next);
        panel.style.setProperty('--sb-art-pad', `${PANEL_PADDING}px`);
        panel.style.setProperty('--sb-art-figure-gap', `${FIGURE_GAP}px`);
        // Sized for a banner before the panel is in the document, so its first frame already has the room it needs.
        const fixed = readFixedScale();
        const banner = planBanner({ ids: next, scale: fixed, viewportHeight: window.innerHeight });
        // A panel that is shown stays one until the next layout decides, so a change of figures does not flash a banner.
        if (panel.dataset.sbArtMode !== 'panel') {
            panel.dataset.sbArtMode = banner ? 'banner' : 'hidden';
        }
        sizeFigures(controller, banner?.scale ?? fixed, banner?.rows);
    };
    place(ids);
    panel.bind({
        connected() {
            register(controller);
            layout(controller);
        },
        disconnected() {
            stop(controller);
        },
    });
    return {
        panel,
        setArts(next) {
            if (next.length === controller.ids.length && next.every((id, index) => id === controller.ids[index])) {
                return;
            }
            place(next);
            scheduleLayout();
        },
    };
}

/**
 * The hero of Home: one picture in the band, centred above the text. It is `aria-hidden`, and a screen reader reads
 * the text of the band alone.
 * @param {'hero-duo' | 'hero-duo-night'} id
 * @returns {HTMLElement}
 */
export function createHeroArt(id) {
    const figure = createPixelFigure(id);
    figure.classList.add('sbHomeHeroArt');
    figure.setAttribute('aria-hidden', 'true');
    // Sized for the fixed step before it is in the document, and fitted to its band as soon as the band has a width.
    sizePixelFigure(figure, readFixedScale());
    /** @type {ArtController} */
    const controller = { kind: 'hero', panel: figure, ids: [id], figures: [], host: null, seen: false, alignQueued: false };
    register(controller);
    return figure;
}
