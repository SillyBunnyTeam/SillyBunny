/**
 * What the capture spec (`audit/surface-capture.e2e.js`) saves, as data: the file name of a capture, the sets and the
 * variants a run covers, the list of tests and captures that a registry gives, and the summary of a run. Pure functions that
 * import nothing from Playwright, so that Jest runs them.
 *
 * A capture is one surface (or one state of it, or one backend of it) at one viewport in one variant. Its file name is
 *   <surface id>[@<backend>]__<state id | as-found>__<viewport>__<variant id>.png
 * for example `settings.backend.connections@chat-completion__as-found__1440x900__normal-libadwaita.png`. Every part is
 * lowercase words, digits, dots and dashes, so `__` never occurs inside a part. A variant id is `<density>-<theme id>` for
 * the density and theme cells, and the axis id (`forced-colors`, `text-200`, `reduced-motion`) for the extra axes.
 * A test of the spec is one surface at one viewport; its key is `<surface id>__<viewport>`.
 */

import {
    DENSITIES,
    EXTRA_AXES,
    EXTRA_AXIS_VIEWPORT_IDS,
    LEGACY_THEMES,
    THEMES,
    VIEWPORT_IDS,
    viewportsFor,
} from './surface-matrix.js';
import { backendsOf, selectSurfaces, statesFor, validateSurfaces } from './surfaces/index.js';

export const AS_FOUND = 'as-found';
export const NAME_SEPARATOR = '__';
export const CAPTURE_SETS = Object.freeze(['quick', 'full']);
export const DEFAULT_CAPTURE_SET = 'quick';
/** The variant that a run boots in, and the only one of the quick set. */
export const BASE_VARIANT_ID = 'normal-libadwaita';
/** Long names are refused: the diff and actual files that Playwright derives from a name add a suffix, and file names stop at 255 bytes. */
export const MAX_NAME_LENGTH = 180;
/**
 * The per-pixel colour distance above which a pixel counts as different: Playwright's `threshold`, a share of the largest YIQ
 * distance, squared into the limit 35215 x threshold^2, with no pixel allowed above it. The distance weighs the colour channels
 * unequally, so what 0.02 hides depends on the channel (see `hiddenLevels`): the noise at the corners of rounded boxes is
 * within it, and a change of a few levels in a text or border colour can be too. `sameButNotIdentical` is the second signal
 * for what the threshold hides.
 */
export const COLOUR_THRESHOLD = 0.02;

/** The limit that a colour distance must exceed for a pixel to count as different at `threshold`. */
export const distanceLimit = threshold => 35215 * threshold * threshold;

/**
 * Playwright's distance between two opaque colours (the weighted YIQ distance of pixelmatch).
 * @param {readonly [number, number, number]} first
 * @param {readonly [number, number, number]} second
 */
export function colourDistance(first, second) {
    const y = ([r, g, b]) => r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
    const i = ([r, g, b]) => r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
    const q = ([r, g, b]) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
    const dy = y(first) - y(second);
    const di = i(first) - i(second);
    const dq = q(first) - q(second);
    return 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
}

/**
 * The largest change, in levels of 255 and from black, that a pixel can have and still count as the same at `threshold`: for a
 * grey and for each colour channel on its own. This is what the threshold hides.
 * @param {number} [threshold]
 */
export function hiddenLevels(threshold = COLOUR_THRESHOLD) {
    const limit = distanceLimit(threshold);
    const largest = (make) => {
        let level = 0;
        while (level < 255 && colourDistance([0, 0, 0], make(level + 1)) <= limit) {
            level++;
        }
        return level;
    };
    return { grey: largest(level => [level, level, level]), red: largest(level => [level, 0, 0]), green: largest(level => [0, level, 0]), blue: largest(level => [0, 0, level]) };
}

/**
 * How many pixels of a capture may exceed the threshold before the capture counts as changed. Two captures of the same page
 * differ in one to three pixels above the threshold now and then, at the edge of a glyph or a round shape, which a zero limit turns
 * into a failure of an unchanged page. A capture inside this limit is the same, and is listed for review with its count.
 */
export const NOISE_PIXELS = 3;

/** A capture that is the same under the threshold but not identical is listed for review from this many differing pixels, or this many levels. */
export const REVIEW_PIXELS = 20;
export const REVIEW_LEVEL = 8;

/**
 * Whether a difference that the comparison let pass should be looked at.
 * @param {{ pixels: number, maxLevel: number, overThreshold?: number }} difference `overThreshold` is the number of pixels above the threshold (at most `NOISE_PIXELS`).
 */
export const needsReview = ({ pixels, maxLevel, overThreshold = 0 }) => pixels >= REVIEW_PIXELS || maxLevel >= REVIEW_LEVEL || overThreshold > 0;

/**
 * The colour threshold of a run: `CAPTURE_THRESHOLD` when it is set to a number above 0 and below 1, else `COLOUR_THRESHOLD`.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ threshold: number, problem: string | null }}
 */
export function selectThreshold(env = process.env) {
    const raw = (env.CAPTURE_THRESHOLD ?? '').trim();
    if (raw === '') {
        return { threshold: COLOUR_THRESHOLD, problem: null };
    }
    const value = Number(raw);
    return value > 0 && value < 1
        ? { threshold: value, problem: null }
        : { threshold: COLOUR_THRESHOLD, problem: `CAPTURE_THRESHOLD "${raw}" is not a number above 0 and below 1.` };
}
/** @typedef {{ x: number, y: number, width: number, height: number }} Box */

/**
 * The part of the window that a capture of an overlay is compared in: the union of the boxes of every visible match of its root,
 * in both runs, rounded inward to whole pixels (a partly covered pixel at the edge is not the surface's) and cut to the window.
 * The shadow is not part of it: it is painted over the page behind the overlay, which is not compared either. Null when there is no box.
 * @param {readonly (Box | null | undefined)[]} rects
 * @param {{ width: number, height: number }} viewport
 * @returns {Box | null}
 */
export function unionBox(rects, viewport) {
    const boxes = rects.filter(rect => rect && rect.width > 0 && rect.height > 0);
    if (boxes.length === 0) {
        return null;
    }
    const left = Math.max(0, Math.ceil(Math.min(...boxes.map(rect => rect.x))));
    const top = Math.max(0, Math.ceil(Math.min(...boxes.map(rect => rect.y))));
    const right = Math.min(viewport.width, Math.floor(Math.max(...boxes.map(rect => rect.x + rect.width))));
    const bottom = Math.min(viewport.height, Math.floor(Math.max(...boxes.map(rect => rect.y + rect.height))));
    return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/** The corner radius, in pixels, that the rule for the corners uses at most: a larger radius is a pill, and the box is as wide. */
const MAX_CORNER_RADIUS = 48;

/**
 * The pixels of the four corner squares of a box that the comparison leaves out, because the corner is rounded and what shows
 * there is the page behind or an antialiased edge: with `r` the radius, in each r x r corner square the pixels whose centre is
 * farther than r - 1 from the centre of the arc. A changed radius is not hidden by this: see `radiusChange`.
 * @param {Box} box
 * @param {number} radius
 * @returns {number[]} Flat pairs: x0, y0, x1, y1, ...
 */
export function cornerExclusions(box, radius) {
    const r = Math.min(Math.ceil(radius), MAX_CORNER_RADIUS, Math.floor(Math.min(box.width, box.height) / 2));
    if (!(r >= 1)) {
        return [];
    }
    const pixels = [];
    const corners = [
        { left: box.x, top: box.y, cx: box.x + r, cy: box.y + r },
        { left: box.x + box.width - r, top: box.y, cx: box.x + box.width - r, cy: box.y + r },
        { left: box.x, top: box.y + box.height - r, cx: box.x + r, cy: box.y + box.height - r },
        { left: box.x + box.width - r, top: box.y + box.height - r, cx: box.x + box.width - r, cy: box.y + box.height - r },
    ];
    for (const corner of corners) {
        for (let y = corner.top; y < corner.top + r; y++) {
            for (let x = corner.left; x < corner.left + r; x++) {
                if (Math.hypot(x + 0.5 - corner.cx, y + 0.5 - corner.cy) > r - 1) {
                    pixels.push(x, y);
                }
            }
        }
    }
    return pixels;
}

/**
 * Where a capture is compared: the union box of its roots, in both runs, and the corner pixels left out; the whole window (null) when no root has a box.
 * @param {readonly { x: number, y: number, width: number, height: number, radius?: number }[]} roots The roots of both runs.
 * @param {{ width: number, height: number }} viewport
 * @returns {{ box: Box, excluded: number[], radius: number } | null}
 */
export function compareRegion(roots, viewport) {
    const box = unionBox(roots, viewport);
    if (!box) {
        return null;
    }
    const radius = Math.max(0, ...roots.map(root => root.radius ?? 0));
    return { box, excluded: cornerExclusions(box, radius), radius };
}

/**
 * A change of the corner radius between two runs, as a sentence, or null. The corner rule would hide it, so it is reported as a number.
 * @param {number | undefined} baseline
 * @param {number | undefined} actual
 */
export function radiusChange(baseline, actual) {
    if (baseline === undefined || actual === undefined || Math.abs(baseline - actual) <= 0.5) {
        return null;
    }
    return `corner radius ${baseline}px -> ${actual}px`;
}

/** @param {{ x: number, y: number, width: number, height: number } | null} box */
export const describeBox = box => (box ? `x ${box.x}-${box.x + box.width - 1}, y ${box.y}-${box.y + box.height - 1}` : 'the whole window');

/**
 * Why the mask of one element is not applied, or null when it is: it lies outside the window, or the element is covered at its
 * centre and at its four corners (the sample points inside the window all hit something that is neither the element nor inside
 * it). A mask is painted by its box whether or not something covers it, so a covered mask would blank what is on top.
 * @param {{ box: Box, hits: readonly boolean[] }} element `hits` says, for the centre and the corners that lie inside the
 *   window, whether the element is what `elementFromPoint` found there.
 * @param {{ width: number, height: number }} viewport
 * @returns {'outside the window' | 'covered' | null}
 */
export function maskDropReason({ box, hits }, viewport) {
    const inside = box.width > 0 && box.height > 0 && box.x < viewport.width && box.y < viewport.height && box.x + box.width > 0 && box.y + box.height > 0;
    if (!inside) {
        return 'outside the window';
    }
    return hits.length === 0 || hits.some(Boolean) ? null : 'covered';
}

export const maskApplies = (element, viewport) => maskDropReason(element, viewport) === null;

/**
 * Where two runs applied different masks, as a sentence, or null: a mask that one run painted and the other dropped shows as
 * magenta against real pixels.
 * @param {{ applied?: readonly { selector: string, count: number }[], dropped?: readonly { selector: string, count: number, reason: string }[] } | undefined} baseline
 * @param {typeof baseline} actual
 */
export function maskDifference(baseline, actual) {
    if (!baseline || !actual) {
        return null;
    }
    const counts = masks => new Map((masks.applied ?? []).map(entry => [entry.selector, entry.count]));
    const [before, now] = [counts(baseline), counts(actual)];
    const differing = [...new Set([...before.keys(), ...now.keys()])]
        .filter(selector => (before.get(selector) ?? 0) !== (now.get(selector) ?? 0))
        .map((selector) => {
            const reason = (actual.dropped ?? []).find(entry => entry.selector === selector)?.reason ?? (baseline.dropped ?? []).find(entry => entry.selector === selector)?.reason;
            return `${selector} painted on ${before.get(selector) ?? 0} elements, now ${now.get(selector) ?? 0}${reason ? ` (${reason})` : ''}`;
        });
    return differing.length ? `masks differ: ${differing.join('; ')}` : null;
}

/**
 * The scroller of a surface among the candidates that scroll: the one with the largest visible area, the first in document order
 * among equals.
 * @param {readonly { area: number, order: number }[]} candidates
 * @returns {number} The index of the chosen candidate, or -1.
 */
export function chooseScroller(candidates) {
    let best = -1;
    candidates.forEach((candidate, index) => {
        if (candidate.area > 0 && (best < 0 || candidate.area > candidates[best].area || (candidate.area === candidates[best].area && candidate.order < candidates[best].order))) {
            best = index;
        }
    });
    return best;
}

/** The rows of the previous page that the next page repeats, so that a row cut by the edge of a page is seen whole on one of them. */
export const PAGE_OVERLAP = 48;

/**
 * The overlap of two pages for a scroller with a sticky or fixed header and footer of the given heights: they cover rows at the
 * edges of a page, so the next page must repeat at least their height and a margin. Never more than half of the visible height,
 * so that a page always moves on.
 * @param {{ top?: number, bottom?: number, clientHeight?: number }} covered
 */
export const pageOverlap = ({ top = 0, bottom = 0, clientHeight = Infinity } = {}) => Math.min(Math.floor(clientHeight / 2), Math.max(PAGE_OVERLAP, Math.ceil(top + bottom) + 16));
/** The most pages of one capture, the first included. */
export const MAX_PAGES = 40;

const MATRIX = { densities: DENSITIES, themes: THEMES, legacyThemes: LEGACY_THEMES, extraAxes: EXTRA_AXES, extraViewportIds: EXTRA_AXIS_VIEWPORT_IDS, viewportIds: VIEWPORT_IDS };

/**
 * The file name of a capture.
 * A page after the first of a scrolled capture adds `~<page>` to the state part: `home.help__as-found~2__1440x900__...`.
 * @param {{ surface: string, backend?: string, state?: string | null, viewport: string, variant: string, page?: number }} parts
 * @returns {string}
 */
export function captureName({ surface, backend, state, viewport, variant, page = 1 }) {
    const statePart = `${state ?? AS_FOUND}${page > 1 ? `~${page}` : ''}`;
    return [`${surface}${backend ? `@${backend}` : ''}`, statePart, viewport, variant].join(NAME_SEPARATOR) + '.png';
}

/**
 * The parts of a capture's file name, or null when the name is not one that `captureName()` makes.
 * @param {string} fileName
 * @returns {{ surface: string, backend: string | null, state: string | null, page: number, viewport: string, variant: string, key: string } | null}
 */
export function parseCaptureName(fileName) {
    if (!fileName.endsWith('.png')) {
        return null;
    }
    const parts = fileName.slice(0, -'.png'.length).split(NAME_SEPARATOR);
    if (parts.length !== 4 || parts.some(part => part === '')) {
        return null;
    }
    const [head, state, viewport, variant] = parts;
    const [surface, backend = null] = head.split('@');
    if (!/^\d+x\d+$/.test(viewport) || head.split('@').length > 2) {
        return null;
    }
    const [, stateId, pageText] = /^(.+?)(?:~(\d+))?$/.exec(state);
    return { surface, backend, state: stateId === AS_FOUND ? null : stateId, page: pageText ? Number(pageText) : 1, viewport, variant, key: testKey(surface, viewport) };
}

/** The key of the test that makes the captures of a surface at a viewport. */
export const testKey = (surfaceId, viewportId) => `${surfaceId}${NAME_SEPARATOR}${viewportId}`;

/**
 * Every variant cell that exists, in the order a test runs them: density and theme cells first, then the extra axes, then
 * the legacy themes. The legacy themes come last because loading one rewrites many app settings that switching back to
 * Libadwaita does not restore, so no cell may follow them on the same page.
 * `extra` is true for the cells that run at the extra-axis viewports only.
 * @param {typeof MATRIX} [matrix]
 * @returns {{ id: string, extra: boolean, variant: Record<string, unknown> }[]}
 */
export function variantCatalogue(matrix = MATRIX) {
    const cells = [];
    for (const density of matrix.densities) {
        for (const theme of matrix.themes) {
            cells.push({ id: `${density.id}-${theme.id}`, extra: false, variant: { density: density.id, theme: theme.id } });
        }
    }
    for (const axis of matrix.extraAxes) {
        cells.push({ id: axis.id, extra: true, variant: { ...axis.variant } });
    }
    for (const theme of matrix.legacyThemes) {
        cells.push({ id: `normal-${theme.id}`, extra: true, variant: { density: 'normal', theme: theme.id } });
    }
    return cells;
}

const listOf = value => String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);

/**
 * What a run covers, from the environment: `CAPTURE_SET` (`quick`, the default, or `full`), and optionally
 * `CAPTURE_VIEWPORTS` and `CAPTURE_VARIANTS`, comma-separated ids that replace the set's list for that axis.
 * @param {Record<string, string | undefined>} [env]
 * @param {typeof MATRIX} [matrix]
 * @returns {{ set: string, viewports: string[], variants: string[], problems: string[] }}
 */
export function selectCaptures(env = process.env, matrix = MATRIX) {
    const set = (env.CAPTURE_SET ?? '').trim() || DEFAULT_CAPTURE_SET;
    const problems = [];
    if (!CAPTURE_SETS.includes(set)) {
        problems.push(`CAPTURE_SET "${set}" is not one of ${CAPTURE_SETS.join(', ')}.`);
    }
    const catalogue = variantCatalogue(matrix);
    const quick = set === 'quick';
    let viewports = quick ? [...matrix.extraViewportIds] : [...matrix.viewportIds];
    let variants = quick ? [BASE_VARIANT_ID] : catalogue.map(cell => cell.id);
    const wantedViewports = listOf(env.CAPTURE_VIEWPORTS);
    if (wantedViewports.length) {
        problems.push(...wantedViewports.filter(id => !matrix.viewportIds.includes(id)).map(id => `CAPTURE_VIEWPORTS "${id}" is not one of ${matrix.viewportIds.join(', ')}.`));
        viewports = wantedViewports;
    }
    const wantedVariants = listOf(env.CAPTURE_VARIANTS);
    if (wantedVariants.length) {
        problems.push(...wantedVariants.filter(id => !catalogue.some(cell => cell.id === id)).map(id => `CAPTURE_VARIANTS "${id}" is not one of ${catalogue.map(cell => cell.id).join(', ')}.`));
        variants = wantedVariants;
    }
    return { set, viewports, variants, problems };
}

/**
 * Families whose scroller holds content of any length (a chat transcript). A capture of such a surface shows the part that the
 * surface or its state has scrolled to. Later pages would repeat message rows, and the app measures a row's height only when it
 * comes into view, so the page offsets would differ from run to run.
 */
export const UNPAGED_FAMILIES = Object.freeze(new Set(['chat']));

/**
 * How many pages of one surface a run captures.
 * @param {{ family: string }} surface
 * @param {number} maxPages the cap of the run, from `selectPages`
 */
export function pagesFor(surface, maxPages) {
    return UNPAGED_FAMILIES.has(surface.family) ? 1 : maxPages;
}

/**
 * How many pages of a tall surface a run captures, from `CAPTURE_PAGES`: `all` (the default, up to `MAX_PAGES`), `first`, or a number.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ maxPages: number, problem: string | null }}
 */
export function selectPages(env = process.env) {
    const raw = (env.CAPTURE_PAGES ?? '').trim() || 'all';
    if (raw === 'all') {
        return { maxPages: MAX_PAGES, problem: null };
    }
    if (raw === 'first') {
        return { maxPages: 1, problem: null };
    }
    if (/^[1-9]\d*$/.test(raw)) {
        return { maxPages: Math.min(Number(raw), MAX_PAGES), problem: null };
    }
    return { maxPages: MAX_PAGES, problem: `CAPTURE_PAGES "${raw}" is not all, first or a number of pages.` };
}

/**
 * The scroll positions of the pages after the first of a scroller: from where the first page stands, down by the visible height
 * less the overlap, the last page at the end of the content. `capped` is true when the cap stops it before the end.
 * @param {{ scrollTop: number, clientHeight: number, scrollHeight: number, overlap?: number, maxPages?: number }} scroller
 * @returns {{ offsets: number[], capped: boolean }}
 */
export function planPages({ scrollTop, clientHeight, scrollHeight, overlap = PAGE_OVERLAP, maxPages = MAX_PAGES }) {
    const end = Math.max(0, scrollHeight - clientHeight);
    const step = Math.max(1, clientHeight - overlap);
    const offsets = [];
    let at = scrollTop;
    while (at < end - 1 && offsets.length < maxPages - 1) {
        at = Math.min(at + step, end);
        offsets.push(at);
    }
    return { offsets, capped: at < end - 1 };
}

/**
 * The variant cells that a viewport gets, in the order of `variantCatalogue()`: the cells of the selection, without the
 * extra-axis cells at a viewport that does not run them.
 * @param {string} viewportId
 * @param {{ variants: string[] }} selection
 * @param {typeof MATRIX} [matrix]
 */
export function variantCells(viewportId, selection, matrix = MATRIX) {
    const extraHere = matrix.extraViewportIds.includes(viewportId);
    return variantCatalogue(matrix).filter(cell => selection.variants.includes(cell.id) && (!cell.extra || extraHere));
}

/**
 * @typedef {object} PlannedCapture
 * @property {string} name File name.
 * @property {string} surface
 * @property {string | undefined} backend
 * @property {string | null} state `null` for the surface as found.
 * @property {string} viewport
 * @property {string} variant Variant id.
 *
 * @typedef {object} PlannedTest
 * @property {string} key
 * @property {import('./surfaces/index.js').Surface} surface
 * @property {string} viewport
 * @property {PlannedCapture[]} captures In the order they are taken: variant by variant, and in each the backends as found, then the states.
 */

/**
 * The tests of a run and the captures of each, from the surfaces, the selection and the matrix. A surface is captured at the
 * viewports that apply to it (`viewportsFor`) and are selected, with the states that exist there (`statesFor`), and with
 * each backend it lists as found; a state is captured with the first backend, as the registry smoke opens it.
 * A name that is taken twice, too long, or a state called `as-found` is a problem and the surface is left out.
 * @param {readonly import('./surfaces/index.js').Surface[]} surfaces
 * @param {{ viewports: string[], variants: string[] }} selection
 * @param {{ matrix?: typeof MATRIX, viewportsOf?: typeof viewportsFor, matrixViewportsOf?: typeof viewportsFor, statesOf?: typeof statesFor, backendsOf?: typeof backendsOf }} [deps]
 * @returns {{ tests: PlannedTest[], problems: string[], notes: string[] }}
 */
export function planCaptures(surfaces, selection, deps = {}) {
    const { matrix = MATRIX, viewportsOf = viewportsFor, matrixViewportsOf = surface => viewportsFor({ ...surface, viewports: undefined }), statesOf = statesFor, backendsOf: backends = backendsOf } = deps;
    const tests = [];
    const problems = [];
    const names = new Map();
    const notes = [];
    for (const surface of surfaces) {
        const own = [];
        const ownProblems = [];
        const dropped = matrixViewportsOf(surface).filter(id => !viewportsOf(surface).includes(id) && selection.viewports.includes(id));
        if (dropped.length) {
            notes.push(`${surface.id}: its viewports list leaves out ${dropped.join(', ')}, which the matrix gives it.`);
        }
        for (const viewport of viewportsOf(surface).filter(id => selection.viewports.includes(id))) {
            const cells = variantCells(viewport, selection, matrix);
            if (cells.length === 0) {
                continue;
            }
            const captures = [];
            const states = statesOf(surface, viewport);
            for (const state of states) {
                if (state.id === AS_FOUND) {
                    ownProblems.push(`${surface.id}: a state cannot be called "${AS_FOUND}", because that is the file name of the surface as found.`);
                }
            }
            for (const cell of cells) {
                for (const backend of backends(surface)) {
                    captures.push({ surface: surface.id, backend, state: null, viewport, variant: cell.id });
                }
                for (const state of states) {
                    captures.push({ surface: surface.id, backend: backends(surface)[0], state: state.id, viewport, variant: cell.id });
                }
            }
            own.push({ key: testKey(surface.id, viewport), surface, viewport, captures: captures.map(capture => ({ ...capture, name: captureName(capture) })) });
        }
        for (const test of own) {
            for (const capture of test.captures) {
                if (capture.name.length > MAX_NAME_LENGTH) {
                    ownProblems.push(`${surface.id}: the capture name ${capture.name} is longer than ${MAX_NAME_LENGTH} characters.`);
                }
                if (names.has(capture.name)) {
                    ownProblems.push(`${surface.id}: the capture name ${capture.name} is also made by ${names.get(capture.name)}.`);
                }
                names.set(capture.name, surface.id);
            }
        }
        if (ownProblems.length) {
            problems.push(...ownProblems);
        } else {
            tests.push(...own);
        }
    }
    return { tests, problems, notes };
}

/**
 * Everything a run needs to know before it starts, from the environment: the surfaces that the filters choose, those of them
 * that are valid and unique (an invalid entry is left out and listed in `skipped`, so one half-written family does not stop the
 * others, as in the registry smoke), the selection of the matrix, and the tests and captures that result.
 * @param {Record<string, string | undefined>} [env]
 */
export function planRun(env = process.env) {
    const surfaces = selectSurfaces(env);
    const seenIds = new Set();
    const runnable = [];
    const skipped = [];
    for (const surface of surfaces.surfaces) {
        const problems = validateSurfaces([surface]);
        if (seenIds.has(surface.id)) {
            problems.push(`${surface.id}: id is used by another surface.`);
        }
        seenIds.add(surface.id);
        if (problems.length) {
            skipped.push(...problems);
        } else {
            runnable.push(surface);
        }
    }
    const selection = selectCaptures(env);
    const pages = selectPages(env);
    const { tests, problems, notes } = planCaptures(runnable, selection);
    return { surfaces, selection, pages, tests, notes, plannedKeys: tests.map(test => test.key), problems: [...(surfaces.problem ? [surfaces.problem] : []), ...selection.problems, ...(pages.problem ? [pages.problem] : []), ...problems, ...skipped] };
}

/**
 * Where a run's files go. `SB_CAPTURE_DIR` when it is set, otherwise a directory in the Playwright output directory.
 * @param {Record<string, string | undefined>} env
 * @param {string} outputDir
 */
export function captureDirectory(env, outputDir) {
    return env.SB_CAPTURE_DIR?.trim() || `${outputDir}/surface-capture`;
}

/**
 * The mode of a run: `save` saves the captures only; `record` writes the baseline; `compare` compares with it.
 * `SB_VISUAL_RECORD=1` records into an empty baseline directory and refuses one that holds captures; `replace` records over
 * one that does (it clears the directory first). Either without a baseline directory is a mistake, and is reported as a problem.
 * @param {Record<string, string | undefined>} env
 * @returns {{ mode: 'save' | 'record' | 'compare', baselineDir: string | null, replace: boolean, problem: string | null }}
 */
export function captureMode(env) {
    const baselineDir = env.SB_VISUAL_BASELINE_DIR?.trim() || null;
    const flag = (env.SB_VISUAL_RECORD ?? '').trim();
    const record = flag === '1' || flag === 'replace';
    const replace = flag === 'replace';
    if (flag !== '' && flag !== '0' && !record) {
        return { mode: 'save', baselineDir, replace: false, problem: `SB_VISUAL_RECORD "${flag}" is not 1 or replace.` };
    }
    if (record && !baselineDir) {
        return { mode: 'save', baselineDir, replace, problem: 'SB_VISUAL_RECORD needs SB_VISUAL_BASELINE_DIR, the directory to write the baseline to.' };
    }
    if (!baselineDir) {
        return { mode: 'save', baselineDir, replace: false, problem: null };
    }
    return { mode: record ? 'record' : 'compare', baselineDir, replace, problem: null };
}

/**
 * What a baseline was recorded with, against what a run uses now: a sentence for each of the set, the pages setting and the
 * capture tools that differ. A baseline from another set has other variants; one from other tools may have been captured another way.
 * @param {{ set?: string, pages?: number, tools?: string } | null | undefined} stamp `baseline.json`.
 * @param {{ set?: string, pages?: number, tools?: string } | null | undefined} run What the run's tests recorded.
 * @returns {string[]}
 */
export function compareRunInfo(stamp, run) {
    if (!stamp) {
        return ['The baseline has no baseline.json: the set, the pages setting and the tools that recorded it are not known.'];
    }
    if (!run) {
        return [];
    }
    const warnings = [];
    if (run.set !== undefined && stamp.set !== run.set) {
        warnings.push(`The baseline was recorded with the ${stamp.set} set and this run uses ${run.set}: the variants differ.`);
    }
    if (run.pages !== undefined && stamp.pages !== run.pages) {
        warnings.push(`The baseline was recorded with the pages setting ${stamp.pages} and this run uses ${run.pages}.`);
    }
    if (run.tools !== undefined && stamp.tools !== run.tools) {
        warnings.push(`The capture tools differ from the ones that recorded the baseline (${stamp.tools ?? 'unknown'} then, ${run.tools} now).`);
    }
    return warnings;
}

/**
 * Whether a process that starts is part of a run whose files are in the capture directory: another shard of it. Shards are
 * started by one parent at the same time, and a run that has written its summary is over.
 * @param {{ ppid?: number } | null | undefined} marker `.run.json` of the capture directory.
 * @param {number} ppid The parent process of the process that starts.
 * @param {boolean} summaryWritten
 */
export const isSameRun = (marker, ppid, summaryWritten) => Boolean(marker) && marker.ppid === ppid && !summaryWritten;

/**
 * What Playwright's comparison says about two images, as numbers: the number of different pixels, and the two sizes when they differ.
 * @param {string} message The message of the failed `toMatchSnapshot()`.
 * @returns {{ pixels: number | null, baselineSize: string | null, actualSize: string | null }}
 */
export function readComparison(message) {
    const pixels = /(\d+) pixels \(ratio [\d.]+ of all image pixels\) are different/.exec(message);
    const sizes = /Expected an image (\d+px by \d+px), received (\d+px by \d+px)/.exec(message);
    return { pixels: pixels ? Number(pixels[1]) : null, baselineSize: sizes?.[1] ?? null, actualSize: sizes?.[2] ?? null };
}

/**
 * Whether a baseline file belongs to the part of the registry that a run covered: its families, surfaces, viewports and
 * variants, and the pages it captured (a run that captures the first page only does not cover the later pages of a baseline).
 * @param {ReturnType<typeof parseCaptureName>} parsed
 * @param {{ families?: string[], surfaceIds?: string[], viewports: string[], variants: string[], maxPages?: number }} scope
 */
export function inScope(parsed, scope) {
    if (!parsed) {
        return false;
    }
    const familyOk = !scope.families?.length || scope.families.includes(parsed.surface.split('.')[0]);
    const idOk = !scope.surfaceIds?.length || scope.surfaceIds.includes(parsed.surface);
    const pageOk = scope.maxPages === undefined || parsed.page <= scope.maxPages;
    return familyOk && idOk && pageOk && scope.viewports.includes(parsed.viewport) && scope.variants.includes(parsed.variant);
}

/**
 * Baseline files that this run did not capture, among the ones it covers: a file of a test that ran and made no capture
 * of that name, or of a test that the registry no longer has (a surface that is gone or a viewport that no longer applies to it).
 * A file of a test that is planned but did not run (another shard's) is left out, because this run cannot know.
 * @param {readonly string[]} baselineNames
 * @param {{ captured: Set<string>, ran: Set<string>, planned: Set<string>, scope: Parameters<typeof inScope>[1] }} run
 * @returns {string[]}
 */
export function baselinesWithoutCapture(baselineNames, { captured, ran, planned, scope }) {
    return baselineNames.filter((name) => {
        const parsed = parseCaptureName(name);
        if (!inScope(parsed, scope) || captured.has(name)) {
            return false;
        }
        return ran.has(parsed.key) || !planned.has(parsed.key);
    }).sort();
}

/**
 * @typedef {object} CaptureResult
 * @property {string} name
 * @property {'saved' | 'recorded' | 'same' | 'changed' | 'unstable' | 'new' | 'error'} status
 * @property {string} [actual] Path of the capture.
 * @property {string} [baseline] Path of the baseline file.
 * @property {string} [diff] Path of the diff image, for `changed`.
 * @property {number | null} [pixels] Different pixels, for `changed` and `unstable`; null when the sizes differ and Playwright gives none.
 * @property {number} [retryPixels] For `unstable`: the pixels that the second capture, taken after a fresh open, still differs by (0 under the threshold).
 * @property {string} [baselineSize]
 * @property {string} [actualSize]
 * @property {string} [compared] The part of the window that was compared (`describeBox`).
 * @property {string} [where] Where the compared pixels differ (box and element).
 * @property {string} [reason] Why a changed capture counts without a pixel count: the pages, the corner radius, the masks.
 * @property {string} [maskNote] Where the masks of the two runs differ.
 * @property {{ pixels: number, maxLevel: number, where: string }} [nearSame] For `same`: the pixels that differ at all in the compared part, with the largest difference of a colour channel in levels.
 * @property {number} [outside] Pixels that differ outside the compared part (information only).
 * @property {string[]} [notes] Waits that stopped at their limit while the page was prepared.
 * @property {string} [message] The reason, for `error`.
 * @property {boolean} [capped] The page cap stopped the pages of this capture before the end of its scroller.
 * @property {string} [pagesChange] On the first page of a scrolled capture: "pages a->b, scrollHeight c->d", when the page count differs from the baseline's.
 *
 * @typedef {object} Fragment The result of one test, written when it ends.
 * @property {string} key
 * @property {number} durationMs
 * @property {CaptureResult[]} captures
 * @property {string} [error] A failure of the test as a whole (the boot).
 * @property {{ set?: string, pages?: number, tools?: string }} [run] What the test ran with.
 */

const withoutPage = (name) => {
    const parsed = parseCaptureName(name);
    return parsed ? captureName({ ...parsed, page: 1 }) : name;
};
const pageOf = name => parseCaptureName(name)?.page ?? 1;

/**
 * The summary of a run, from the fragments that its tests wrote.
 * Pages after the first of a capture whose page count differs from the baseline's are listed under that capture, not as changes of their own.
 * @param {{ mode: string, fragments: readonly Fragment[], planned?: readonly string[], baselineNames?: readonly string[] | null, scope?: Parameters<typeof inScope>[1] | null, selection?: object, baselineDir?: string | null, stamp?: { set?: string, pages?: number, tools?: string } | null }} input
 * `stamp` is `baseline.json` (`null`: there is none; `undefined`: not looked for).
 */
export function buildSummary({ mode, fragments, planned = [], baselineNames = null, scope = null, selection = {}, baselineDir = null, stamp = undefined }) {
    const results = fragments.flatMap(fragment => fragment.captures);
    const byStatus = status => results.filter(result => result.status === status);
    const ran = new Set(fragments.map(fragment => fragment.key));
    const plannedSet = new Set(planned);
    const pagedParents = new Map(results.filter(result => result.pagesChange && result.status === 'changed').map(result => [result.name, result]));
    const underPagedParent = name => pageOf(name) > 1 && pagedParents.has(withoutPage(name));
    const shiftedOf = parent => results.filter(result => result.status === 'changed' && pageOf(result.name) > 1 && withoutPage(result.name) === parent).map(({ name, pixels }) => ({ name, pixels }));
    const changed = byStatus('changed').filter(result => !underPagedParent(result.name)).map(result => ({
        name: result.name,
        pixels: result.pixels,
        ...(result.baselineSize && { baselineSize: result.baselineSize, actualSize: result.actualSize }),
        compared: result.compared,
        ...(result.where && { where: result.where }),
        ...(result.reason && { reason: result.reason }),
        ...(result.maskNote && { maskNote: result.maskNote }),
        ...(result.retryPixels !== undefined && { retryPixels: result.retryPixels }),
        ...(pagedParents.has(result.name) && { shiftedPages: shiftedOf(result.name) }),
        baseline: result.baseline,
        actual: result.actual,
        diff: result.diff,
    }));
    const unstable = byStatus('unstable').map(({ name, pixels, retryPixels, where, baseline, actual, diff }) => ({ name, pixels, retryPixels, where, baseline, actual, diff }));
    const beyondBaseline = result => stamp && typeof stamp.pages === 'number' && pageOf(result.name) > stamp.pages;
    const added = byStatus('new').filter(result => !underPagedParent(result.name) && !beyondBaseline(result)).map(({ name, actual }) => ({ name, actual }));
    const addedBeyond = byStatus('new').filter(beyondBaseline).length;
    const errors = [
        ...byStatus('error').map(({ name, message }) => ({ name, message })),
        ...fragments.filter(fragment => fragment.error).map(fragment => ({ name: fragment.key, message: fragment.error })),
    ];
    const capped = results.filter(result => result.capped).map(result => result.name);
    const missing = (mode === 'compare' && baselineNames && scope
        ? baselinesWithoutCapture(baselineNames, { captured: new Set(results.filter(result => result.status !== 'error').map(result => result.name)), ran, planned: plannedSet, scope })
        : []).filter(name => !underPagedParent(name));
    const nearSame = byStatus('same').filter(result => result.nearSame?.pixels > 0)
        .map(result => ({ name: result.name, pixels: result.nearSame.pixels, maxLevel: result.nearSame.maxLevel, ...(result.nearSame.overThreshold > 0 && { overThreshold: result.nearSame.overThreshold }), where: result.nearSame.where, review: needsReview(result.nearSame) }))
        .sort((a, b) => b.pixels - a.pixels || b.maxLevel - a.maxLevel || a.name.localeCompare(b.name));
    const outside = results.filter(result => result.outside > 0).map(({ name, outside: pixels }) => ({ name, pixels }));
    const limits = results.filter(result => result.notes?.length).map(({ name, notes }) => ({ name, notes }));
    const warnings = [
        ...(mode === 'compare' && stamp !== undefined ? compareRunInfo(stamp, fragments.find(fragment => fragment.run)?.run) : []),
        ...(addedBeyond ? [`${addedBeyond} later pages are new because the baseline was recorded with the first ${stamp.pages} page${stamp.pages === 1 ? '' : 's'} only; they are not listed.`] : []),
    ];
    return {
        mode,
        baselineDir,
        selection,
        warnings,
        totals: {
            tests: fragments.length,
            testsPlanned: plannedSet.size,
            captures: results.length,
            saved: byStatus('saved').length,
            recorded: byStatus('recorded').length,
            same: byStatus('same').length,
            changed: changed.length,
            unstable: unstable.length,
            new: added.length,
            baselineOnly: missing.length,
            errors: errors.length,
            pages: results.filter(result => /~\d+__/.test(result.name)).length,
            capped: capped.length,
            sameNotIdentical: nearSame.length,
            review: nearSame.filter(entry => entry.review).length,
            outside: outside.length,
            waitLimits: limits.length,
        },
        notRun: planned.filter(key => !ran.has(key)),
        changed,
        unstable,
        new: added,
        baselineOnly: missing,
        errors,
        sameNotIdentical: nearSame,
        outside,
        waitLimits: limits,
        capped,
    };
}

/**
 * The exit status of a summary: 1 when a capture changed, is unstable or failed, or a planned test did not run.
 * @param {ReturnType<typeof buildSummary>} summary
 */
export const exitCodeOf = summary => (summary.totals.changed || summary.totals.unstable || summary.totals.errors || summary.notRun.length ? 1 : 0);

const LIST_LIMIT = 300;

/**
 * The summary as Markdown, for a person to read; `summary.json` has every entry.
 * @param {ReturnType<typeof buildSummary>} summary
 * @returns {string}
 */
export function renderSummary(summary) {
    const { totals } = summary;
    const lines = [`# Capture summary (${summary.mode})`, ''];
    lines.push(`- Tests: ${totals.tests} of ${totals.testsPlanned} planned. Captures: ${totals.captures} (${totals.pages} of them later pages of a scrolled capture).`);
    if (summary.mode === 'compare') {
        lines.push(`- Same: ${totals.same} (${totals.sameNotIdentical} of them not identical, ${totals.review} to review). Changed: ${totals.changed}. Unstable: ${totals.unstable}. New without a baseline: ${totals.new}. Baseline without a capture: ${totals.baselineOnly}. Errors: ${totals.errors}.`);
        lines.push(`- Baseline: ${summary.baselineDir}`);
    } else if (summary.mode === 'record') {
        lines.push(`- Recorded: ${totals.recorded}. Errors: ${totals.errors}. Baseline: ${summary.baselineDir}`);
    } else {
        lines.push(`- Saved: ${totals.saved}. Errors: ${totals.errors}.`);
    }
    const section = (title, entries, line, note = null) => {
        if (entries.length === 0) {
            return;
        }
        lines.push('', `## ${title} (${entries.length})`, '', ...(note ? [note, ''] : []));
        lines.push(...entries.slice(0, LIST_LIMIT).map(line));
        if (entries.length > LIST_LIMIT) {
            lines.push(`- ... ${entries.length - LIST_LIMIT} more in summary.json`);
        }
    };
    section('Warnings', summary.warnings ?? [], warning => `- ${warning}`);
    section('Changed', summary.changed, (entry) => {
        const headline = [
            entry.reason,
            entry.baselineSize ? `size changed (baseline ${entry.baselineSize}, now ${entry.actualSize})` : (typeof entry.pixels === 'number' ? `${entry.pixels} px differ` : (entry.reason ? null : 'differs (the pixel count could not be read)')),
        ].filter(Boolean).join('; ');
        return [
            `- \`${entry.name}\`: ${headline}`,
            `  - compared ${entry.compared ?? 'the whole window'}${entry.where ? `; ${entry.where}` : ''}`,
            ...(entry.maskNote ? [`  - ${entry.maskNote}`] : []),
            ...(entry.retryPixels !== undefined ? [`  - taken again after a fresh open: ${entry.retryPixels} px differ`] : []),
            ...(entry.shiftedPages?.length ? [`  - shifted pages: ${entry.shiftedPages.map(page => `\`${page.name}\` (${page.pixels ?? '?'} px)`).join(', ')}`] : []),
            `  - baseline ${entry.baseline}`,
            `  - actual ${entry.actual}`,
            `  - diff ${entry.diff}`,
        ].join('\n');
    });
    section('Unstable (changed once, equal to the baseline when taken again after a fresh open)', summary.unstable ?? [], entry => [
        `- \`${entry.name}\`: ${entry.pixels ?? '?'} px differ at the first capture, ${entry.retryPixels ?? 0} at the second${entry.where ? `; ${entry.where}` : ''}`,
        `  - actual ${entry.actual}`,
        `  - diff ${entry.diff}`,
    ].join('\n'));
    section('New captures without a baseline', summary.new, entry => `- \`${entry.name}\``);
    section('Baselines without a capture', summary.baselineOnly, name => `- \`${name}\``);
    section('Errors', summary.errors, entry => `- \`${entry.name}\`: ${entry.message}`);
    section('Same under the threshold, not identical', summary.sameNotIdentical ?? [], entry => `- \`${entry.name}\`: ${entry.pixels} px, largest difference ${entry.maxLevel} levels${entry.overThreshold ? `, ${entry.overThreshold} px above the threshold` : ''}${entry.review ? ' REVIEW' : ''}; ${entry.where}`, `These do not fail the run. REVIEW marks ${REVIEW_PIXELS} pixels or more, ${REVIEW_LEVEL} levels or more, or any pixel above the threshold (up to ${NOISE_PIXELS} pass).`);
    section('Differences outside the compared box (information only)', summary.outside ?? [], entry => `- \`${entry.name}\`: outside the compared box: ${entry.pixels} px`);
    section('Waits that stopped at their limit', summary.waitLimits ?? [], entry => `- \`${entry.name}\`: ${entry.notes.join('; ')}`);
    section('Captures that stopped at the page cap', summary.capped, name => `- \`${name}\``);
    section('Tests that did not run', summary.notRun, key => `- \`${key}\``);
    lines.push('');
    return lines.join('\n');
}
