import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
    ALLOW_VARIABLE, BASELINE_PATH, FIXTURE_VARIABLE, UPDATE_COMMAND, UPDATE_VARIABLE, compareToBaseline, formatBaseline, formatComparison, isSillyBunnyElement, normaliseTarget, readBaseline,
    sectionOf, toTriples, updateBaselineFile, withFileLock, writeFileAtomically,
} from '../helpers/axe-baseline.js';
import { collectFindings, countIncomplete, writeSummary } from '../helpers/axe-report.js';
import { AXE_TAGS, DISABLED_RULES, GATED_TAGS, scanStable, trackRequests } from '../helpers/axe-scan.js';
import {
    COPY_ALLOW_VARIABLE, COPY_BASELINE_PATH, COPY_FIXTURE_VARIABLE, COPY_UPDATE_COMMAND, COPY_UPDATE_VARIABLE, compareToCopyBaseline, emptyCopyBaseline, formatCopyBaseline, formatCopyComparison,
    readCopyBaseline, uniqueObservations, updateCopyBaselineFile,
} from '../helpers/copy-baseline.js';
import { collectCopy } from '../helpers/copy-collect.js';
import { createOrigin } from '../helpers/copy-origin.js';
import { judgeRendered } from '../helpers/copy-judge.js';
import { THEMES, variantContextOptions, viewportById, viewportsFor } from '../helpers/surface-matrix.js';
import { visibleContent } from '../helpers/surfaces/content.js';
import { bootSurfaceApp, openSurface, readySelectors } from '../helpers/surfaces/boot.js';
import { SURFACES, backendsOf, loadProblemsFor, selectSurfaces, statesFor, validateSurfaces } from '../helpers/surfaces/index.js';
import { readAllowlist } from '../helpers/parity/allowlist.js';
import { buildRows, checkSurface, rulesFor } from '../helpers/parity/compare.js';
import { measureSurface, skeletonOf } from '../helpers/parity/measure.js';
import { PARITY_FAMILIES, PARITY_VIEWPORTS, RULES } from '../helpers/parity/index.js';
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect, playwright/expect-expect -- A surface lists its own backends and states, a close step is optional, and the checks that run are chosen by the environment. */

// Boots the app once per surface, viewport and theme and runs three checks in that boot, so a surface is not booted once for each check.
//
//   smoke   The surface opens, with each of its backends and states, at 1440x900 and 390x844: the root is visible, has a box, lies in the
//           viewport and shows a control, a sized image, video or canvas, or text, and every element that the surface's (or state's) `ready`
//           names is visible and in the viewport. A backend's plain open is closed again (`close`), and the root must be gone.
//   parity  The parts of the surface that its family's rules (`helpers/parity/`) name are measured at the plain open of the first backend and
//           compared with the family's canonical values. A difference passes only when `fixtures/parity-allowlist.json` lists that value of that
//           cell, and an entry whose difference no longer occurs fails ("remove this entry").
//   axe     axe runs inside the root of every unit, in the Libadwaita and Libadwaita Light themes. The WCAG 2.0, 2.1 and 2.2 A and AA results are
//           compared with tests/fixtures/axe-baseline.json and gate the run: a violation that is in neither section of the file fails, and so
//           does a record that no longer occurs, so the file equals the tree. The best-practice results are reported in the summary and never
//           gate. A record is judged only when its surface ran in this run.
//
// In the Libadwaita boot of a viewport, each unit (each backend, then each state at the first backend) is opened once and then goes through
// smoke, parity (the first backend's plain open only, before anything else touches the page) and the axe scan, and is closed. The Libadwaita
// Light boot runs the axe units only. It is a boot of its own: switching the theme on the Libadwaita page (`applyVariant`) stalled the scan of
// some surfaces and changed the results of others (a message left in edit mode showed in the Light results), so they differed from a fresh boot.
// A failure is reported under the label of its check (`smoke:`, `parity:` or `axe:`) with the surface and the cell.
//
//   copy    The Capitalisation Rule of DESIGN.md, judged on the text that the surface renders (headings, buttons, menu items, tabs, row titles and
//           subtitles, field labels, check and radio labels, placeholders, tooltips and accessible names), each in the form that its rendered role
//           takes. It runs at the plain open and every state of the Libadwaita boot, at both viewports; a unit's strings are the union of the two, so
//           what only the phone layout draws is judged and a string that a slow boot misses once is not a new record. A string counts only when a file of the working tree holds it (otherwise it is data, such as a name
//           or a file) and quick-image-gen and third-party code do not own it. A violation that is in neither section of
//           tests/fixtures/copy-baseline.json fails the run, and so does a record that no longer occurs. A string that is verbatim in the
//           upstream base commit goes to the `upstream` section, any other to `sillybunny`.
//
// SURFACE_CHECKS=smoke,parity,axe,copy chooses the checks (default: all; with SURFACE_AXE_UPDATE=1 and no SURFACE_CHECKS: axe only; with
// SURFACE_COPY_UPDATE=1 and no SURFACE_CHECKS: copy only). A non-default SURFACE_DENSITY or SURFACE_TEXT_SCALE applies to the smoke check only,
// so with either set only smoke runs.
// SURFACE_FAMILY=<family>[,<family>] and SURFACE_ID=<id>[,<id>] limit the run to those families and surfaces.
// SURFACE_DENSITY=compact and SURFACE_TEXT_SCALE=<number> run the smoke check in that cell of the variant matrix instead of the default one (the
//   boot asserts that the app took the setting).
// SURFACE_SMOKE_SHOTS=<directory> also saves a screenshot of every opened surface and state there.
// SB_PARITY_RECORD=1 measures without comparing, which is how the allow-list is generated.
// SB_CENSUS_DIR=<directory> writes the measurements of each surface to <directory>/raw; `node scripts/update-parity-allowlist.js
//   --census <directory>` turns them into the census files and, with --write, into the allow-list.
// SB_PARITY_ALLOWLIST=<file> reads that allow-list instead of the fixture.
// SB_PARITY_INJECT_CSS=<css> adds a style to the page before it is measured (and removes it afterwards), to prove that the check fails on a difference.
// SB_PARITY_DUMP=<directory> writes an outline of each opened surface (classes and sizes), for writing the selectors of a rules file.
// SURFACE_AXE_UPDATE=1 writes the fixture instead of comparing; it refuses to add a record to the `sillybunny` section unless
//   SURFACE_AXE_ALLOW_SILLYBUNNY=1 is set too.
// SURFACE_AXE_FIXTURE=<path> reads and writes that file instead of the committed fixture.
// SURFACE_AXE_DIR=<directory> sets where the results go (default: <tmp>/surface-axe): runs/<surface>/<one file per run>.json,
//   surfaces/<surface>.json, summary.json and summary.md.
// SURFACE_AXE_VERBOSE=1 prints each step of a surface with the time it took.
// SURFACE_AXE_INJECT=1 puts an image without a text alternative and a low-contrast label into every root before it is scanned, to show
//   that the scan catches a new violation and names its section; it cannot be combined with an update.
// SURFACE_COPY_UPDATE=1 writes the copy fixture instead of comparing: it removes the records that no longer occur and refuses to add one to
//   the `sillybunny` section unless SURFACE_COPY_ALLOW_SILLYBUNNY=1 is set too.
// SURFACE_COPY_FIXTURE=<path> reads and writes that file instead of the committed fixture.
// SURFACE_COPY_DIR=<directory> sets where every string that the check judged goes (default: <tmp>/surface-copy/<surface>.json).
// SURFACE_COPY_INJECT=1 puts a button with a label in the wrong case ('Date added', which no surface holds in that case; SURFACE_COPY_INJECT=<text>
//   names another), and one that shows user data in the wrong case, into every root, to show that the check fails on the label and leaves the
//   data alone; it cannot be combined with an update.
const SMOKE_VIEWPORTS = ['1440x900', '390x844'];
const SCAN_VIEWPORTS = ['1440x900', '390x844'];
const COPY_VIEWPORTS = ['1440x900', '390x844'];
const CHECKS = Object.freeze(['smoke', 'parity', 'axe', 'copy']);
const UPDATE = process.env[UPDATE_VARIABLE] === '1';
const ALLOW_SILLYBUNNY = process.env[ALLOW_VARIABLE] === '1';
const FIXTURE = process.env[FIXTURE_VARIABLE] ? path.resolve(process.env[FIXTURE_VARIABLE]) : BASELINE_PATH;
const COPY_UPDATE = process.env[COPY_UPDATE_VARIABLE] === '1';
const COPY_ALLOW_SILLYBUNNY = process.env[COPY_ALLOW_VARIABLE] === '1';
const COPY_FIXTURE = process.env[COPY_FIXTURE_VARIABLE] ? path.resolve(process.env[COPY_FIXTURE_VARIABLE]) : COPY_BASELINE_PATH;
const COPY_OUTPUT = path.resolve(process.env.SURFACE_COPY_DIR || path.join(os.tmpdir(), 'surface-copy'));
const COPY_INJECT = Boolean(process.env.SURFACE_COPY_INJECT);
// The probe must be a label that a file of the tree holds in the wrong form, or the check takes it for data. SURFACE_COPY_INJECT=<text> names another.
const COPY_INJECT_LABEL = process.env.SURFACE_COPY_INJECT === '1' ? 'Date added' : process.env.SURFACE_COPY_INJECT;
const OUTPUT = path.resolve(process.env.SURFACE_AXE_DIR || path.join(os.tmpdir(), 'surface-axe'));
const STEP_CAP_MS = 90_000;
const VERBOSE = process.env.SURFACE_AXE_VERBOSE === '1';
const INJECT = process.env.SURFACE_AXE_INJECT === '1';
const SUMMARY_LOCK = path.join(OUTPUT, 'summary');
const SHOT_DIRECTORY = process.env.SURFACE_SMOKE_SHOTS;
const RECORD = process.env.SB_PARITY_RECORD === '1';
const CENSUS_DIR = process.env.SB_CENSUS_DIR;
const INJECT_CSS = process.env.SB_PARITY_INJECT_CSS;
const DUMP_DIR = process.env.SB_PARITY_DUMP;
// SURFACE_AUDIT_VANISH=<surface id>:<ms> removes the root of that surface's plain opens <ms> after their first open, to show that the smoke
// check judges the first open of a unit and not the reopen that the axe scan retries with. It is for that proof only.
const VANISH = (() => {
    const [id, ms] = String(process.env.SURFACE_AUDIT_VANISH ?? '').split(':');
    return id ? { id, ms: Number(ms) || 0 } : null;
})();
// A surface's cells (a viewport and a theme, each in a browser context of its own) run up to 4 at a time, so a run of a few heavy surfaces is
// not as long as its longest surface's four boots in a row. A run holds one browser per worker already, so the contexts that one run may hold at
// once are capped at CONTEXT_BUDGET (about 0.9 GB each, so about 22 GB a run, and several runs fit beside each other in the e2e memory cap):
// the cells at once are CONTEXT_BUDGET divided by the surfaces of the run, which is 1 from 13 surfaces up, so a run of the whole registry boots
// one cell at a time. The surfaces are counted after SURFACE_ID or SURFACE_FAMILY; a --grep run counts the whole registry. SURFACE_AUDIT_CELLS=<n>
// lowers the 4; it cannot exceed the budget.
const CONTEXT_BUDGET = 24;
const MAX_CELLS_AT_ONCE = Math.max(1, Number(process.env.SURFACE_AUDIT_CELLS) || 4);
const CELL = {
    ...(process.env.SURFACE_DENSITY && { density: process.env.SURFACE_DENSITY }),
    ...(process.env.SURFACE_TEXT_SCALE && { textScale: Number(process.env.SURFACE_TEXT_SCALE) }),
};

/** Surfaces that the axe scan does not run, with what is true of each. The registry owns their open steps. */
const SKIPPED_SURFACES = Object.freeze({
    'status.persona-picker.empty': 'the menu opens, and the scan of it then does not return within the 90 s that a step may take; the cause is not known',
    'status.persona-picker.no-notes': 'the menu opens, and the scan of it then does not return within the 90 s that a step may take; the cause is not known',
    'panel.moving.visual-novel': 'its open step waits for a sprite of every group member, which can fail while the app is still loading',
    'list.logit-bias': 'the rows of the bias list are built after the surface reports ready, so which cells show a violation on them varies',
    'status.sampling.unavailable': 'its open step waits for the rows of the bias list, which are not always built',
});

/**
 * Surfaces that the copy check does not run. Their open steps or their rows are not stable enough for a fixture that the run must equal; a
 * surface that the axe scan skips only because the scan itself stalls is not listed.
 */
const COPY_SKIPPED_SURFACES = Object.freeze({
    'panel.moving.visual-novel': SKIPPED_SURFACES['panel.moving.visual-novel'],
    'list.logit-bias': SKIPPED_SURFACES['list.logit-bias'],
    'status.sampling.unavailable': SKIPPED_SURFACES['status.sampling.unavailable'],
    // The smoke check fails on it at this commit, so there is no open surface to read.
    'status.import.loading': 'the status page stays visibility:hidden, so the surface does not open',
});

/** Regions that an axe scan leaves out of a surface, because another surface covers them. */
const EXCLUDED_REGIONS = Object.freeze({
    'settings.backend.sampling': ['.openai_logit_bias_list'],
});

const listOf = value => String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
const requestedChecks = listOf(process.env.SURFACE_CHECKS);
const unknownChecks = requestedChecks.filter(name => !CHECKS.includes(name));
const cellIsSet = Object.keys(CELL).length > 0;
const wantedChecks = requestedChecks.length ? requestedChecks : UPDATE || COPY_UPDATE ? [...(UPDATE ? ['axe'] : []), ...(COPY_UPDATE ? ['copy'] : [])] : CHECKS;
const ACTIVE = new Set(CHECKS.filter(name => wantedChecks.includes(name) && (!cellIsSet || name === 'smoke')));
const CHECK_NOTES = [
    ...(cellIsSet ? [`only the smoke check runs, because ${Object.entries(CELL).map(([key, value]) => `${key}=${value}`).join(' ')} applies to it alone (parity and axe judge the default cell)`] : []),
    ...(UPDATE && !requestedChecks.length ? [`only the axe check runs, because ${UPDATE_VARIABLE}=1 is set without SURFACE_CHECKS`] : []),
    ...(COPY_UPDATE && !requestedChecks.length ? [`only the copy check runs, because ${COPY_UPDATE_VARIABLE}=1 is set without SURFACE_CHECKS`] : []),
];
if (CHECK_NOTES.length && process.env.TEST_WORKER_INDEX === undefined) {
    console.log(`surface-audit: ${CHECK_NOTES.join('; ')}.`);
}

const selection = selectSurfaces();
const entries = RECORD || !ACTIVE.has('parity') ? [] : readAllowlist().entries;

// An entry is run only when it is valid on its own and its id is not taken by an earlier entry, so one malformed entry
// of one family does not stop the others from running.
const seenIds = new Set();
const runnable = [];
const invalid = [];
for (const surface of selection.surfaces) {
    const problems = validateSurfaces([surface]);
    if (seenIds.has(surface.id)) {
        problems.push(`${surface.id}: id is used by another surface.`);
    }
    seenIds.add(surface.id);
    if (problems.length) {
        invalid.push(...problems);
    } else {
        runnable.push(surface);
    }
}

/** What each check does with a surface: whether it runs, the viewports it runs at, and why it is left out. */
function planFor(surface) {
    const familyRules = PARITY_FAMILIES.includes(surface.family) ? RULES[surface.family] : null;
    const paritySkip = familyRules?.skip?.[surface.id];
    const skips = {
        parity: familyRules ? (paritySkip ? `not measured: ${paritySkip}` : null) : `the ${surface.family} family has no parity rules`,
        axe: SKIPPED_SURFACES[surface.id] ?? null,
        copy: COPY_SKIPPED_SURFACES[surface.id] ?? null,
    };
    const runs = {
        smoke: ACTIVE.has('smoke'),
        parity: ACTIVE.has('parity') && !skips.parity,
        axe: ACTIVE.has('axe') && !skips.axe,
        copy: ACTIVE.has('copy') && !skips.copy,
    };
    const applicable = viewportsFor(surface);
    /** The checks that run at one viewport. */
    const at = viewport => ({
        smoke: runs.smoke && SMOKE_VIEWPORTS.includes(viewport),
        parity: runs.parity && PARITY_VIEWPORTS.includes(viewport),
        axe: runs.axe && SCAN_VIEWPORTS.includes(viewport),
        copy: runs.copy && COPY_VIEWPORTS.includes(viewport),
    });
    const viewports = applicable.filter(viewport => Object.values(at(viewport)).some(Boolean));
    return { surface, familyRules, skips, runs, at, viewports, any: viewports.length > 0, parityListed: Boolean(paritySkip) };
}

const plans = runnable.map(planFor);

test('the registry is valid', () => {
    const problems = selection.active ? [...loadProblemsFor(selection.families), ...invalid] : validateSurfaces();
    expect(problems, 'registry problems (a surface with a problem is not run)').toEqual([]);
});

if (unknownChecks.length || ACTIVE.size === 0) {
    test('SURFACE_CHECKS names a check that runs', () => {
        expect(unknownChecks, `SURFACE_CHECKS names checks that do not exist (${CHECKS.join(', ')} do)`).toEqual([]);
        expect([...ACTIVE], `no check runs${CHECK_NOTES.length ? `: ${CHECK_NOTES.join('; ')}` : ''}`).not.toEqual([]);
    });
}

if (selection.problem) {
    test('the surface filter selects surfaces', () => {
        expect(selection.problem, 'the surface filter').toBeNull();
    });
} else if (selection.surfaces.length > 0 && invalid.length === 0 && ACTIVE.size > 0 && !plans.some(plan => plan.any || (plan.parityListed && ACTIVE.has('parity')))) {
    test('the surface filter selects a surface that a check runs on', () => {
        const reasons = plans.map(plan => `${plan.surface.id}: ${Object.entries(plan.skips).filter(([name, reason]) => reason && ACTIVE.has(name)).map(([name, reason]) => `${name} skipped (${reason})`).join('; ') || 'no viewport'}`);
        expect(reasons, 'every selected surface is left out by every check that runs').toEqual([]);
    });
}

// A surface that every check skips is declared as a test that is not run, so that the reporter lists it, with its reasons, in every run that selects it.
for (const plan of plans.filter(candidate => !candidate.any)) {
    const reasons = Object.entries(plan.skips).filter(([name, reason]) => reason && ACTIVE.has(name)).map(([name, reason]) => `${name}: ${reason}`);
    // eslint-disable-next-line playwright/no-skipped-test -- the point is that the reporter prints the skip
    test.fixme(`${plan.surface.id}`, { annotation: { type: 'skipped', description: reasons.join('; ') || 'no check applies at the audit viewports' } }, async () => {});
}

if (ACTIVE.has('axe')) {
    test('an injected violation is never written to the baseline', () => {
        expect(INJECT && UPDATE, `${UPDATE_VARIABLE} and SURFACE_AXE_INJECT cannot be combined`).toBe(false);
    });

    test('every skipped or excluded surface is registered', () => {
        const ids = [...Object.keys(SKIPPED_SURFACES), ...Object.keys(EXCLUDED_REGIONS)];
        expect(ids.filter(id => !SURFACES.some(surface => surface.id === id)), 'ids that are not in the registry').toEqual([]);
    });

    test('the scan has its rules', () => {
        expect(GATED_TAGS, 'gated tags').toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
        expect(AXE_TAGS, 'axe tags').toEqual([...GATED_TAGS, 'best-practice']);
        expect(DISABLED_RULES, 'disabled rules').toEqual(['region']);
    });
}

if (ACTIVE.has('copy')) {
    test('an injected copy violation is never written to the baseline', () => {
        expect(COPY_INJECT && COPY_UPDATE, `${COPY_UPDATE_VARIABLE} and SURFACE_COPY_INJECT cannot be combined`).toBe(false);
    });

    test('every surface that the copy check skips is registered', () => {
        expect(Object.keys(COPY_SKIPPED_SURFACES).filter(id => !SURFACES.some(surface => surface.id === id)), 'ids that are not in the registry').toEqual([]);
    });

    if (!selection.active) {
        // A full run also judges the records of surfaces that are no longer in the registry.
        test('the copy baseline names no surface that is gone', async () => {
            const known = new Set(selection.surfaces.map(surface => surface.id));
            const baseline = readCopyBaseline(COPY_FIXTURE);
            if (baseline === null) {
                return;
            }
            const isGone = record => !known.has(record.surface);
            const gone = [...baseline.upstream, ...baseline.sillybunny].filter(isGone);
            if (COPY_UPDATE) {
                await withFileLock(COPY_FIXTURE, () => {
                    const current = readCopyBaseline(COPY_FIXTURE);
                    writeFileAtomically(COPY_FIXTURE, formatCopyBaseline({ ...current, upstream: current.upstream.filter(record => !isGone(record)), sillybunny: current.sillybunny.filter(record => !isGone(record)) }));
                });
                return;
            }
            expect(gone.map(record => `${record.surface}: ${record.role} "${record.text}"`), `copy records of surfaces that are not in the registry. Lock it in with: ${COPY_UPDATE_COMMAND}`).toEqual([]);
        });
    }
}

if (ACTIVE.has('axe')) {

    if (!selection.active) {
        // A full run also judges the records of surfaces that are no longer in the registry.
        test('the baseline names no surface that is gone', async () => {
            const known = new Set([...selection.surfaces.map(surface => surface.id), ...Object.keys(SKIPPED_SURFACES)]);
            const baseline = readBaseline(FIXTURE);
            if (baseline === null) {
                return;
            }
            const isGone = record => !known.has(record.surface);
            const gone = [...baseline.upstream, ...baseline.sillybunny].filter(isGone);
            if (UPDATE) {
                await withFileLock(FIXTURE, () => {
                    const current = readBaseline(FIXTURE);
                    const next = { ...current, upstream: current.upstream.filter(record => !isGone(record)), sillybunny: current.sillybunny.filter(record => !isGone(record)) };
                    writeFileAtomically(FIXTURE, formatBaseline(next));
                });
                return;
            }
            expect(gone.map(record => `${record.surface}: ${record.rule} at ${record.target}`), `records of surfaces that are not in the registry. Lock it in with: ${UPDATE_COMMAND}`).toEqual([]);
        });
    }
}

/**
 * Runs a step of a surface and gives up on it after `STEP_CAP_MS`, so that a surface that stalls fails within a minute or two with
 * its id and the step instead of holding a worker until the test timeout. The step itself cannot be cancelled; it ends when the
 * context is closed.
 */
async function capped(surface, label, work) {
    let timer;
    const running = work();
    running.catch(() => {});
    try {
        return await Promise.race([running, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error(`${surface.id} stalled for ${STEP_CAP_MS / 1000}s at: ${label}`), { stalled: true })), STEP_CAP_MS);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

const sanitise = text => String(text).replace(/[^a-z0-9.-]+/gi, '_');
const briefOf = error => String(error?.message ?? error).split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join(' | ');
const labelled = (label, detail) => (detail.startsWith(label) ? detail : `${label}: ${detail}`);

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * The root must be shown with a box that has an area, inside the viewport (which catches a sheet that is off screen or
 * translated away), and show something: be a control or hold one, hold a sized image, video or canvas, or have text. Every `ready` element must be visible and inside the viewport.
 */
async function expectOpen(page, label, root, ready) {
    const target = page.locator(root).first();
    await expect(target, `${label}: ${root} is visible`).toBeVisible();
    await expect(target, `${label}: ${root} is inside the viewport`).toBeInViewport();
    const box = await target.boundingBox();
    expect(box, `${label}: ${root} has a box`).not.toBeNull();
    expect(box.width, `${label}: ${root} is wider than 0`).toBeGreaterThan(0);
    expect(box.height, `${label}: ${root} is taller than 0`).toBeGreaterThan(0);
    expect(await target.evaluate(visibleContent), `${label}: ${root} holds a visible control, image or text`).not.toBeNull();
    for (const selector of ready) {
        const element = page.locator(selector).first();
        await expect(element, `${label}: ${selector} is visible`).toBeVisible();
        await expect(element, `${label}: ${selector} is inside the viewport`).toBeInViewport();
    }
    if (SHOT_DIRECTORY) {
        fs.mkdirSync(SHOT_DIRECTORY, { recursive: true });
        const name = `${page.viewportSize().width}x${page.viewportSize().height}-${label}`.replace(/[^a-z0-9.-]+/gi, '_');
        await page.screenshot({ path: `${SHOT_DIRECTORY}/${name}.png` });
    }
}

/** Measures the parts that the family's rules name on the open surface, and compares them with the canonical values and the allow-list. */
async function measureParity(page, plan, root, viewport) {
    const { surface, familyRules } = plan;
    const rules = rulesFor(familyRules, surface.id);
    const backend = backendsOf(surface)[0];
    let probe = null;
    try {
        if (INJECT_CSS) {
            probe = await page.addStyleTag({ content: INJECT_CSS });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        }
        if (DUMP_DIR) {
            fs.mkdirSync(DUMP_DIR, { recursive: true });
            fs.writeFileSync(`${DUMP_DIR}/${surface.id}@${viewport}.txt`, `${await skeletonOf(page, root)}\n`);
        }
        const ready = readySelectors(surface, { backend, viewport });
        for (const selector of ready) {
            await expect(page.locator(selector).first(), `${surface.id}: ${selector} is shown`).toBeVisible();
        }
        const measured = await measureSurface(page, root, rules, ready);
        const { rows, parts } = buildRows({ surface: surface.id, viewport, rules, measured });
        const raw = {
            family: surface.family,
            surface: surface.id,
            viewport,
            group: familyRules.groupOf?.(surface) ?? '',
            pointer: measured.pointer,
            parts,
            rows,
        };
        return { raw, failures: RECORD ? [] : checkSurface({ surface: surface.id, viewport, rows, entries }).failures };
    } finally {
        if (probe) {
            await probe.evaluate(node => node.remove()).catch(() => {});
            await probe.dispose().catch(() => {});
        }
    }
}

/** Runs `work` on each item, at most `limit` at a time, and returns the results in the order of the items. */
async function mapLimit(items, limit, work) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await work(items[index]);
        }
    }));
    return results;
}

let labelOrigin = null;
/** The sets that decide what is a label and where it comes from are read once for each worker. */
const copyOrigin = () => (labelOrigin ??= createOrigin());

/**
 * Judges the strings that one surface's cells collected, writes every string that was checked to `COPY_OUTPUT`, and compares the violations
 * with the fixture (or updates it). A unit's strings are the union of its desktop and phone boots.
 * @param {{ id: string, family: string, owner: string }} surface
 * @param {{ viewport: string, state: string | undefined, items: { role: string, text: string, target: string }[] }[]} collected
 * @param {string[]} collectErrors
 */
async function judgeCopyCheck(surface, collected, collectErrors) {
    const origin = copyOrigin();
    // The backends of a surface and its plain open are one unit, and so are the two viewports of a unit, so their entries are merged.
    const merged = new Map();
    for (const entry of collected) {
        const key = JSON.stringify([entry.state ?? '']);
        const known = merged.get(key) ?? { state: entry.state, items: [] };
        known.items.push(...entry.items.map(item => ({ ...item, viewport: entry.viewport })));
        merged.set(key, known);
    }
    const digest = { surface: surface.id, family: surface.family, owner: surface.owner, units: [] };
    const judgedEntries = [...merged.values()].map(entry => {
        const labels = new Map();
        const observations = [];
        // The digest keeps the viewports that show each string, which is how the evidence tells what the phone layout changes.
        const remember = (key, label, viewport) => labels.set(key, { ...label, viewports: [...new Set([...(labels.get(key)?.viewports ?? []), viewport])].sort() });
        for (const item of entry.items) {
            const { origin: where, text } = origin.classify(item.text);
            if (where === 'foreign' || where === 'data') {
                remember(JSON.stringify([item.role, item.text]), { role: item.role, text: item.text, origin: where }, item.viewport);
                continue;
            }
            const verdict = judgeRendered(item.role, text, { origin: where });
            remember(JSON.stringify([item.role, text]), { role: item.role, text, origin: where, ...(verdict && { kind: verdict.kind, expected: verdict.expected }) }, item.viewport);
            if (verdict) {
                observations.push({
                    surface: surface.id,
                    ...(entry.state && { state: entry.state }),
                    role: item.role,
                    text,
                    expected: verdict.expected,
                    target: normaliseTarget(item.target),
                    section: where === 'unknown' ? null : where,
                    kind: verdict.kind,
                });
            }
        }
        digest.units.push({ state: entry.state ?? null, labels: [...labels.values()] });
        return { ...entry, observations: uniqueObservations(observations) };
    });
    fs.mkdirSync(COPY_OUTPUT, { recursive: true });
    fs.writeFileSync(path.join(COPY_OUTPUT, `${surface.id}.json`), `${JSON.stringify(digest, null, 2)}\n`);

    const observed = uniqueObservations(judgedEntries.flatMap(entry => entry.observations));
    const units = judgedEntries.map(entry => ({ surface: surface.id, ...(entry.state && { state: entry.state }) }));
    if (origin.upstreamError) {
        test.info().annotations.push({ type: 'copy', description: `the upstream base commit could not be read, so a string's section is taken from its record: ${origin.upstreamError.message.split('\n')[0]}` });
    }

    if (COPY_UPDATE) {
        await updateCopyBaselineFile({ observed, units }, { allowSillybunny: COPY_ALLOW_SILLYBUNNY, file: COPY_FIXTURE });
        expect.soft(collectErrors, `copy: ${surface.id}: units that could not be collected (their records are left as they are)`).toEqual([]);
        return;
    }
    const baseline = readCopyBaseline(COPY_FIXTURE);
    expect.soft(baseline, `copy: ${path.basename(COPY_FIXTURE)} is missing. Write it with ${COPY_ALLOW_VARIABLE}=1 and: ${COPY_UPDATE_COMMAND}`).not.toBeNull();
    const problems = formatCopyComparison(compareToCopyBaseline({ observed, baseline: baseline ?? emptyCopyBaseline(), units }));
    expect.soft([...collectErrors.map(message => `could not be collected (its records are not judged): ${message}`), ...problems], `copy: ${surface.id} against ${path.basename(COPY_FIXTURE)}`).toEqual([]);
}

/** The units that one boot opens: each backend of the surface, then each state at the first backend. */
function unitsAt(surface, viewport) {
    const backends = backendsOf(surface);
    return [
        ...backends.map(backend => ({ state: undefined, backend })),
        ...statesFor(surface, viewport).map(state => ({ state: state.id, backend: backends[0] })),
    ];
}

/** Every cell that a surface is scanned in, grouped into the units that the baseline keys by (the surface, and each state). */
function plannedUnits(surface, viewports) {
    const units = new Map();
    for (const viewport of viewports) {
        for (const theme of THEMES) {
            for (const unit of unitsAt(surface, viewport)) {
                const key = unit.state ?? '';
                const entry = units.get(key) ?? { surface: surface.id, state: unit.state, cells: [] };
                entry.cells.push({ theme: theme.id, viewport, backend: unit.backend });
                units.set(key, entry);
            }
        }
    }
    return [...units.values()];
}

/** The passes of one viewport: the first theme carries every check, the others the axe scan only. */
function passesFor(plan, viewport, { axe }) {
    const here = plan.at(viewport);
    return THEMES.map((theme, index) => {
        const checks = index === 0
            ? { ...here, axe: here.axe && axe }
            : { smoke: false, parity: false, axe: here.axe && axe, copy: false };
        const first = backendsOf(plan.surface)[0];
        const units = unitsAt(plan.surface, viewport)
            .filter(unit => checks.smoke || checks.axe || checks.copy || (checks.parity && unit.state === undefined && unit.backend === first))
            .map(unit => ({ ...unit, parity: checks.parity && unit.state === undefined && unit.backend === first }));
        return { theme, checks, units };
    }).filter(pass => pass.checks.smoke || pass.checks.parity || pass.checks.axe || pass.checks.copy);
}

/** What a surface costs, in boots and opens, so that the longest tests start first and do not end the run alone. */
function weightOf(plan) {
    return plan.viewports.reduce((total, viewport) => total + passesFor(plan, viewport, { axe: true }).reduce((sum, pass) => sum + 3 + pass.units.length, 0), 0);
}

const heaviestFirst = plans.filter(candidate => candidate.any).map(candidate => ({ candidate, weight: weightOf(candidate) })).sort((a, b) => b.weight - a.weight);
for (const { candidate: plan } of heaviestFirst) {
    const { surface } = plan;
    test(`${surface.id}`, async ({ browser, baseURL, extraHTTPHeaders, locale, timezoneId }) => {
        const axeViewports = plan.viewports.filter(viewport => plan.at(viewport).axe);
        const units = plannedUnits(surface, axeViewports);
        const bootCount = plan.viewports.reduce((total, viewport) => total + passesFor(plan, viewport, { axe: true }).length, 0);
        const openCount = plan.viewports.reduce((total, viewport) => total + passesFor(plan, viewport, { axe: true }).reduce((sum, pass) => sum + pass.units.length, 0), 0);
        test.setTimeout(60_000 + bootCount * 2 * 40_000 + openCount * (2 * 15_000 + 5_000));

        for (const [name, reason] of Object.entries(plan.skips)) {
            if (reason && ACTIVE.has(name)) {
                test.info().annotations.push({ type: 'skipped', description: `${name}: ${reason}` });
            }
        }
        for (const note of CHECK_NOTES) {
            test.info().annotations.push({ type: 'checks', description: note });
        }

        const runDirectory = path.join(OUTPUT, 'runs', surface.id);
        if (plan.runs.axe) {
            fs.rmSync(runDirectory, { recursive: true, force: true });
            fs.mkdirSync(runDirectory, { recursive: true });
        }
        if (CENSUS_DIR && plan.runs.parity) {
            for (const viewport of plan.viewports.filter(candidate => plan.at(candidate).parity)) {
                fs.rmSync(`${CENSUS_DIR}/raw/${surface.id}@${viewport}.json`, { force: true });
            }
        }

        const started = Date.now();
        const step = message => VERBOSE && console.log(`${surface.id} +${Math.round((Date.now() - started) / 1000)}s ${message}`);
        const runs = [];
        const errors = [];
        const retried = [];
        const excluded = new Set();
        const pageErrors = [];
        /** What the copy check collected, one entry for each viewport and unit, and the units that it could not collect. */
        const copyCollected = [];
        const copyErrors = [];
        /** The cell that smoke and parity were judged in, by viewport. */
        const judgedCells = new Map();
        let axeStalled = false;

        const newCell = (viewport, pass) => ({ viewport, pass, theme: pass.theme, smoke: [], parity: null, copy: [], copyErrors: [], runs: [], errors: [], retried: [], excluded: new Set(), pageErrors: [], stalled: false });

        /** Opens each unit of a pass in turn on a page that is booted in the pass's theme, and runs the checks of the pass on it. */
        async function runPass(page, cell) {
            const { viewport, theme, pass } = cell;
            const { checks } = pass;
            for (const unit of pass.units) {
                const smokeLabel = unit.state ? `${surface.id} state ${unit.state}` : unit.backend ? `${surface.id} [${unit.backend}]` : surface.id;
                const axeLabel = `${theme.id} ${viewport} ${unit.state ? `state ${unit.state}` : `surface${unit.backend ? ` [${unit.backend}]` : ''}`}`;
                const options = { stateId: unit.state, backend: unit.backend, viewport };
                let opened = false;
                try {
                    // The open, the smoke check and the parity measurement come first, so that nothing the axe scan does can reach them. The
                    // app clicks the message box from a timer a moment after a chat loads, and that scripted click dismisses an open menu while
                    // it is scanned: scripted clicks are stopped from the end of the open until the scan is done. The clicks that the
                    // registry's open steps make have finished by then.
                    const attempt = isFirst => capped(surface, axeLabel, async () => {
                        const out = { smoke: [], parity: null, scan: null, axeError: null, copy: null, copyError: null, opened: false };
                        let root;
                        step(`open ${axeLabel}`);
                        try {
                            root = await openSurface(page, surface, options);
                            out.opened = true;
                            if (isFirst && VANISH?.id === surface.id && unit.state === undefined) {
                                await page.locator(root).first().evaluate((element, ms) => { setTimeout(() => element.remove(), ms); }, VANISH.ms);
                            }
                        } catch (error) {
                            if (checks.smoke) {
                                out.smoke.push(labelled(smokeLabel, briefOf(error)));
                            }
                            if (unit.parity) {
                                out.parity = { failures: [labelled(`${surface.id} at ${viewport}`, briefOf(error))], raw: null };
                            }
                            out.axeError = checks.axe ? error : null;
                            out.copyError = checks.copy ? error : null;
                            return out;
                        }
                        if (checks.smoke) {
                            try {
                                await expectOpen(page, smokeLabel, root, readySelectors(surface, options));
                            } catch (error) {
                                out.smoke.push(labelled(smokeLabel, briefOf(error)));
                            }
                        }
                        if (unit.parity) {
                            step(`measure ${axeLabel}`);
                            try {
                                out.parity = await measureParity(page, plan, root, viewport);
                            } catch (error) {
                                out.parity = { failures: [labelled(`${surface.id} at ${viewport}`, briefOf(error))], raw: null };
                            }
                        }
                        if (checks.copy) {
                            // Reading the text changes nothing on the page, so it needs no click guard; it comes before the scan, which may add nodes.
                            try {
                                if (COPY_INJECT) {
                                    await page.locator(root).first().evaluate((host, label) => host.insertAdjacentHTML('afterbegin', `<button type="button" data-sb-copy-probe>${label}</button><button type="button" data-sb-copy-probe>mAriEl the wanderer</button>`), COPY_INJECT_LABEL);
                                }
                                out.copy = await page.locator(root).first().evaluate(collectCopy);
                            } catch (error) {
                                out.copyError = error;
                            }
                        }
                        if (checks.axe) {
                            try {
                                await page.evaluate(() => window.addEventListener('click', window.__sbAxeClickGuard = event => event.isTrusted || event.stopImmediatePropagation(), true));
                                try {
                                    await expect(page.locator(root).first(), `${root} is visible`).toBeVisible();
                                    if (INJECT) {
                                        await page.locator(root).first().evaluate(host => host.insertAdjacentHTML('afterbegin', '<img data-sb-axe-probe src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="8" height="8"><span data-sb-axe-probe style="position:fixed;top:0;left:0;z-index:2147483647;padding:4px;font-size:16px;color:#bbb;background:#fff">Probe label</span>'));
                                    }
                                    step(`scan ${axeLabel}`);
                                    out.scan = { root, found: await scanStable(page, root, { exclude: EXCLUDED_REGIONS[surface.id] }) };
                                } finally {
                                    await page.evaluate(() => window.removeEventListener('click', window.__sbAxeClickGuard, true)).catch(() => {});
                                }
                            } catch (error) {
                                out.axeError = error;
                            }
                        }
                        return out;
                    });
                    const firstOpen = await attempt(true);
                    let out = firstOpen;
                    // A surface that closes itself a moment after it opens is opened once more.
                    if ((checks.axe && out.axeError) || (checks.copy && out.copyError)) {
                        cell.retried.push(axeLabel);
                        out = await attempt(false);
                    }
                    opened = out.opened;
                    if (checks.copy) {
                        const items = firstOpen.copy ?? out.copy;
                        if (items) {
                            cell.copy.push({ state: unit.state, items });
                        } else {
                            cell.copyErrors.push(`${axeLabel}: ${briefOf(out.copyError ?? firstOpen.copyError)}`);
                        }
                    }
                    // Smoke judges the first open of the unit, as it did when it booted on its own: the reopen that the scan needs does not clear it.
                    cell.smoke.push(...firstOpen.smoke);
                    if (out.parity) {
                        cell.parity = out.parity;
                    }
                    if (out.axeError) {
                        await page.screenshot({ path: path.join(runDirectory, `failed_${sanitise(axeLabel)}.png`) }).catch(() => {});
                        cell.excluded.add(unit.state ?? '');
                        cell.errors.push(`${axeLabel}: ${briefOf(out.axeError)}`);
                    } else if (out.scan) {
                        // The section is decided by the element that has the violation, so it is kept with the node.
                        const withSection = violations => violations.map(violation => ({
                            ...violation,
                            nodes: violation.nodes.map(node => ({ ...node, section: sectionOf(surface, { sillybunnyElement: isSillyBunnyElement(node) }) })),
                        }));
                        const { root, found } = out.scan;
                        cell.runs.push({
                            surface: surface.id, family: surface.family, owner: surface.owner, state: unit.state, backend: unit.backend, theme: theme.id, viewport, root,
                            settled: found.settled, stable: found.stable, violations: withSection(found.violations), bestPractice: withSection(found.bestPractice), incomplete: found.incomplete,
                        });
                    }
                } catch (error) {
                    if (error.stalled) {
                        throw error;
                    }
                    cell.excluded.add(unit.state ?? '');
                    cell.errors.push(`${axeLabel}: ${briefOf(error)}`);
                }
                // Closing is part of the smoke check; the axe scan closes the plain open for the next unit. A close after an open that failed is
                // tried only for the smoke check.
                if (surface.close && unit.state === undefined && (opened || checks.smoke)) {
                    let closed = false;
                    try {
                        await surface.close(page);
                        closed = true;
                    } catch (error) {
                        if (checks.smoke) {
                            cell.smoke.push(labelled(`${smokeLabel} close`, briefOf(error)));
                        }
                        if (checks.axe && opened) {
                            cell.excluded.add(unit.state ?? '');
                            cell.errors.push(`${axeLabel}: ${briefOf(error)}`);
                        }
                    }
                    if (closed && checks.smoke) {
                        try {
                            await expect(page.locator(surface.root).first(), `${smokeLabel}: ${surface.root} is gone after close`).toBeHidden();
                        } catch (error) {
                            cell.smoke.push(labelled(`${smokeLabel} close`, briefOf(error)));
                        }
                    }
                }
            }
        }

        /** Marks a cell whose page could not be got (`what` is the step that failed): every unit of the pass failed to run in it. */
        function failCell(cell, error, what) {
            cell.stalled = Boolean(error.stalled);
            const { checks, units: passUnits } = cell.pass;
            for (const unit of cell.stalled ? units : passUnits) {
                cell.excluded.add(unit.state ?? '');
            }
            const detail = String(error.message).split('\n').slice(0, 3).join(' | ');
            const said = cell.stalled ? detail : `${cell.theme.id} ${cell.viewport} ${what}: ${detail}`;
            if (checks.smoke) {
                cell.smoke.push(`${surface.id} ${said}`);
            }
            if (checks.parity) {
                cell.parity = { failures: [`${surface.id} at ${cell.viewport}: ${said}`], raw: null };
            }
            if (checks.axe) {
                cell.errors.push(said);
            }
            if (checks.copy) {
                cell.copyErrors.push(said);
            }
        }

        /** Boots the app once, in the theme of the pass, and runs the pass in it. Nothing is kept here; the caller decides. */
        async function scanBoot(viewport, pass) {
            const cell = newCell(viewport, pass);
            const variant = { ...CELL, viewport, theme: pass.theme.id };
            const context = await browser.newContext({ ...variantContextOptions(variant), baseURL, locale, timezoneId, ...(extraHTTPHeaders && { extraHTTPHeaders }) });
            let stage = 'boot';
            try {
                const page = await context.newPage();
                trackRequests(page);
                if (pass.checks.smoke) {
                    page.on('pageerror', error => cell.pageErrors.push(error.message));
                }
                step(`boot ${pass.theme.id} ${viewport}`);
                await capped(surface, `boot ${pass.theme.id} ${viewport}`, () => bootSurfaceApp(page, baseURL, { variant, needs: surface.needs }));
                if (pass.checks.smoke) {
                    const pointer = await page.evaluate(() => (matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine'));
                    if (pointer !== viewportById(viewport).pointer) {
                        cell.smoke.push(`${surface.id}: pointer type of ${viewport} is ${pointer}, wanted ${viewportById(viewport).pointer}`);
                    }
                }
                stage = 'run';
                await runPass(page, cell);
            } catch (error) {
                failCell(cell, error, stage);
            } finally {
                await context.close().catch(() => {});
            }
            return cell;
        }

        /** What a finished cell adds to the surface's results. */
        function keep(cell) {
            runs.push(...cell.runs);
            errors.push(...cell.errors);
            retried.push(...cell.retried);
            cell.excluded.forEach(state => excluded.add(state));
            pageErrors.push(...cell.pageErrors);
            if (cell.pass.checks.smoke || cell.pass.checks.parity) {
                judgedCells.set(cell.viewport, cell);
            }
            // After a stall the rerun boot collects the strings again, so what the stalled boot could not collect is not an error.
            if (cell.pass.checks.copy) {
                copyCollected.push(...cell.copy.map(unit => ({ viewport: cell.viewport, ...unit })));
                copyErrors.push(...(cell.stalled ? [] : cell.copyErrors));
            }
            for (const run of cell.runs) {
                fs.writeFileSync(path.join(runDirectory, `${sanitise([run.state ?? 'surface', run.backend ?? '', run.theme, run.viewport].filter(Boolean).join('__'))}.json`), `${JSON.stringify(run, null, 2)}\n`);
            }
        }

        /** Runs the cell of one viewport and theme: its boot, the boot again when the cell failed, and the boot that finishes smoke and parity after a stall. */
        async function runCell({ viewport, theme }) {
            // After a stall nothing is scanned any more, and the passes that only scan are left out.
            const pass = passesFor(plan, viewport, { axe: !axeStalled }).find(candidate => candidate.theme === theme);
            if (!pass) {
                return null;
            }
            let cell = await scanBoot(viewport, pass);
            // A cell whose open step failed (a panel that was not built in time under load) is run once more from a fresh boot.
            if ((cell.errors.length || cell.copyErrors.length) && !cell.stalled) {
                const first = cell.errors[0] ?? cell.copyErrors[0];
                cell = await scanBoot(viewport, pass);
                cell.retried.unshift(`${pass.theme.id} ${viewport}: whole cell (${first.slice(0, 120)})`);
            }
            let rerun = null;
            if (cell.stalled) {
                axeStalled = true;
                // The stall leaves the cell's other checks unfinished: they run again in a boot that does not scan.
                if (pass.checks.smoke || pass.checks.parity || pass.checks.copy) {
                    rerun = await scanBoot(viewport, passesFor(plan, viewport, { axe: false })[0]);
                }
            }
            return { cell, rerun };
        }

        const cellsInParallel = Math.max(1, Math.min(MAX_CELLS_AT_ONCE, Math.floor(CONTEXT_BUDGET / heaviestFirst.length)));
        test.info().annotations.push({ type: 'cells at once', description: String(cellsInParallel) });
        const finished = await mapLimit(plan.viewports.flatMap(viewport => THEMES.map(theme => ({ viewport, theme }))), cellsInParallel, runCell);
        // The cells are kept in the order of the viewports and themes, whatever order they finished in.
        for (const result of finished.filter(Boolean)) {
            keep(result.cell);
            if (result.rerun) {
                judgedCells.set(result.cell.viewport, result.rerun);
                pageErrors.push(...result.rerun.pageErrors);
                if (result.rerun.pass.checks.copy) {
                    copyCollected.push(...result.rerun.copy.map(unit => ({ viewport: result.rerun.viewport, ...unit })));
                    copyErrors.push(...result.rerun.copyErrors);
                }
            }
        }

        // Smoke and parity are judged for each viewport, each under its own label.
        for (const viewport of plan.viewports) {
            const cell = judgedCells.get(viewport);
            if (!cell) {
                continue;
            }
            const { checks } = cell.pass;
            if (checks.smoke) {
                expect.soft(cell.smoke, `smoke: ${surface.id} at ${viewport} (${cell.theme.id}): surfaces that did not open`).toEqual([]);
            }
            if (checks.parity) {
                if (CENSUS_DIR && cell.parity?.raw) {
                    writeJson(`${CENSUS_DIR}/raw/${surface.id}@${viewport}.json`, cell.parity.raw);
                }
                expect.soft(cell.parity?.failures ?? [`${surface.id} at ${viewport}: not measured`], `parity: ${surface.id} at ${viewport} (${cell.theme.id}): differences from the canonical values of the ${surface.family} family`).toEqual([]);
            }
        }
        if (pageErrors.length) {
            test.info().annotations.push({ type: 'page errors', description: pageErrors.join('\n') });
        }
        if (plan.runs.copy) {
            await judgeCopyCheck(surface, copyCollected, copyErrors);
        }
        if (!plan.runs.axe) {
            return;
        }

        const observations = runs.flatMap(run => run.violations.flatMap(violation => violation.nodes.map(node => ({
            surface: surface.id,
            state: run.state,
            rule: violation.id,
            target: node.target,
            cell: { theme: run.theme, viewport: run.viewport, backend: run.backend },
            section: node.section,
        }))));
        const judged = units.filter(unit => !excluded.has(unit.state ?? ''));
        const observed = toTriples(observations.filter(observation => !excluded.has(observation.state ?? '')));
        const inScope = record => record.surface === surface.id && !excluded.has(record.state ?? '') && judged.length > 0;
        const incomplete = countIncomplete(runs);

        const digest = {
            surface: surface.id,
            family: surface.family,
            owner: surface.owner,
            runs: runs.length,
            errors,
            retried,
            unsettled: runs.filter(run => !run.settled || !run.stable).map(run => `${run.theme} ${run.viewport} ${run.state ? `state ${run.state}` : 'surface'}${run.settled ? '' : ' (still changing or loading)'}${run.stable ? '' : ' (results changed between scans)'}`),
            findings: collectFindings(runs),
            bestPractice: collectFindings(runs.map(run => ({ ...run, violations: run.bestPractice }))),
            incomplete,
        };
        const undecided = Object.entries(incomplete).sort((a, b) => b[1] - a[1]);
        if (undecided.length) {
            test.info().annotations.push({ type: 'undecided', description: `${undecided.reduce((total, [, count]) => total + count, 0)} node-runs: ${undecided.map(([rule, count]) => `${rule} ${count}`).join(', ')}` });
        }
        fs.mkdirSync(path.join(OUTPUT, 'surfaces'), { recursive: true });
        fs.writeFileSync(path.join(OUTPUT, 'surfaces', `${surface.id}.json`), `${JSON.stringify(digest, null, 2)}\n`);
        await withFileLock(SUMMARY_LOCK, () => writeSummary(OUTPUT, plans.filter(candidate => candidate.runs.axe).map(candidate => candidate.surface.id), SKIPPED_SURFACES));

        if (UPDATE) {
            await updateBaselineFile({ observed, units: judged, inScope }, { allowSillybunny: ALLOW_SILLYBUNNY, file: FIXTURE });
            expect.soft(errors, `axe: ${surface.id}: runs that could not be scanned (their records are left as they are)`).toEqual([]);
            return;
        }
        const baseline = readBaseline(FIXTURE);
        expect.soft(baseline, `axe: ${path.basename(FIXTURE)} is missing. Write it with ${ALLOW_VARIABLE}=1 and: ${UPDATE_COMMAND}`).not.toBeNull();
        const cellsOf = record => [...new Set(observations
            .filter(item => item.state === record.state && item.rule === record.rule && item.target === record.target
                && ['theme', 'viewport', 'backend'].every(key => record[key] === undefined || item.cell[key] === record[key]))
            .map(item => [item.cell.theme, item.cell.viewport, item.cell.backend].filter(Boolean).join(' ')))].join('; ');
        const problems = formatComparison(compareToBaseline({ observed, baseline, units: judged, inScope }), { cellsOf });
        expect.soft([...errors.map(message => `could not be scanned (its records are not judged): ${message}`), ...problems], `axe: ${surface.id} against ${path.basename(FIXTURE)}`).toEqual([]);
    });
}
