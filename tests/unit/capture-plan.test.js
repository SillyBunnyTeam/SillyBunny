import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
    AS_FOUND,
    BASE_VARIANT_ID,
    COLOUR_THRESHOLD,
    MAX_PAGES,
    baselinesWithoutCapture,
    buildSummary,
    captureDirectory,
    captureMode,
    captureName,
    chooseScroller,
    colourDistance,
    compareRegion,
    compareRunInfo,
    cornerExclusions,
    describeBox,
    distanceLimit,
    exitCodeOf,
    hiddenLevels,
    inScope,
    isSameRun,
    maskApplies,
    maskDifference,
    maskDropReason,
    needsReview,
    pageOverlap,
    parseCaptureName,
    planCaptures,
    planPages,
    radiusChange,
    unionBox,
    pagesFor,
    planRun,
    readComparison,
    renderSummary,
    selectCaptures,
    selectPages,
    selectThreshold,
    testKey,
    variantCatalogue,
    variantCells,
} from '../helpers/capture-plan.js';
import { cleanRunFiles, holdsCaptures, listBaselineNames, readBaselineStamp, readFragments, readSidecar, startRun, toolsFingerprint, writeFragment, writeSidecar, writeSummary, writeSummaryWhenComplete } from '../helpers/capture-files.js';
import { keepsPointerAndFocus } from '../helpers/capture-page.js';
import { DENSITIES, EXTRA_AXES, EXTRA_AXIS_VIEWPORT_IDS, THEMES, VIEWPORT_IDS, viewportsFor } from '../helpers/surface-matrix.js';

const LEGACY = [{ id: 'dracula', name: 'Dracula', tone: 'dark' }, { id: 'paper', name: 'Paper', tone: 'light' }];
const MATRIX = { densities: DENSITIES, themes: THEMES, legacyThemes: LEGACY, extraAxes: EXTRA_AXES, extraViewportIds: EXTRA_AXIS_VIEWPORT_IDS, viewportIds: VIEWPORT_IDS };
const noop = async () => {};

describe('capture file names', () => {
    test('are built from the surface, the state, the viewport and the variant', () => {
        expect(captureName({ surface: 'home.about', state: 'credits', viewport: '390x844', variant: 'compact-libadwaita-light' }))
            .toBe('home.about__credits__390x844__compact-libadwaita-light.png');
        expect(captureName({ surface: 'home.about', state: null, viewport: '1440x900', variant: 'forced-colors' }))
            .toBe(`home.about__${AS_FOUND}__1440x900__forced-colors.png`);
        expect(captureName({ surface: 'settings.backend.connections', backend: 'chat-completion', viewport: '1440x900', variant: BASE_VARIANT_ID }))
            .toBe('settings.backend.connections@chat-completion__as-found__1440x900__normal-libadwaita.png');
    });

    test('are read back to their parts', () => {
        const parts = { surface: 'settings.backend.presets', backend: 'novelai', state: 'expanded', viewport: '360x640', variant: 'text-200' };
        expect(parseCaptureName(captureName(parts))).toEqual({ ...parts, page: 1, key: 'settings.backend.presets__360x640' });
        expect(parseCaptureName(captureName({ ...parts, state: null, backend: undefined }))).toEqual({ ...parts, state: null, backend: null, page: 1, key: 'settings.backend.presets__360x640' });
    });

    test('of a later page add the page to the state part, and the first page keeps its name', () => {
        const parts = { surface: 'home.help', state: 'topic', viewport: '1440x900', variant: BASE_VARIANT_ID };
        expect(captureName({ ...parts, page: 1 })).toBe(captureName(parts));
        expect(captureName({ ...parts, page: 3 })).toBe('home.help__topic~3__1440x900__normal-libadwaita.png');
        expect(captureName({ ...parts, state: null, page: 2 })).toBe('home.help__as-found~2__1440x900__normal-libadwaita.png');
        expect(parseCaptureName(captureName({ ...parts, page: 12 }))).toMatchObject({ state: 'topic', page: 12, key: 'home.help__1440x900' });
        expect(parseCaptureName(captureName({ ...parts, state: null, backend: 'horde', page: 2 }))).toMatchObject({ state: null, backend: 'horde', page: 2 });
    });

    test('that are not made by this module are refused', () => {
        for (const name of ['notes.txt', 'a__b__c.png', 'a__b__1440x900__x__y.png', 'a@b@c__as-found__1440x900__x.png', 'a__as-found__wide__x.png', '__as-found__1440x900__x.png']) {
            expect(parseCaptureName(name)).toBeNull();
        }
    });

    test('are unique over the registry of a family and short enough', () => {
        const run = planRun({ SURFACE_FAMILY: 'settings', CAPTURE_SET: 'full' });
        expect(run.problems).toEqual([]);
        const names = run.tests.flatMap(planned => planned.captures.map(capture => capture.name));
        expect(names.length).toBeGreaterThan(100);
        expect(new Set(names).size).toBe(names.length);
        for (const name of names) {
            expect(parseCaptureName(name)).not.toBeNull();
        }
    });
});

describe('the capture sets', () => {
    test('quick is the default: density normal, Libadwaita, desktop and phone', () => {
        const selection = selectCaptures({});
        expect(selection).toEqual({ set: 'quick', viewports: ['1440x900', '390x844'], variants: [BASE_VARIANT_ID], problems: [] });
        expect(selectCaptures({ CAPTURE_SET: ' ' }).set).toBe('quick');
    });

    test('full is every viewport and every variant of the matrix', () => {
        const selection = selectCaptures({ CAPTURE_SET: 'full' }, MATRIX);
        expect(selection.viewports).toEqual(VIEWPORT_IDS);
        expect(selection.variants).toEqual([
            'normal-libadwaita', 'normal-libadwaita-light', 'compact-libadwaita', 'compact-libadwaita-light',
            'forced-colors', 'text-200', 'reduced-motion', 'normal-dracula', 'normal-paper',
        ]);
    });

    test('an unknown set, viewport or variant is a problem', () => {
        expect(selectCaptures({ CAPTURE_SET: 'half' }).problems).toEqual([expect.stringContaining('CAPTURE_SET "half"')]);
        expect(selectCaptures({ CAPTURE_VIEWPORTS: '1440x900,100x100' }).problems).toEqual([expect.stringContaining('CAPTURE_VIEWPORTS "100x100"')]);
        expect(selectCaptures({ CAPTURE_VARIANTS: 'sepia' }).problems).toEqual([expect.stringContaining('CAPTURE_VARIANTS "sepia"')]);
    });

    test('CAPTURE_VIEWPORTS and CAPTURE_VARIANTS replace the list of the set', () => {
        const selection = selectCaptures({ CAPTURE_SET: 'quick', CAPTURE_VIEWPORTS: '1024x600', CAPTURE_VARIANTS: 'compact-libadwaita,forced-colors' });
        expect(selection).toMatchObject({ viewports: ['1024x600'], variants: ['compact-libadwaita', 'forced-colors'], problems: [] });
    });

    test('the catalogue keeps the legacy themes last, and marks the cells that run at two viewports only', () => {
        const catalogue = variantCatalogue(MATRIX);
        expect(catalogue.slice(-2).map(cell => cell.id)).toEqual(['normal-dracula', 'normal-paper']);
        expect(catalogue.filter(cell => !cell.extra).map(cell => cell.id)).toEqual(['normal-libadwaita', 'normal-libadwaita-light', 'compact-libadwaita', 'compact-libadwaita-light']);
        expect(catalogue.find(cell => cell.id === 'text-200').variant).toEqual({ textScale: 2 });
        expect(catalogue.find(cell => cell.id === 'normal-paper').variant).toEqual({ density: 'normal', theme: 'paper' });
    });

    test('extra variants exist at the desktop and phone reference sizes only', () => {
        const all = selectCaptures({ CAPTURE_SET: 'full' }, MATRIX);
        expect(variantCells('1440x900', all, MATRIX)).toHaveLength(9);
        expect(variantCells('390x844', all, MATRIX)).toHaveLength(9);
        expect(variantCells('1024x600', all, MATRIX).map(cell => cell.id)).toEqual(['normal-libadwaita', 'normal-libadwaita-light', 'compact-libadwaita', 'compact-libadwaita-light']);
        for (const wide of ['3440x1440', '1920x1080']) {
            expect(variantCells(wide, all, MATRIX).map(cell => cell.id)).toEqual(['normal-libadwaita', 'normal-libadwaita-light', 'compact-libadwaita', 'compact-libadwaita-light']);
        }
    });

    test('the ultrawide and full HD viewports can be selected one by one', () => {
        const selection = selectCaptures({ CAPTURE_VIEWPORTS: '3440x1440,1920x1080' });
        expect(selection).toMatchObject({ viewports: ['3440x1440', '1920x1080'], variants: [BASE_VARIANT_ID], problems: [] });
    });

    test('without legacy themes the full set has seven variants', () => {
        expect(selectCaptures({ CAPTURE_SET: 'full' }, { ...MATRIX, legacyThemes: [] }).variants).toHaveLength(7);
    });
});

describe('the plan of a run', () => {
    const surface = (overrides = {}) => ({
        id: 'dialog.example.one', family: 'dialog', owner: 'A', title: 'Example', root: '.example', open: noop, needs: [], sources: ['public/index.html'], ...overrides,
    });
    const selection = { viewports: ['1440x900', '390x844', '1024x600'], variants: ['normal-libadwaita', 'compact-libadwaita', 'forced-colors'] };

    test('makes one test per surface and viewport, with the variants one after the other', () => {
        const { tests, problems } = planCaptures([surface({ states: [{ id: 'busy', open: noop }] })], selection, { matrix: MATRIX });
        expect(problems).toEqual([]);
        expect(tests.map(planned => planned.key)).toEqual(['dialog.example.one__1440x900', 'dialog.example.one__1024x600', 'dialog.example.one__390x844'].sort((a, b) => VIEWPORT_IDS.indexOf(a.split('__')[1]) - VIEWPORT_IDS.indexOf(b.split('__')[1])));
        const desktop = tests.find(planned => planned.viewport === '1440x900');
        expect(desktop.captures.map(capture => `${capture.variant}/${capture.state ?? AS_FOUND}`)).toEqual([
            'normal-libadwaita/as-found', 'normal-libadwaita/busy', 'compact-libadwaita/as-found', 'compact-libadwaita/busy', 'forced-colors/as-found', 'forced-colors/busy',
        ]);
        const small = tests.find(planned => planned.viewport === '1024x600');
        expect(small.captures.map(capture => capture.variant)).toEqual(['normal-libadwaita', 'normal-libadwaita', 'compact-libadwaita', 'compact-libadwaita']);
    });

    test('uses the viewports that apply to the surface and the states that exist at each', () => {
        const { tests } = planCaptures([surface({ family: 'chat', viewports: ['390x844', '1440x900'], states: [{ id: 'sheet', viewports: ['390x844'], open: noop }, { id: 'always', open: noop }] })], { ...selection, variants: ['normal-libadwaita'] }, { matrix: MATRIX });
        expect(tests.map(planned => planned.viewport).sort()).toEqual(['1440x900', '390x844']);
        expect(tests.find(planned => planned.viewport === '1440x900').captures.map(capture => capture.state)).toEqual([null, 'always']);
        expect(tests.find(planned => planned.viewport === '390x844').captures.map(capture => capture.state)).toEqual([null, 'sheet', 'always']);
    });

    test('captures each backend as found and the states with the first backend', () => {
        const { tests } = planCaptures([surface({ family: 'settings', backends: ['chat-completion', 'horde'], states: [{ id: 'expanded', open: noop }] })], { viewports: ['1440x900'], variants: ['normal-libadwaita'] }, { matrix: MATRIX });
        expect(tests[0].captures.map(capture => capture.name)).toEqual([
            'dialog.example.one@chat-completion__as-found__1440x900__normal-libadwaita.png',
            'dialog.example.one@horde__as-found__1440x900__normal-libadwaita.png',
            'dialog.example.one@chat-completion__expanded__1440x900__normal-libadwaita.png',
        ]);
    });

    test('leaves out a surface whose names clash or are not usable, and says why', () => {
        const asFound = surface({ id: 'dialog.clash.one', states: [{ id: AS_FOUND, open: noop }] });
        const long = surface({ id: `dialog.${'long-'.repeat(40)}one` });
        const first = surface({ id: 'dialog.same.one' });
        const { tests, problems } = planCaptures([asFound, long, first, surface({ id: 'dialog.same.one' }), surface({ id: 'dialog.fine.one' })], { viewports: ['1440x900'], variants: ['normal-libadwaita'] }, { matrix: MATRIX });
        expect(tests.map(planned => planned.key)).toEqual(['dialog.same.one__1440x900', 'dialog.fine.one__1440x900']);
        expect(problems).toEqual(expect.arrayContaining([
            expect.stringContaining('cannot be called "as-found"'),
            expect.stringContaining('longer than'),
            expect.stringContaining('is also made by dialog.same.one'),
        ]));
    });

    test('for a registry family comes out without problems at both sets', () => {
        for (const CAPTURE_SET of ['quick', 'full']) {
            const run = planRun({ SURFACE_FAMILY: 'settings', CAPTURE_SET });
            expect(run.problems).toEqual([]);
            expect(run.plannedKeys.length).toBeGreaterThan(0);
            expect(new Set(run.plannedKeys).size).toBe(run.plannedKeys.length);
        }
    });

    test('plans the cells of the matrix by count: viewports x variants x (as found + states)', () => {
        const states = [{ id: 'one', open: noop }, { id: 'two', open: noop }];
        const quick = planCaptures([surface({ states })], { viewports: ['1440x900', '390x844'], variants: ['normal-libadwaita'] }, { matrix: MATRIX });
        expect(quick.tests).toHaveLength(2);
        expect(quick.tests.flatMap(planned => planned.captures)).toHaveLength(2 * 1 * 3);
        const variants = ['normal-libadwaita', 'compact-libadwaita', 'forced-colors', 'reduced-motion'];
        const wide = planCaptures([surface({ states })], { viewports: ['1440x900', '390x844', '1024x600'], variants }, { matrix: MATRIX });
        const countAt = viewport => wide.tests.find(planned => planned.viewport === viewport).captures.length;
        // The extra axes exist at the two primary viewports only.
        expect(countAt('1440x900')).toBe(4 * 3);
        expect(countAt('390x844')).toBe(4 * 3);
        expect(countAt('1024x600')).toBe(2 * 3);
        expect(new Set(wide.tests.flatMap(planned => planned.captures.map(capture => capture.name))).size).toBe(wide.tests.flatMap(planned => planned.captures).length);
    });

    test('says which viewports of the matrix a surface leaves out with its own list', () => {
        const narrow = surface({ viewports: ['390x844'] });
        const { tests, notes } = planCaptures([narrow], { viewports: ['1440x900', '390x844'], variants: ['normal-libadwaita'] }, { matrix: MATRIX });
        expect(tests.map(planned => planned.viewport)).toEqual(['390x844']);
        expect(notes).toEqual([expect.stringContaining('1440x900')]);
        expect(viewportsFor(narrow)).toEqual(['390x844']);
        expect(planCaptures([surface()], { viewports: ['1440x900'], variants: ['normal-libadwaita'] }, { matrix: MATRIX }).notes).toEqual([]);
    });

    test('reports a filter that selects nothing', () => {
        expect(planRun({ SURFACE_ID: 'nothing.at.all' }).problems).toEqual([expect.stringContaining('nothing.at.all')]);
    });
});

describe('the pages of a scrolled capture', () => {
    test('a chat surface is captured where it stands, and other families take the cap of the run', () => {
        expect(pagesFor({ family: 'chat' }, MAX_PAGES)).toBe(1);
        expect(pagesFor({ family: 'settings' }, MAX_PAGES)).toBe(MAX_PAGES);
        expect(pagesFor({ family: 'settings' }, 1)).toBe(1);
    });

    test('CAPTURE_PAGES is all by default, first, or a number up to the cap', () => {
        expect(selectPages({})).toEqual({ maxPages: MAX_PAGES, problem: null });
        expect(selectPages({ CAPTURE_PAGES: 'first' })).toEqual({ maxPages: 1, problem: null });
        expect(selectPages({ CAPTURE_PAGES: '5' }).maxPages).toBe(5);
        expect(selectPages({ CAPTURE_PAGES: '900' }).maxPages).toBe(MAX_PAGES);
        expect(selectPages({ CAPTURE_PAGES: 'some' }).problem).toContain('CAPTURE_PAGES "some"');
        expect(selectPages({ CAPTURE_PAGES: '0' }).problem).toContain('CAPTURE_PAGES "0"');
    });

    test('a scroller that shows everything has no further page', () => {
        expect(planPages({ scrollTop: 0, clientHeight: 800, scrollHeight: 800 })).toEqual({ offsets: [], capped: false });
        expect(planPages({ scrollTop: 0, clientHeight: 800, scrollHeight: 801 })).toEqual({ offsets: [], capped: false });
    });

    test('pages step by the visible height less the overlap, and the last page stands at the end', () => {
        expect(planPages({ scrollTop: 0, clientHeight: 800, scrollHeight: 2000 })).toEqual({ offsets: [752, 1200], capped: false });
        expect(planPages({ scrollTop: 0, clientHeight: 500, scrollHeight: 1000, overlap: 50 })).toEqual({ offsets: [450, 500], capped: false });
    });

    test('a state that scrolled on purpose pages onward from where it stands', () => {
        expect(planPages({ scrollTop: 600, clientHeight: 800, scrollHeight: 2000 })).toEqual({ offsets: [1200], capped: false });
        expect(planPages({ scrollTop: 1200, clientHeight: 800, scrollHeight: 2000 })).toEqual({ offsets: [], capped: false });
    });

    test('the cap stops the pages, first page included, and says so', () => {
        const { offsets, capped } = planPages({ scrollTop: 0, clientHeight: 100, scrollHeight: 100_000, overlap: 0, maxPages: 40 });
        expect(offsets).toHaveLength(39);
        expect(capped).toBe(true);
        expect(planPages({ scrollTop: 0, clientHeight: 100, scrollHeight: 1000, overlap: 0, maxPages: 1 })).toEqual({ offsets: [], capped: true });
        expect(planPages({ scrollTop: 0, clientHeight: 100, scrollHeight: 400, overlap: 0, maxPages: 4 })).toEqual({ offsets: [100, 200, 300], capped: false });
    });

    test('the colour threshold hides a different number of levels in each channel', () => {
        expect(hiddenLevels(COLOUR_THRESHOLD)).toEqual({ grey: 5, red: 9, green: 7, blue: 15 });
        expect(hiddenLevels(0.004)).toEqual({ grey: 1, red: 1, green: 1, blue: 3 });
    });

    test('a colour distance is judged against the limit of the threshold', () => {
        const limit = distanceLimit(COLOUR_THRESHOLD);
        expect(colourDistance([40, 40, 40], [45, 45, 45])).toBeLessThan(limit);
        expect(colourDistance([40, 40, 40], [46, 46, 46])).toBeGreaterThan(limit);
        expect(colourDistance([10, 20, 30], [10, 20, 30])).toBe(0);
    });

    test('a difference that the threshold hides is for review from 20 pixels or 8 levels', () => {
        expect(needsReview({ pixels: 19, maxLevel: 7 })).toBe(false);
        expect(needsReview({ pixels: 20, maxLevel: 1 })).toBe(true);
        expect(needsReview({ pixels: 1, maxLevel: 8 })).toBe(true);
        expect(needsReview({ pixels: 2, maxLevel: 6, overThreshold: 2 })).toBe(true);
        expect(needsReview({ pixels: 2, maxLevel: 6 })).toBe(false);
    });

    test('CAPTURE_THRESHOLD sets another threshold between 0 and 1', () => {
        expect(selectThreshold({})).toEqual({ threshold: COLOUR_THRESHOLD, problem: null });
        expect(selectThreshold({ CAPTURE_THRESHOLD: '0.004' })).toEqual({ threshold: 0.004, problem: null });
        for (const bad of ['0', '1', '-1', 'tight']) {
            expect(selectThreshold({ CAPTURE_THRESHOLD: bad }).problem).toContain(`CAPTURE_THRESHOLD "${bad}"`);
        }
    });
});

describe('the part of the window that is compared', () => {
    const window = { width: 1440, height: 900 };

    test('is the union of the boxes of every match of the root, in both runs', () => {
        const box = unionBox([{ x: 400, y: 200, width: 600, height: 300 }, { x: 420, y: 180, width: 600, height: 300 }, { x: 600, y: 600, width: 100, height: 100 }], window);
        expect(box).toEqual({ x: 400, y: 180, width: 620, height: 520 });
        expect(describeBox(box)).toBe('x 400-1019, y 180-699');
    });

    test('rounds inward to whole pixels, so that a half-covered edge pixel is not compared', () => {
        expect(unionBox([{ x: 100.5, y: 100.5, width: 10.2, height: 10.2 }], window)).toEqual({ x: 101, y: 101, width: 9, height: 9 });
    });

    test('does not grow by the shadow', () => {
        expect(unionBox([{ x: 400, y: 200, width: 600, height: 300 }], window)).toEqual({ x: 400, y: 200, width: 600, height: 300 });
    });

    test('is cut to the window', () => {
        expect(unionBox([{ x: -50, y: 10, width: 300, height: 2000 }], window)).toEqual({ x: 0, y: 10, width: 250, height: 890 });
    });

    test('is the whole window when no root has a box, or the box is outside the window or too small to keep a pixel', () => {
        expect(unionBox([], window)).toBeNull();
        expect(unionBox([null, undefined, { x: 0, y: 0, width: 0, height: 40 }], window)).toBeNull();
        expect(unionBox([{ x: 2000, y: 0, width: 100, height: 100 }], window)).toBeNull();
        expect(unionBox([{ x: 10.2, y: 10.2, width: 0.5, height: 0.5 }], window)).toBeNull();
        expect(describeBox(null)).toBe('the whole window');
    });
});

describe('the corners that are left out', () => {
    const box = { x: 10, y: 20, width: 40, height: 30 };
    const pairs = flat => flat.reduce((list, value, index) => (index % 2 ? list : [...list, [value, flat[index + 1]]]), []);

    test('are the pixels of each r x r square whose centre is farther than r - 1 from the centre of the arc', () => {
        const pixels = pairs(cornerExclusions(box, 4));
        expect(pixels).toContainEqual([10, 20]);
        expect(pixels).toContainEqual([49, 49]);
        expect(pixels).toContainEqual([49, 20]);
        expect(pixels).toContainEqual([10, 49]);
        // The pixel at (13, 23) has its centre 1.0 from the centre of the arc at (14, 24): inside r - 1 = 3.
        expect(pixels).not.toContainEqual([13, 23]);
        expect(pixels).not.toContainEqual([12, 22]);
        expect(pixels.every(([x, y]) => (x < 14 || x >= 46) && (y < 24 || y >= 46))).toBe(true);
    });

    test('are none for a square box edge, and the radius is cut to half of the smaller side', () => {
        expect(cornerExclusions(box, 0)).toEqual([]);
        expect(pairs(cornerExclusions(box, 0.5))).toHaveLength(4);
        const pill = pairs(cornerExclusions({ x: 0, y: 0, width: 20, height: 6 }, 999));
        expect(pill.every(([x]) => x < 3 || x >= 17)).toBe(true);
    });

    test('belong to the region with the larger radius of the two runs, and the region is null without a box', () => {
        const region = compareRegion([{ x: 10, y: 20, width: 40, height: 30, radius: 4 }, { x: 10, y: 20, width: 40, height: 30, radius: 8 }], { width: 100, height: 100 });
        expect(region.box).toEqual(box);
        expect(region.radius).toBe(8);
        expect(region.excluded.length).toBeGreaterThan(cornerExclusions(box, 4).length);
        expect(compareRegion([], { width: 100, height: 100 })).toBeNull();
    });

    test('do not hide a changed radius: it is reported in numbers', () => {
        expect(radiusChange(12, 16)).toBe('corner radius 12px -> 16px');
        expect(radiusChange(12, 12.3)).toBeNull();
        expect(radiusChange(undefined, 12)).toBeNull();
    });
});

describe('the masks that apply', () => {
    const window = { width: 1440, height: 900 };
    const box = { x: 500, y: 150, width: 400, height: 400 };

    test('a mask on show applies, whole or partly covered', () => {
        expect(maskApplies({ box, hits: [true, true, true, true, true] }, window)).toBe(true);
        expect(maskApplies({ box, hits: [false, true, false, false, false] }, window)).toBe(true);
        expect(maskDropReason({ box, hits: [true] }, window)).toBeNull();
    });

    test('a mask that is covered at its centre and corners is dropped, and says why', () => {
        expect(maskApplies({ box, hits: [false, false, false, false, false] }, window)).toBe(false);
        expect(maskDropReason({ box, hits: [false, false, false, false, false] }, window)).toBe('covered');
    });

    test('a mask outside the window is dropped, one that touches it is kept', () => {
        for (const outside of [{ x: 0, y: 1000 }, { x: 1440, y: 0 }, { x: -200, y: 0 }]) {
            expect(maskDropReason({ box: { ...outside, width: 100, height: 100 }, hits: [] }, window)).toBe('outside the window');
        }
        expect(maskApplies({ box: { x: -50, y: 0, width: 100, height: 100 }, hits: [true] }, window)).toBe(true);
    });

    test('an element without a box is dropped', () => {
        expect(maskDropReason({ box: { x: 10, y: 10, width: 0, height: 0 }, hits: [] }, window)).toBe('outside the window');
    });

    test('an element that cannot be tested for cover (no hit points) is kept', () => {
        expect(maskApplies({ box, hits: [] }, window)).toBe(true);
    });

    test('a mask that one run painted and the other dropped is reported', () => {
        const painted = { applied: [{ selector: '.a', count: 2 }], dropped: [] };
        const dropped = { applied: [], dropped: [{ selector: '.a', count: 2, reason: 'covered' }] };
        expect(maskDifference(painted, painted)).toBeNull();
        expect(maskDifference(painted, dropped)).toBe('masks differ: .a painted on 2 elements, now 0 (covered)');
        expect(maskDifference(undefined, dropped)).toBeNull();
    });
});

describe('the scroller of a surface', () => {
    test('is the candidate with the largest visible area', () => {
        expect(chooseScroller([{ area: 100, order: 0 }, { area: 900, order: 1 }, { area: 400, order: 2 }])).toBe(1);
    });

    test('is the first in document order among equals, whatever the order of the list', () => {
        expect(chooseScroller([{ area: 500, order: 3 }, { area: 500, order: 1 }, { area: 500, order: 2 }])).toBe(1);
    });

    test('is none when nothing is on show', () => {
        expect(chooseScroller([])).toBe(-1);
        expect(chooseScroller([{ area: 0, order: 0 }])).toBe(-1);
    });

    test('pages overlap by the sticky and fixed height at the edges plus a margin, and by 48 px at least', () => {
        expect(pageOverlap()).toBe(48);
        expect(pageOverlap({ top: 10, bottom: 10 })).toBe(48);
        expect(pageOverlap({ top: 56, bottom: 64 })).toBe(136);
    });

    test('an overlap is never more than half of the visible height, so that a page moves on', () => {
        expect(pageOverlap({ top: 700, bottom: 114, clientHeight: 752 })).toBe(376);
        expect(pageOverlap({ top: 10, clientHeight: 752 })).toBe(48);
    });
});

describe('the mode of a run', () => {
    test('saves only without a baseline directory, records with the flag and compares without it', () => {
        expect(captureMode({})).toEqual({ mode: 'save', baselineDir: null, replace: false, problem: null });
        expect(captureMode({ SB_VISUAL_BASELINE_DIR: '/b' })).toEqual({ mode: 'compare', baselineDir: '/b', replace: false, problem: null });
        expect(captureMode({ SB_VISUAL_BASELINE_DIR: '/b', SB_VISUAL_RECORD: '1' })).toEqual({ mode: 'record', baselineDir: '/b', replace: false, problem: null });
        expect(captureMode({ SB_VISUAL_BASELINE_DIR: '/b', SB_VISUAL_RECORD: 'replace' })).toEqual({ mode: 'record', baselineDir: '/b', replace: true, problem: null });
        expect(captureMode({ SB_VISUAL_BASELINE_DIR: '/b', SB_VISUAL_RECORD: '0' }).mode).toBe('compare');
    });

    test('a record flag that is neither 1 nor replace is a problem, not a silent compare', () => {
        const mode = captureMode({ SB_VISUAL_BASELINE_DIR: '/b', SB_VISUAL_RECORD: 'true' });
        expect(mode.mode).toBe('save');
        expect(mode.problem).toContain('"true"');
    });

    test('a record flag without a baseline directory is a problem and saves only', () => {
        expect(captureMode({ SB_VISUAL_RECORD: '1' })).toMatchObject({ mode: 'save', problem: expect.stringContaining('SB_VISUAL_BASELINE_DIR') });
    });

    test('the capture directory is the variable or a directory of the output directory', () => {
        expect(captureDirectory({ SB_CAPTURE_DIR: ' /disk/c ' }, '/tmp/out')).toBe('/disk/c');
        expect(captureDirectory({}, '/tmp/out')).toBe('/tmp/out/surface-capture');
    });

    test('a state about hover or focus keeps the pointer and the focus', () => {
        expect(['hover', 'row-hover', 'focus-ring', 'keyboard-focus', 'hovered-tag', 'submenu'].map(keepsPointerAndFocus)).toEqual([true, true, true, true, true, true]);
        expect(['expanded', 'unfocused-card', 'hoverboard', null].map(keepsPointerAndFocus)).toEqual([false, false, false, false]);
    });
});

describe('reading Playwright\'s comparison', () => {
    test('takes the pixel count', () => {
        expect(readComparison('Screenshot comparison failed:\n\n  1 pixels (ratio 0.01 of all image pixels) are different.')).toEqual({ pixels: 1, baselineSize: null, actualSize: null });
    });

    test('takes the two sizes of an image that changed size, with the count of the padded images', () => {
        expect(readComparison('Expected an image 1440px by 900px, received 1440px by 912px. 5120 pixels (ratio 0.01 of all image pixels) are different.'))
            .toEqual({ pixels: 5120, baselineSize: '1440px by 900px', actualSize: '1440px by 912px' });
    });

    test('has no numbers for another message', () => {
        expect(readComparison('Buffers differ')).toEqual({ pixels: null, baselineSize: null, actualSize: null });
    });
});

describe('the summary', () => {
    const capture = (surface, state, extra = {}) => ({ name: captureName({ surface, state, viewport: '1440x900', variant: BASE_VARIANT_ID }), status: 'same', ...extra });
    const fragment = (surface, captures, extra = {}) => ({ key: testKey(surface, '1440x900'), durationMs: 10, captures, ...extra });
    const scope = { families: [], surfaceIds: [], viewports: ['1440x900', '390x844'], variants: [BASE_VARIANT_ID] };

    test('lists changed captures with their pixels and paths, new captures and errors', () => {
        const summary = buildSummary({
            mode: 'compare',
            baselineDir: '/b',
            planned: ['home.help__1440x900', 'home.about__1440x900', 'home.gone__1440x900'],
            fragments: [
                fragment('home.help', [
                    capture('home.help', null),
                    capture('home.help', 'topic', { status: 'changed', pixels: 12, baseline: '/b/x.png', actual: '/c/x.png', diff: '/d/x.png' }),
                    capture('home.help', 'search', { status: 'new', actual: '/c/new.png' }),
                    capture('home.help', 'broken', { status: 'error', message: 'timeout' }),
                    capture('home.help', 'size', { status: 'changed', pixels: null, baselineSize: '10px by 10px', actualSize: '10px by 12px', baseline: '/b/s.png', actual: '/c/s.png', diff: '/d/s.png' }),
                ]),
                fragment('home.about', [capture('home.about', null)], { error: 'boot failed' }),
            ],
            baselineNames: [],
            scope,
        });
        expect(summary.totals).toMatchObject({ tests: 2, testsPlanned: 3, captures: 6, same: 2, changed: 2, new: 1, errors: 2, baselineOnly: 0 });
        expect(summary.changed[0]).toMatchObject({ pixels: 12, baseline: '/b/x.png', actual: '/c/x.png', diff: '/d/x.png' });
        expect(summary.changed[1]).toMatchObject({ pixels: null, baselineSize: '10px by 10px', actualSize: '10px by 12px' });
        expect(summary.new).toEqual([{ name: expect.stringContaining('__search__'), actual: '/c/new.png' }]);
        expect(summary.errors).toEqual([{ name: expect.stringContaining('__broken__'), message: 'timeout' }, { name: 'home.about__1440x900', message: 'boot failed' }]);
        expect(summary.notRun).toEqual(['home.gone__1440x900']);
    });

    test('lists baselines that a test that ran did not capture, and baselines of a test that the registry no longer has', () => {
        const kept = capture('home.help', null);
        const orphans = baselinesWithoutCapture([
            kept.name,
            captureName({ surface: 'home.help', state: 'removed-state', viewport: '1440x900', variant: BASE_VARIANT_ID }),
            captureName({ surface: 'home.deleted', state: null, viewport: '1440x900', variant: BASE_VARIANT_ID }),
            captureName({ surface: 'home.other', state: null, viewport: '1440x900', variant: BASE_VARIANT_ID }),
            captureName({ surface: 'home.help', state: null, viewport: '1440x900', variant: 'compact-libadwaita' }),
            'readme.png',
        ], {
            captured: new Set([kept.name]),
            ran: new Set(['home.help__1440x900']),
            planned: new Set(['home.help__1440x900', 'home.other__1440x900']),
            scope,
        });
        expect(orphans).toEqual([
            captureName({ surface: 'home.deleted', state: null, viewport: '1440x900', variant: BASE_VARIANT_ID }),
            captureName({ surface: 'home.help', state: 'removed-state', viewport: '1440x900', variant: BASE_VARIANT_ID }),
        ].sort());
    });

    test('a baseline outside the families, surfaces, viewports and variants of the run is not counted', () => {
        const parsed = parseCaptureName(captureName({ surface: 'menu.context.one', state: null, viewport: '1440x900', variant: BASE_VARIANT_ID }));
        expect(inScope(parsed, scope)).toBe(true);
        expect(inScope(parsed, { ...scope, families: ['home'] })).toBe(false);
        expect(inScope(parsed, { ...scope, families: ['menu'], surfaceIds: ['menu.other.one'] })).toBe(false);
        expect(inScope(parsed, { ...scope, viewports: ['390x844'] })).toBe(false);
        expect(inScope(parsed, { ...scope, variants: ['compact-libadwaita'] })).toBe(false);
        expect(inScope(null, scope)).toBe(false);
    });

    test('a baseline page after the pages that the run captured is not in scope', () => {
        const page = number => parseCaptureName(captureName({ surface: 'home.help', state: null, viewport: '1440x900', variant: BASE_VARIANT_ID, page: number }));
        expect(inScope(page(2), { ...scope, maxPages: 1 })).toBe(false);
        expect(inScope(page(1), { ...scope, maxPages: 1 })).toBe(true);
        expect(inScope(page(3), { ...scope, maxPages: 3 })).toBe(true);
        expect(inScope(page(4), { ...scope, maxPages: 3 })).toBe(false);
        expect(inScope(page(9), scope)).toBe(true);
    });

    test('a compare of the first page only reports no later page of the baseline as missing', () => {
        const first = capture('a.b.c', null);
        const later = captureName({ surface: 'a.b.c', state: null, viewport: '1440x900', variant: BASE_VARIANT_ID, page: 2 });
        const summary = buildSummary({
            mode: 'compare', baselineDir: '/b', planned: ['a.b.c__1440x900'], fragments: [fragment('a.b.c', [first])], baselineNames: [first.name, later], scope: { ...scope, maxPages: 1 },
        });
        expect(summary.baselineOnly).toEqual([]);
        const all = buildSummary({ mode: 'compare', baselineDir: '/b', planned: ['a.b.c__1440x900'], fragments: [fragment('a.b.c', [first])], baselineNames: [first.name, later], scope });
        expect(all.baselineOnly).toEqual([later]);
    });

    test('is written as Markdown with a section for each list', () => {
        const summary = buildSummary({
            mode: 'compare',
            baselineDir: '/b',
            planned: ['a.b.c__1440x900'],
            fragments: [fragment('a.b.c', [
                capture('a.b.c', 'one', { status: 'changed', pixels: 3, baseline: '/b/1.png', actual: '/c/1.png', diff: '/d/1.png' }),
                capture('a.b.c', 'two', { status: 'new', actual: '/c/2.png' }),
            ])],
            baselineNames: [captureName({ surface: 'a.b.c', state: 'three', viewport: '1440x900', variant: BASE_VARIANT_ID })],
            scope,
        });
        const markdown = renderSummary(summary);
        expect(markdown).toContain('## Changed (1)');
        expect(markdown).toContain('3 px differ');
        expect(markdown).toContain('baseline /b/1.png');
        expect(markdown).toContain('actual /c/1.png');
        expect(markdown).toContain('diff /d/1.png');
        expect(markdown).toContain('## New captures without a baseline (1)');
        expect(markdown).toContain('## Baselines without a capture (1)');
        expect(markdown).toContain('a.b.c__three__1440x900__normal-libadwaita.png');
        expect(markdown).not.toContain('## Errors');
    });

    test('lists the captures that stopped at the page cap and counts the later pages', () => {
        const summary = buildSummary({
            mode: 'save',
            planned: ['a.b.c__1440x900'],
            fragments: [fragment('a.b.c', [
                capture('a.b.c', null, { status: 'saved', capped: true }),
                { name: captureName({ surface: 'a.b.c', state: null, viewport: '1440x900', variant: BASE_VARIANT_ID, page: 2 }), status: 'saved' },
            ])],
        });
        expect(summary.totals).toMatchObject({ captures: 2, pages: 1, capped: 1 });
        expect(summary.capped).toEqual([capture('a.b.c', null).name]);
        expect(renderSummary(summary)).toContain('## Captures that stopped at the page cap (1)');
    });

    test('lists an unstable capture with both counts, and it fails the exit status', () => {
        const summary = buildSummary({
            mode: 'compare', baselineDir: '/b', planned: ['a.b.c__1440x900'],
            fragments: [fragment('a.b.c', [capture('a.b.c', 'one', { status: 'unstable', pixels: 12, retryPixels: 0, where: 'around div', baseline: '/b/1.png', actual: '/c/1.png', diff: '/d/1.png' })])],
            baselineNames: [], scope,
        });
        expect(summary.totals).toMatchObject({ unstable: 1, changed: 0 });
        expect(summary.unstable[0]).toMatchObject({ pixels: 12, retryPixels: 0 });
        const markdown = renderSummary(summary);
        expect(markdown).toContain('## Unstable');
        expect(markdown).toContain('12 px differ at the first capture, 0 at the second');
        expect(exitCodeOf(summary)).toBe(1);
    });

    test('lists what the threshold hides by pixel count, with the largest level, and flags the ones for review', () => {
        const near = (pixels, maxLevel) => ({ pixels, maxLevel, where: 'around x' });
        const summary = buildSummary({
            mode: 'compare', baselineDir: '/b', planned: ['a.b.c__1440x900'],
            fragments: [fragment('a.b.c', [
                capture('a.b.c', 'small', { nearSame: near(2, 3) }),
                capture('a.b.c', 'many', { nearSame: near(40, 2) }),
                capture('a.b.c', 'bright', { nearSame: near(5, 9) }),
                capture('a.b.c', 'identical', { nearSame: near(0, 0) }),
            ])],
            baselineNames: [], scope,
        });
        expect(summary.sameNotIdentical.map(entry => [entry.pixels, entry.review])).toEqual([[40, true], [5, true], [2, false]]);
        expect(summary.totals).toMatchObject({ sameNotIdentical: 3, review: 2, changed: 0 });
        const markdown = renderSummary(summary);
        expect(markdown).toContain('## Same under the threshold, not identical (3)');
        expect(markdown).toMatch(/__many__.*40 px, largest difference 2 levels REVIEW/);
        expect(markdown).not.toMatch(/__small__.*REVIEW/);
        expect(exitCodeOf(summary)).toBe(0);
    });

    test('lists differences outside the compared box as information that does not fail', () => {
        const summary = buildSummary({
            mode: 'compare', baselineDir: '/b', planned: ['a.b.c__1440x900'], fragments: [fragment('a.b.c', [capture('a.b.c', null, { outside: 77 })])], baselineNames: [], scope,
        });
        expect(summary.outside).toEqual([{ name: capture('a.b.c', null).name, pixels: 77 }]);
        expect(renderSummary(summary)).toContain('outside the compared box: 77 px');
        expect(exitCodeOf(summary)).toBe(0);
    });

    test('a changed page count is one entry on the parent, with the shifted pages under it and no separate changes', () => {
        const pageName = number => captureName({ surface: 'a.b.c', state: null, viewport: '1440x900', variant: BASE_VARIANT_ID, page: number });
        const change = 'pages 3->2, scrollHeight 2000->1500';
        const summary = buildSummary({
            mode: 'compare', baselineDir: '/b', planned: ['a.b.c__1440x900'],
            fragments: [fragment('a.b.c', [
                capture('a.b.c', null, { status: 'changed', pixels: 0, reason: change, pagesChange: change }),
                { name: pageName(2), status: 'changed', pixels: 40 },
                { name: pageName(4), status: 'new' },
            ])],
            baselineNames: [pageName(1), pageName(2), pageName(3)], scope,
        });
        expect(summary.changed).toHaveLength(1);
        expect(summary.changed[0]).toMatchObject({ reason: change, shiftedPages: [{ name: pageName(2), pixels: 40 }] });
        expect(summary.new).toEqual([]);
        expect(summary.baselineOnly).toEqual([]);
        expect(summary.totals.changed).toBe(1);
        const markdown = renderSummary(summary);
        expect(markdown).toContain('pages 3->2, scrollHeight 2000->1500');
        expect(markdown).toContain('shifted pages');
        expect(exitCodeOf(summary)).toBe(1);
    });

    test('warns when the baseline was recorded with other settings, and does not list pages beyond its pages as new', () => {
        const pageName = number => captureName({ surface: 'a.b.c', state: null, viewport: '1440x900', variant: BASE_VARIANT_ID, page: number });
        const run = { set: 'full', pages: 3, tools: 'bbb' };
        const summary = buildSummary({
            mode: 'compare', baselineDir: '/b', planned: ['a.b.c__1440x900'], stamp: { set: 'quick', pages: 1, tools: 'aaa' },
            fragments: [fragment('a.b.c', [capture('a.b.c', null), { name: pageName(2), status: 'new' }], { run })], baselineNames: [], scope,
        });
        expect(summary.new).toEqual([]);
        expect(summary.warnings).toHaveLength(4);
        expect(summary.warnings.join('\n')).toMatch(/quick set.*full/);
        expect(renderSummary(summary)).toContain('## Warnings (4)');
        const noStamp = buildSummary({ mode: 'compare', planned: [], fragments: [], stamp: null });
        expect(noStamp.warnings).toEqual([expect.stringContaining('no baseline.json')]);
        expect(buildSummary({ mode: 'compare', planned: [], fragments: [] }).warnings).toEqual([]);
    });

    test('a note about a wait that hit its limit is listed and does not fail', () => {
        const summary = buildSummary({
            mode: 'save', planned: ['a.b.c__1440x900'], fragments: [fragment('a.b.c', [capture('a.b.c', null, { status: 'saved', notes: ['2 picture(s) still loading after 5000 ms'] })])],
        });
        expect(summary.totals.waitLimits).toBe(1);
        expect(renderSummary(summary)).toContain('2 picture(s) still loading');
        expect(exitCodeOf(summary)).toBe(0);
    });

    test('the exit status is 1 for a change, an unstable capture, an error or a test that did not run, and 0 otherwise', () => {
        const base = { mode: 'compare', baselineDir: '/b', scope, baselineNames: [] };
        const run = (captures, planned = ['a.b.c__1440x900']) => buildSummary({ ...base, planned, fragments: [fragment('a.b.c', captures)] });
        expect(exitCodeOf(run([capture('a.b.c', null)]))).toBe(0);
        expect(exitCodeOf(run([capture('a.b.c', null, { status: 'changed', pixels: 1 })]))).toBe(1);
        expect(exitCodeOf(run([capture('a.b.c', null, { status: 'unstable', pixels: 1 })]))).toBe(1);
        expect(exitCodeOf(run([capture('a.b.c', null, { status: 'error', message: 'x' })]))).toBe(1);
        expect(exitCodeOf(run([capture('a.b.c', null)], ['a.b.c__1440x900', 'd.e.f__1440x900']))).toBe(1);
        expect(exitCodeOf(run([capture('a.b.c', null, { status: 'new' })]))).toBe(0);
    });

    test('compares the set, the pages setting and the tools of the baseline with the run', () => {
        expect(compareRunInfo({ set: 'quick', pages: 40, tools: 'a' }, { set: 'quick', pages: 40, tools: 'a' })).toEqual([]);
        expect(compareRunInfo({ set: 'quick', pages: 40, tools: 'a' }, { set: 'full', pages: 1, tools: 'b' })).toHaveLength(3);
        expect(compareRunInfo(null, { set: 'quick' })).toEqual([expect.stringContaining('no baseline.json')]);
        expect(compareRunInfo({ set: 'quick' }, undefined)).toEqual([]);
    });

    test('of a save run counts what it saved and leaves the baseline lists out', () => {
        const summary = buildSummary({ mode: 'save', fragments: [fragment('a.b.c', [capture('a.b.c', null, { status: 'saved' })])], planned: ['a.b.c__1440x900'], baselineNames: ['x.png'], scope });
        expect(summary.totals).toMatchObject({ saved: 1, same: 0, baselineOnly: 0 });
        expect(renderSummary(summary)).toContain('Saved: 1.');
    });
});

describe('the files of a run', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-files-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const fragment = (key, captures) => ({ key, durationMs: 5, boots: 1, baselineFilesDir: path.join(dir, 'baseline'), captures });
    const fakeEnv = { SURFACE_FAMILY: 'settings', SB_VISUAL_BASELINE_DIR: '/b' };

    test('a fragment is read back, and the summary waits for the last test', () => {
        writeFragment(dir, fragment('a.b.c__1440x900', [{ name: 'n1.png', status: 'saved' }]));
        expect(readFragments(dir)).toHaveLength(1);
        const planned = ['a.b.c__1440x900', 'd.e.f__1440x900'];
        expect(writeSummaryWhenComplete({ dir, env: {}, planned })).toBe(false);
        expect(fs.existsSync(path.join(dir, 'summary.json'))).toBe(false);
        writeFragment(dir, fragment('d.e.f__1440x900', [{ name: 'n2.png', status: 'saved' }]));
        expect(writeSummaryWhenComplete({ dir, env: {}, planned })).toBe(true);
        const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
        expect(summary).toMatchObject({ mode: 'save', totals: { tests: 2, saved: 2, testsPlanned: 2 } });
        expect(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8')).toContain('# Capture summary (save)');
    });

    test('a compare summary reads the baseline directory that the tests recorded', () => {
        const baseline = path.join(dir, 'baseline');
        fs.mkdirSync(baseline);
        const kept = captureName({ surface: 'settings.backend.agents', state: null, viewport: '1440x900', variant: BASE_VARIANT_ID });
        const orphan = captureName({ surface: 'settings.backend.agents', state: 'gone', viewport: '1440x900', variant: BASE_VARIANT_ID });
        fs.writeFileSync(path.join(baseline, kept), 'x');
        fs.writeFileSync(path.join(baseline, orphan), 'x');
        fs.writeFileSync(path.join(baseline, 'notes.txt'), 'x');
        expect(listBaselineNames(baseline)).toEqual([orphan, kept].sort());
        writeFragment(dir, fragment('settings.backend.agents__1440x900', [{ name: kept, status: 'same' }]));
        const summary = writeSummary({ dir, env: fakeEnv, planned: ['settings.backend.agents__1440x900'] });
        expect(summary.mode).toBe('compare');
        expect(summary.baselineOnly).toEqual([orphan]);
        expect(listBaselineNames(path.join(dir, 'missing'))).toEqual([]);
    });

    test('a run clears its own files and nothing else', () => {
        writeFragment(dir, fragment('a.b.c__1440x900', []));
        fs.mkdirSync(path.join(dir, 'captures'));
        fs.writeFileSync(path.join(dir, 'captures', 'x.png'), 'x');
        fs.writeFileSync(path.join(dir, 'summary.md'), 'x');
        fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
        cleanRunFiles(dir);
        expect(fs.readdirSync(dir)).toEqual(['keep.txt']);
        expect(() => cleanRunFiles(path.join(dir, 'nothing-here'))).not.toThrow();
    });
});

describe('the start of a run', () => {
    let dir;
    let baseline;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-start-'));
        baseline = path.join(dir, 'baseline');
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const capturesDir = () => path.join(dir, 'run');
    const env = (extra = {}) => ({ SB_CAPTURE_DIR: capturesDir(), SB_VISUAL_BASELINE_DIR: baseline, SB_VISUAL_RECORD: '1', ...extra });
    const leaveCapture = () => {
        fs.mkdirSync(path.join(capturesDir(), 'captures'), { recursive: true });
        fs.writeFileSync(path.join(capturesDir(), 'captures', 'x.png'), 'x');
    };
    const now = new Date('2026-02-02T12:00:00.000Z');

    test('records into an empty directory and writes baseline.json with the commit, tools, set, pages, selection and date', () => {
        expect(startRun({ env: env({ SURFACE_FAMILY: 'home', CAPTURE_PAGES: '3' }), ppid: 10, list: false, tools: 'abc', now })).toEqual({ problem: null });
        const stamp = readBaselineStamp(baseline);
        expect(stamp).toMatchObject({ tools: 'abc', set: 'quick', pages: 3, date: now.toISOString(), selection: { families: ['home'], surfaceIds: [] } });
        expect(stamp.selection.viewports).toEqual(['1440x900', '390x844']);
        expect(JSON.parse(fs.readFileSync(path.join(capturesDir(), '.run.json'), 'utf8'))).toEqual({ ppid: 10, startedAt: now.toISOString() });
    });

    test('refuses to record into a directory that holds captures, and leaves it alone', () => {
        fs.mkdirSync(path.join(baseline, 'home'), { recursive: true });
        fs.writeFileSync(path.join(baseline, 'home', 'old.png'), 'old');
        leaveCapture();
        const { problem } = startRun({ env: env(), ppid: 10, list: false, tools: 'abc', now });
        expect(problem).toContain('SB_VISUAL_RECORD=replace');
        expect(fs.readFileSync(path.join(baseline, 'home', 'old.png'), 'utf8')).toBe('old');
        expect(fs.existsSync(path.join(capturesDir(), 'captures', 'x.png'))).toBe(true);
    });

    test('replace clears the captures, sidecars and stamp of the directory and nothing else, then records', () => {
        fs.mkdirSync(path.join(baseline, 'home'), { recursive: true });
        fs.writeFileSync(path.join(baseline, 'home', 'old.png'), 'old');
        fs.writeFileSync(path.join(baseline, 'home', 'old.json'), '{}');
        fs.writeFileSync(path.join(baseline, 'home', 'notes.txt'), 'keep');
        fs.writeFileSync(path.join(baseline, 'baseline.json'), '{"tools":"old"}');
        expect(holdsCaptures(baseline)).toBe(true);
        expect(startRun({ env: env({ SB_VISUAL_RECORD: 'replace' }), ppid: 10, list: false, tools: 'new', now })).toEqual({ problem: null });
        expect(fs.readdirSync(path.join(baseline, 'home'))).toEqual(['notes.txt']);
        expect(holdsCaptures(baseline)).toBe(false);
        expect(readBaselineStamp(baseline).tools).toBe('new');
    });

    test('a compare or a save run clears the files of the run and writes no baseline', () => {
        leaveCapture();
        expect(startRun({ env: env({ SB_VISUAL_RECORD: undefined }), ppid: 10, list: false, tools: 'abc', now })).toEqual({ problem: null });
        expect(fs.existsSync(path.join(capturesDir(), 'captures'))).toBe(false);
        expect(fs.existsSync(baseline)).toBe(false);
    });

    test('a second process of the same run (same parent, no summary yet) does not clean again', () => {
        startRun({ env: env({ SB_VISUAL_RECORD: undefined }), ppid: 10, list: false, tools: 'abc', now });
        leaveCapture();
        expect(startRun({ env: env({ SB_VISUAL_RECORD: undefined }), ppid: 10, list: false, tools: 'abc', now })).toEqual({ problem: null });
        expect(fs.existsSync(path.join(capturesDir(), 'captures', 'x.png'))).toBe(true);
    });

    test('a process of another run, or of the same one after its summary, cleans', () => {
        startRun({ env: env({ SB_VISUAL_RECORD: undefined }), ppid: 10, list: false, tools: 'abc', now });
        leaveCapture();
        startRun({ env: env({ SB_VISUAL_RECORD: undefined }), ppid: 11, list: false, tools: 'abc', now });
        expect(fs.existsSync(path.join(capturesDir(), 'captures'))).toBe(false);
        leaveCapture();
        fs.writeFileSync(path.join(capturesDir(), 'summary.json'), '{}');
        startRun({ env: env({ SB_VISUAL_RECORD: undefined }), ppid: 11, list: false, tools: 'abc', now });
        expect(fs.existsSync(path.join(capturesDir(), 'captures'))).toBe(false);
        expect(fs.existsSync(path.join(capturesDir(), 'summary.json'))).toBe(false);
    });

    test('listing the tests does nothing', () => {
        leaveCapture();
        expect(startRun({ env: env(), ppid: 10, list: true, tools: 'abc', now })).toEqual({ problem: null });
        expect(fs.existsSync(path.join(capturesDir(), 'captures', 'x.png'))).toBe(true);
        expect(fs.existsSync(baseline)).toBe(false);
        expect(fs.existsSync(path.join(capturesDir(), '.run.json'))).toBe(false);
    });

    test('a run marker is the same run only for the same parent and before the summary', () => {
        expect(isSameRun({ ppid: 5 }, 5, false)).toBe(true);
        expect(isSameRun({ ppid: 5 }, 6, false)).toBe(false);
        expect(isSameRun({ ppid: 5 }, 5, true)).toBe(false);
        expect(isSameRun(null, 5, false)).toBe(false);
    });

    test('a sidecar is written next to its png and read back; a missing or broken one reads as null', () => {
        const png = path.join(dir, 'a.b__as-found__1440x900__normal-libadwaita.png');
        writeSidecar(png, { roots: [{ x: 1, y: 2, width: 3, height: 4, radius: 5 }], masks: { applied: [], dropped: [] } });
        expect(fs.existsSync(path.join(dir, 'a.b__as-found__1440x900__normal-libadwaita.json'))).toBe(true);
        expect(readSidecar(png).roots[0].radius).toBe(5);
        expect(readSidecar(path.join(dir, 'none.png'))).toBeNull();
        fs.writeFileSync(path.join(dir, 'broken.json'), '{');
        expect(readSidecar(path.join(dir, 'broken.png'))).toBeNull();
    });

    test('the fingerprint of the tools changes with a file that changes and not with the order of the list', () => {
        const [one, two] = ['one.js', 'two.js'].map(name => path.join(dir, name));
        fs.writeFileSync(one, 'a');
        fs.writeFileSync(two, 'b');
        const before = toolsFingerprint([one, two]);
        expect(toolsFingerprint([two, one])).toBe(before);
        fs.writeFileSync(two, 'c');
        expect(toolsFingerprint([one, two])).not.toBe(before);
    });
});
