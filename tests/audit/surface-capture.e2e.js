import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isOverlaySurface, variantContextOptions } from '../helpers/surface-matrix.js';
import { bootSurfaceApp, openSurface, rebootSurfaceApp } from '../helpers/surfaces/boot.js';
import {
    MAX_PAGES, NOISE_PIXELS, captureDirectory, captureMode, captureName, compareRegion, describeBox, maskDifference, pageOverlap, pagesFor, planPages, planRun,
    radiusChange, readComparison, selectThreshold, variantCells,
} from '../helpers/capture-plan.js';
import {
    capturesPath, diffsPath, readSidecar, startRun, toolsFingerprint, writeFileAtomic, writeFragment, writeSidecar, writeSummaryWhenComplete,
} from '../helpers/capture-files.js';
import {
    compareScreenshots, findScroller, holdArtStill, keepsPointerAndFocus, measureCovered, measureRoots, pasteRegion, prepareForCapture, readScroller,
    resetScrollerTop, scrollScrollerTo, stableScreenshot, startClockAtFixedTime, tagMasks, waitForScrollerStable,
} from '../helpers/capture-page.js';
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- The mode of the run, the backends and the states of a surface decide what a test does. */

// Saves a screenshot of every registered surface, state and backend at every viewport and variant of the test matrix
// (`test-matrix.md`), the same way every time, and compares the set with a baseline that was recorded from another commit
// on the same machine. Opt-in: it runs under `playwright.audit.config.js` only. Run it from `tests/` through `~/bin/e2e`,
// for example `~/bin/e2e -w 3 -c playwright.audit.config.js audit/surface-capture.e2e.js`.
//
// What it reads (every variable is optional):
//   SURFACE_FAMILY, SURFACE_ID   limit the run to families and surface ids, comma-separated, as the registry smoke does.
//   CAPTURE_SET                  `quick` (default): density normal, theme Libadwaita, at 1440x900 and 390x844.
//                                `full`: the whole matrix: every viewport that applies to a surface, density normal and
//                                compact, the themes Libadwaita and Libadwaita Light, and at 1440x900 and 390x844 also the
//                                legacy themes (`LEGACY_THEMES`), forced colours, 200% text and reduced motion.
//   CAPTURE_VIEWPORTS            comma-separated viewport ids (`1024x600,390x844`); replaces the set's list. A surface is still
//                                captured only at the viewports that apply to it.
//   CAPTURE_VARIANTS             comma-separated variant ids (`normal-libadwaita,compact-libadwaita`, `forced-colors`,
//                                `text-200`, `reduced-motion`, `normal-<legacy theme id>`); replaces the set's list. The
//                                extra axes exist at 1440x900 and 390x844 only.
//   SB_CAPTURE_DIR               where the captures, diffs and summary go. Default: `surface-capture/` in the Playwright output
//                                directory, which `~/bin/e2e` puts in `/tmp` (RAM): set a directory on disk for the full set.
//                                A run first removes its own files there (`captures/`, `diffs/`, `.results/`, `summary.*`), once
//                                per run: a shard of the same run (the same parent process, no summary yet) leaves them alone.
//   SB_VISUAL_BASELINE_DIR       the baseline directory. Alone: compare with it. With SB_VISUAL_RECORD: write the baseline there.
//   SB_VISUAL_RECORD             `1` writes the baseline into a directory that holds no captures (and refuses one that does);
//                                `replace` clears the directory and records into it. Needs SB_VISUAL_BASELINE_DIR. A baseline
//                                gets `baseline.json` (commit, tools, set, pages, selection, date).
//   CAPTURE_PAGES                `all` (default): a surface whose scroller has more content than it shows is captured page by page,
//                                up to 40 pages; `first` captures the first screen only; a number caps the pages. Page 2 and on have
//                                `~<page>` after the state part of the name. The scroller is the one with the largest visible area among
//                                the elements that scroll in the root, its descendants and its ancestors; a page scrolls by the visible
//                                height less the overlap (48 px, or the sticky and fixed height at the edges plus 16), from where the open
//                                step left the scroller. A page count that differs from the baseline's fails that capture.
//   CAPTURE_ART_HOLD             `auto` (default): the art that plays in script is held still, only when a figure is in the window and
//                                nothing covers it (see `holdArtStill`). `always` and `off` are for finding out what the hold changes.
//   CAPTURE_INJECT_CSS           test-only: a stylesheet added to every page after its boot, to prove that a small change shows in
//                                the comparison. Refused in record mode.
//   CAPTURE_BOOT                 `reuse` (default): one context and page per surface and viewport, loaded again for each variant
//                                (`rebootSurfaceApp`), so that a cell does not start from the last state of the one before.
//                                `fresh`: a new context and boot for every capture; slower, and the reference that the shared
//                                boot can be checked against.
//
// Files: `captures/<name>.png` for each capture, `<name>` being
//   <surface id>[@<backend>]__<state id | as-found>__<viewport>__<variant id>.png
// and `captures/<name>.json` for what it measured (the boxes of the root, the masks that applied, the scroller). A baseline has the
// same pair of files. In compare mode `diffs/<name>.png` for each changed one, and at the end of the run `summary.json` and
// `summary.md`: changed captures, unstable ones, new captures with no baseline, baselines with no capture, errors, and, for
// information, the captures that are the same under the threshold but not identical, the differences outside the compared box and
// the waits that stopped at their limit. A changed or unstable capture and an error fail the test softly (the run goes on); a new
// capture or a baseline without a capture is listed and does not fail.
// The comparison is Playwright's own (`toMatchSnapshot`) with a colour threshold of 0.02 (`COLOUR_THRESHOLD`; what it hides per colour
// channel is in `hiddenLevels`), and no pixel allowed above it. A capture that is the same under it but not identical is run through
// the tool's own comparer at no threshold, and listed by pixel count and level. Two screenshots of one capture are the same
// under the same threshold. CAPTURE_THRESHOLD=<0..1> sets another one.
// An overlay (a surface of the dialog, menu or panel family, or one with `overlay: true`, or a state that has a root of its own)
// is compared in the union of the boxes of its root in both runs, without the pixels at its rounded corners; the window around it
// is saved but not compared (differences there are listed for information).
// A changed capture is taken once more after a fresh open of its surface: when that equals the baseline it is listed as unstable,
// and fails the run all the same.
// Do not pass `--update-snapshots`: the baseline is written only in record mode.
// The summary is written by the test that ends last. When a run is cut short, `node audit/capture-summary.js` (same
// variables) writes it from what the tests left. With `-s`/shards each shard needs the same SB_CAPTURE_DIR.
//
// Determinism: a clock that starts at a fixed time (only `Date` is shifted; a clock that stands still stops the app's jQuery
// animations), the time zone and locale of the audit config, the seeded data, animations and the caret off, the regions that a
// surface lists in `masks` painted over where they are on show, the art that plays in script held still where it is in the window,
// the pointer taken out of the page and the focus away from the open steps (unless the state id has `hover` or `focus` in it), the
// window scrolled to the top and a surface as found (not the chat) at the top of its scrollers, fonts loaded, pictures decoded,
// and each capture taken until two screenshots in a row are the same.

// Text over a layer that the browser composites on its own is drawn with grey antialiasing, and over one that it does not, with
// the colour fringes of LCD text: which of the two a capture gets depends on how far the page's layers had got when it was painted,
// and it moved the text of a whole page (thousands of pixels) between two runs. Grey everywhere is the same on every run.
test.use({ launchOptions: { args: ['--disable-lcd-text'] } });

const BOOT_MODE = (process.env.CAPTURE_BOOT ?? 'reuse').trim() || 'reuse';
const ART_HOLD = (process.env.CAPTURE_ART_HOLD ?? 'auto').trim() || 'auto';
const { threshold: COLOUR_THRESHOLD, problem: thresholdProblem } = selectThreshold();
const INJECT_CSS = process.env.CAPTURE_INJECT_CSS ?? '';
const mode = captureMode(process.env);
const plan = planRun();
const plannedKeys = plan.plannedKeys;
const here = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = toolsFingerprint([
    fileURLToPath(import.meta.url),
    ...['capture-files.js', 'capture-page.js', 'capture-plan.js'].map(name => path.join(here, '..', 'helpers', name)),
]);
const RUN_INFO = { set: plan.selection.set, pages: plan.pages.maxPages, tools: TOOLS };

// The runner loads this file once per run, and each worker loads it again; only the runner starts the run (and never for `--list`).
if (process.env.TEST_WORKER_INDEX === undefined) {
    const { problem } = startRun({ tools: TOOLS });
    if (problem) {
        throw new Error(problem);
    }
}

test('the capture selection is valid', () => {
    const problems = [
        ...(mode.problem ? [mode.problem] : []),
        ...(thresholdProblem ? [thresholdProblem] : []),
        ...(['reuse', 'fresh'].includes(BOOT_MODE) ? [] : [`CAPTURE_BOOT "${BOOT_MODE}" is not reuse or fresh.`]),
        ...(['auto', 'always', 'off'].includes(ART_HOLD) ? [] : [`CAPTURE_ART_HOLD "${ART_HOLD}" is not auto, always or off.`]),
        ...(INJECT_CSS && mode.mode === 'record' ? ['CAPTURE_INJECT_CSS is refused in record mode: it would write the change into the baseline.'] : []),
        ...plan.problems,
    ];
    expect(problems, 'problems with the selection (a surface with a problem is not captured)').toEqual([]);
    expect(plan.tests.length, 'tests to run').toBeGreaterThan(0);
    if (plan.notes.length) {
        test.info().annotations.push({ type: 'viewports left out by a surface', description: plan.notes.join('\n') });
    }
});

/** Points Playwright's snapshot path at the baseline directory, and returns where the files of this spec's baseline are. */
function baselineFilesDirectory(testInfo) {
    // `snapshotDir` is the root of the default snapshot path template, so the baseline can live outside the repository
    // without a config of its own. The guard fails at once if a Playwright update stops honouring it.
    testInfo.project.snapshotDir = mode.baselineDir;
    // The platform suffix (`-linux`) is off: a baseline is named like its capture. A file that Playwright cannot find under the
    // exact path that is checked here would be written by it as a new baseline and would pass, so the guard names the path.
    testInfo.snapshotSuffix = '';
    const probe = testInfo.snapshotPath('', 'probe.png');
    const relative = path.relative(path.resolve(mode.baselineDir), probe);
    if (relative.startsWith('..') || path.isAbsolute(relative) || path.basename(probe) !== 'probe.png') {
        throw new Error(`Playwright resolves baselines to ${probe}, which is not <SB_VISUAL_BASELINE_DIR>/<dir>/<name> (${mode.baselineDir}).`);
    }
    return path.dirname(probe);
}

/** What a capture measured, by result: written to its sidecar, with the paging added once the pages are known. */
const sidecars = new WeakMap();

const largestRadius = roots => Math.max(0, ...(roots ?? []).map(root => root.radius ?? 0));

/**
 * Takes one capture of the open surface: prepares the page, screenshots it, saves the file and, by mode, records it or
 * compares it. Returns the result; it does not fail the test. With `dry` it writes no file (a second look at a changed capture).
 */
async function takeCapture({ page, testInfo, dir, planned, root, masks, keepState, overlay, dry = false }) {
    const viewport = page.viewportSize();
    const { restore, notes } = await prepareForCapture(page, { root, keepPointerAndFocus: keepState });
    const art = await holdArtStill(page, { overlay, reducedMotionVariant: planned.variant === 'reduced-motion', mode: ART_HOLD });
    if (art.note) {
        notes.push(art.note);
    }
    let shot;
    let roots;
    try {
        roots = await measureRoots(page, root);
        if (overlay && roots.length === 0) {
            throw new Error(`${root} has no visible box to compare in.`);
        }
        shot = await stableScreenshot(page, { maskProvider: () => tagMasks(page, masks), region: overlay ? compareRegion(roots, viewport) : null, threshold: COLOUR_THRESHOLD });
    } finally {
        await art.release();
        await restore();
    }
    const { buffer, stable, unstableRegion, maskReport } = shot;
    // The pages of a long surface add up: each capture buys the time it takes.
    testInfo.setTimeout(testInfo.timeout + 10_000);
    const actual = path.join(capturesPath(dir), planned.name);
    const sidecar = { roots, masks: maskReport };
    const result = { name: planned.name, status: 'saved', actual, compared: 'the whole window', ...(notes.length && { notes }), ...(art.held && { artHeld: true }) };
    sidecars.set(result, sidecar);
    if (!dry) {
        writeFileAtomic(actual, buffer);
        writeSidecar(actual, sidecar);
    }
    if (!stable) {
        return { ...result, status: 'error', message: `the page was still changing: four screenshots in a row were not the same (the last two: ${unstableRegion ?? 'no region'})` };
    }
    if (mode.mode === 'record') {
        const baseline = testInfo.snapshotPath('', planned.name);
        if (!dry) {
            writeFileAtomic(baseline, buffer);
            writeSidecar(baseline, sidecar);
        }
        return { ...result, status: 'recorded', baseline };
    }
    if (mode.mode !== 'compare') {
        return result;
    }
    const baseline = testInfo.snapshotPath('', planned.name);
    if (!fs.existsSync(baseline)) {
        return { ...result, status: 'new' };
    }
    const baselineBuffer = fs.readFileSync(baseline);
    const baselineSidecar = readSidecar(baseline);
    const region = overlay ? compareRegion([...roots, ...(baselineSidecar?.roots ?? [])], viewport) : null;
    const compared = describeBox(region?.box ?? null);
    const maskNote = maskDifference(baselineSidecar?.masks, maskReport);
    if (baselineBuffer.equals(buffer)) {
        return { ...result, status: 'same', baseline, compared };
    }
    // The second signal and the count outside the compared part: every pixel that differs at all, whatever the threshold.
    const fine = await compareScreenshots(page, baselineBuffer, buffer, { any: true, region });
    const found = { compared, baseline, ...(fine.outside > 0 && { outside: fine.outside }) };
    const radius = overlay ? radiusChange(baselineSidecar ? largestRadius(baselineSidecar.roots) : undefined, largestRadius(roots)) : null;
    try {
        const errorsBefore = testInfo.errors.length;
        const compareBuffer = region ? await pasteRegion(page, baselineBuffer, buffer, region) : buffer;
        expect(compareBuffer).toMatchSnapshot([planned.name], { threshold: COLOUR_THRESHOLD, maxDiffPixels: NOISE_PIXELS });
        if (testInfo.errors.length > errorsBefore) {
            throw new Error(`Playwright recorded an error for ${planned.name} instead of comparing it: ${testInfo.errors.at(-1).message}`);
        }
        if (radius) {
            return { ...result, ...found, status: 'changed', pixels: 0, reason: radius };
        }
        if (fine.count === 0) {
            return { ...result, ...found, status: 'same' };
        }
        // Up to `NOISE_PIXELS` pixels above the threshold pass the comparison; their number is reported, so that none passes unseen.
        const overThreshold = (await compareScreenshots(page, baselineBuffer, buffer, { threshold: COLOUR_THRESHOLD, region })).count;
        return { ...result, ...found, status: 'same', nearSame: { pixels: fine.count, maxLevel: fine.maxLevel, where: fine.description, ...(overThreshold > 0 && { overThreshold }) } };
    } catch (error) {
        const read = readComparison(String(error.message));
        const produced = testInfo.outputPath(planned.name.replace(/\.png$/, '-diff.png'));
        const diff = path.join(diffsPath(dir), planned.name);
        if (!dry && fs.existsSync(produced)) {
            fs.mkdirSync(path.dirname(diff), { recursive: true });
            fs.copyFileSync(produced, diff);
        }
        const coarse = await compareScreenshots(page, baselineBuffer, buffer, { threshold: COLOUR_THRESHOLD, region });
        return {
            ...result,
            ...found,
            status: 'changed',
            where: coarse.description,
            pixels: read.pixels ?? (read.baselineSize ? null : coarse.count),
            ...(read.baselineSize && { baselineSize: read.baselineSize, actualSize: read.actualSize }),
            ...(radius && { reason: radius }),
            ...(maskNote && { maskNote }),
            ...(!dry && fs.existsSync(diff) && { diff }),
        };
    }
}

/**
 * Records how many pages the scroller of a capture gives, in its sidecar and in the baseline's, and, when comparing, fails a capture
 * whose page count differs from the baseline's: its later pages are then not comparable, and are listed under it.
 */
function notePaging({ first, paging, dry }) {
    first.paging = paging;
    const sidecar = sidecars.get(first);
    if (sidecar) {
        sidecar.paging = paging;
        if (!dry && first.actual) {
            writeSidecar(first.actual, sidecar);
        }
        if (!dry && mode.mode === 'record' && first.baseline) {
            writeSidecar(first.baseline, sidecar);
        }
    }
    if (mode.mode !== 'compare' || !first.baseline) {
        return;
    }
    const before = readSidecar(first.baseline)?.paging;
    if (!before || before.total === paging.total) {
        return;
    }
    const change = `pages ${before.total}->${paging.total}, scrollHeight ${before.scrollHeight ?? 'none'}->${paging.scrollHeight ?? 'none'}`;
    Object.assign(first, { status: 'changed', pixels: first.pixels ?? 0, reason: first.reason ? `${change}; ${first.reason}` : change, pagesChange: change });
}

/**
 * Measures the scroller of the surface, and captures the pages of it after the one that the open step left, each from a new scroll
 * position, and puts the scroller back. A surface that hits the page cap gets `capped` on its first capture.
 */
async function capturePages({ page, testInfo, dir, item, root, masks, keepState, overlay, first, results, maxPages, dry }) {
    const found = await findScroller(page, root);
    if (!found) {
        notePaging({ first, paging: { total: 1, scrollHeight: null }, dry });
        return;
    }
    const { element: scroller, descriptor } = found;
    try {
        const start = await readScroller(scroller);
        const overlap = pageOverlap({ ...await measureCovered(scroller), clientHeight: start.clientHeight });
        const total = 1 + planPages({ ...start, overlap, maxPages: MAX_PAGES }).offsets.length;
        first.scroller = `${start.scrollTop}/${start.scrollHeight}/${start.clientHeight}`;
        notePaging({ first, paging: { total, scrollHeight: start.scrollHeight, clientHeight: start.clientHeight, scroller: descriptor.label, overlap }, dry });
        let last = start.scrollTop;
        let capped = false;
        // The next page is planned from the scroller as it is after the last one, because the height can change while it scrolls.
        for (let number = 2; number <= maxPages + 1 && maxPages > 1; number++) {
            const now = await readScroller(scroller);
            const { offsets } = planPages({ ...now, scrollTop: last, overlap, maxPages: 2 });
            if (offsets.length === 0) {
                break;
            }
            if (number > maxPages) {
                capped = true;
                break;
            }
            const pageStarted = Date.now();
            const reached = await scrollScrollerTo(scroller, offsets[0]);
            if (reached <= last) {
                break;
            }
            last = reached;
            const stable = await waitForScrollerStable(scroller);
            const after = await readScroller(scroller);
            last = after.scrollTop;
            const planned = { ...item, name: captureName({ ...item, page: number }) };
            try {
                const result = await takeCapture({ page, testInfo, dir, planned, root, masks, keepState, overlay, dry });
                const notes = [...(result.notes ?? []), ...(stable ? [] : ['the scroller was still moving after 5000 ms'])];
                results.push({ ...result, ...(notes.length && { notes }), scroller: `${after.scrollTop}/${after.scrollHeight}/${after.clientHeight}`, ms: Date.now() - pageStarted });
            } catch (error) {
                results.push({ name: planned.name, status: 'error', message: String(error.message).split('\n')[0], ms: Date.now() - pageStarted });
            }
        }
        if (capped) {
            first.capped = true;
        }
        await scrollScrollerTo(scroller, start.scrollTop);
    } finally {
        await scroller.dispose();
    }
}

const firstLines = error => String(error.message).split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join(' | ');

for (const viewport of [...new Set(plan.tests.map(planned => planned.viewport))]) {
    test.describe(`captures at ${viewport}`, () => {
        test.use(variantContextOptions({ viewport }));

        for (const planned of plan.tests.filter(candidate => candidate.viewport === viewport)) {
            test(`${planned.key}`, async ({ page, browser, baseURL, extraHTTPHeaders, locale, timezoneId }) => {
                const testInfo = test.info();
                const dir = captureDirectory(process.env, testInfo.project.outputDir);
                const { surface } = planned;
                const started = Date.now();
                // Every changed capture is taken a second time, which the budget allows for.
                test.setTimeout(Math.max(120_000, 90_000 + planned.captures.length * 20_000));
                if (mode.mode === 'compare' && ['all', 'changed'].includes(testInfo.config.updateSnapshots)) {
                    throw new Error('Compare mode must not run with --update-snapshots: it would overwrite the baseline. Record with SB_VISUAL_RECORD=1.');
                }
                const baselineFiles = mode.baselineDir ? baselineFilesDirectory(testInfo) : null;

                const results = [];
                let failure = null;
                let boots = 0;
                const flush = () => writeFragment(dir, { key: planned.key, durationMs: Date.now() - started, boots, baselineFilesDir: baselineFiles, run: RUN_INFO, captures: results, ...(failure && { error: failure }) });

                const variantIds = [...new Set(planned.captures.map(capture => capture.variant))];
                const cells = variantCells(viewport, { variants: variantIds });
                let booted = null;
                const closeBooted = async () => {
                    if (booted?.context) {
                        await booted.context.close();
                    }
                    booted = null;
                };
                // A page for the cell: the fixture page for the first boot of a shared run, a new context when every capture boots.
                const bootFor = async (cell) => {
                    boots++;
                    const variant = { ...cell.variant, viewport };
                    if (BOOT_MODE === 'fresh') {
                        const context = await browser.newContext({ ...variantContextOptions(variant), locale, timezoneId, baseURL, extraHTTPHeaders });
                        await startClockAtFixedTime(context);
                        const fresh = await context.newPage();
                        await bootSurfaceApp(fresh, baseURL, { variant, needs: surface.needs });
                        if (INJECT_CSS) {
                            await fresh.addStyleTag({ content: INJECT_CSS });
                        }
                        return { page: fresh, context };
                    }
                    await startClockAtFixedTime(page.context());
                    await bootSurfaceApp(page, baseURL, { variant, needs: surface.needs });
                    if (INJECT_CSS) {
                        await page.addStyleTag({ content: INJECT_CSS });
                    }
                    return { page, context: null };
                };

                /**
                 * Opens the surface (and the state of the item) and captures it and its pages. Returns the results of the item; `dry`
                 * writes no file, for the second look at a changed capture.
                 */
                const captureItem = async (cell, item, dry) => {
                    const itemResults = [];
                    const itemStarted = Date.now();
                    let restoreScroll = async () => {};
                    try {
                        if (BOOT_MODE === 'fresh') {
                            booted = await bootFor(cell);
                        }
                        const options = { stateId: item.state ?? undefined, backend: item.backend, viewport };
                        const root = await openSurface(booted.page, surface, options);
                        const state = item.state === null ? undefined : surface.states.find(candidate => candidate.id === item.state);
                        const shownRoot = state?.root ?? root;
                        const overlay = isOverlaySurface(surface) || Boolean(state?.root);
                        await booted.page.locator(shownRoot).first().waitFor({ state: 'visible', timeout: 10_000 });
                        // A surface as found starts at the top of its scrollers, and they go back where they were afterwards; a state
                        // keeps the position that it scrolled to. The chat keeps its place at the newest message.
                        if (item.state === null && surface.family !== 'chat') {
                            restoreScroll = await resetScrollerTop(booted.page, shownRoot);
                        }
                        const take = keepState => takeCapture({
                            page: booted.page, testInfo, dir, planned: item, root: shownRoot, masks: surface.masks ?? [], keepState, overlay, dry,
                        });
                        let result;
                        try {
                            result = await take(keepsPointerAndFocus(item.state));
                        } catch (error) {
                            if (!error.sbFocusClosed) {
                                throw error;
                            }
                            // The surface closes when it loses focus (an autocomplete list, a submenu): open it again and
                            // capture it with the focus where its open step left it.
                            await openSurface(booted.page, surface, options);
                            await booted.page.locator(shownRoot).first().waitFor({ state: 'visible', timeout: 10_000 });
                            result = { ...await take(true), focusKept: true };
                        }
                        const first = { ...result, ms: Date.now() - itemStarted };
                        sidecars.set(first, sidecars.get(result));
                        itemResults.push(first);
                        if (result.status !== 'error') {
                            await capturePages({
                                page: booted.page, testInfo, dir, item, root: shownRoot, masks: surface.masks ?? [], overlay, dry,
                                keepState: keepsPointerAndFocus(item.state) || Boolean(first.focusKept), first, results: itemResults, maxPages: pagesFor(surface, plan.pages.maxPages),
                            });
                        }
                        await restoreScroll();
                        if (item.state === null && surface.close && BOOT_MODE === 'reuse') {
                            try {
                                await surface.close(booted.page);
                            } catch (error) {
                                itemResults.push({ name: `${item.name} [close]`, status: 'error', message: `closeFailed: ${firstLines(error)}` });
                            }
                        }
                    } catch (error) {
                        itemResults.push({ name: item.name, status: 'error', message: firstLines(error), ms: Date.now() - itemStarted });
                    } finally {
                        if (BOOT_MODE === 'fresh') {
                            await closeBooted();
                        }
                    }
                    return itemResults;
                };

                /** Loads the booted page again in the variant of the cell, with the injected stylesheet that the load dropped. */
                const loadAgain = async (cell) => {
                    await rebootSurfaceApp(booted.page, { variant: { ...cell.variant, viewport } });
                    if (INJECT_CSS) {
                        await booted.page.addStyleTag({ content: INJECT_CSS });
                    }
                };

                /**
                 * A capture that changed is taken once more after a fresh open of its surface. When that equals the baseline the
                 * capture was not stable: it is `unstable` (and fails the run all the same, with both counts).
                 */
                const lookAgain = async (cell, item, itemResults) => {
                    const changed = itemResults.filter(result => result.status === 'changed');
                    if (changed.length === 0 || mode.mode !== 'compare') {
                        return;
                    }
                    // A fresh open means a page that is loaded again: an open step that starts from what the first one left (a
                    // search that is typed, a menu that its button would now close) otherwise waits for what never shows.
                    if (BOOT_MODE === 'reuse') {
                        await loadAgain(cell);
                    }
                    const again = await captureItem(cell, item, true);
                    itemResults.push(...again.filter(result => result.name.endsWith(' [close]')));
                    for (const result of changed) {
                        const second = again.find(candidate => candidate.name === result.name);
                        if (second?.status === 'same') {
                            Object.assign(result, { status: 'unstable', retryPixels: second.nearSame?.pixels ?? 0 });
                        } else if (second) {
                            result.retryPixels = second.pixels ?? undefined;
                        }
                    }
                };

                try {
                    for (const cell of cells) {
                        const items = planned.captures.filter(capture => capture.variant === cell.id);
                        if (BOOT_MODE === 'reuse') {
                            if (booted === null) {
                                booted = await bootFor(cell);
                            } else {
                                await loadAgain(cell);
                            }
                        }
                        for (const item of items) {
                            const itemResults = await captureItem(cell, item, false);
                            try {
                                await lookAgain(cell, item, itemResults);
                            } catch (error) {
                                itemResults.push({ name: `${item.name} [second look]`, status: 'error', message: firstLines(error) });
                            }
                            results.push(...itemResults);
                        }
                        flush();
                    }
                } catch (error) {
                    failure = firstLines(error);
                } finally {
                    await closeBooted().catch(() => {});
                    flush();
                    writeSummaryWhenComplete({ dir, planned: plannedKeys });
                }

                for (const result of results) {
                    if (result.status === 'changed') {
                        expect.soft(false, `${result.name} differs from the baseline: ${result.reason ?? (result.pixels === null ? 'the size changed' : `${result.pixels} pixels`)} (diff ${result.diff})`).toBe(true);
                    } else if (result.status === 'unstable') {
                        expect.soft(false, `${result.name} is not stable: ${result.pixels} pixels differ, then ${result.retryPixels} after a fresh open`).toBe(true);
                    } else if (result.status === 'error') {
                        expect.soft(false, `${result.name} could not be captured: ${result.message}`).toBe(true);
                    }
                }
                expect(failure, `${planned.key}: the boot or the variant failed`).toBeNull();
            });
        }
    });
}
