import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
    ALLOW_VARIABLE, BASELINE_PATH, FIXTURE_VARIABLE, UPDATE_COMMAND, UPDATE_VARIABLE, compareToBaseline, formatBaseline, formatComparison, isSillyBunnyElement, readBaseline,
    sectionOf, toTriples, updateBaselineFile, withFileLock, writeFileAtomically,
} from '../helpers/axe-baseline.js';
import { collectFindings, countIncomplete, writeSummary } from '../helpers/axe-report.js';
import { AXE_TAGS, DISABLED_RULES, GATED_TAGS, scanStable, trackRequests } from '../helpers/axe-scan.js';
import { THEMES, variantContextOptions, viewportsFor } from '../helpers/surface-matrix.js';
import { bootSurfaceApp, openSurface } from '../helpers/surfaces/boot.js';
import { SURFACES, backendsOf, loadProblemsFor, selectSurfaces, statesFor, validateSurfaces } from '../helpers/surfaces/index.js';
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- A surface lists its own backends and states, and a close step is optional. */

// Runs axe inside the root of every surface of the registry, and of each of its states and backends, at 1440x900 and 390x844 in the
// Libadwaita and Libadwaita Light themes. The WCAG 2.0, 2.1 and 2.2 A and AA results are compared with the fixture
// tests/fixtures/axe-baseline.json and gate the run: a violation that is in neither section of the file fails, and so does a record that
// no longer occurs, so the file equals the tree. The best-practice results are reported in the summary and never gate.
// A record is judged only when its surface ran in this run.
//
// SURFACE_FAMILY=<family>[,<family>] and SURFACE_ID=<id>[,<id>] limit the run to those families and surfaces.
// SURFACE_AXE_UPDATE=1 writes the fixture instead of comparing; it refuses to add a record to the `sillybunny` section unless
//   SURFACE_AXE_ALLOW_SILLYBUNNY=1 is set too.
// SURFACE_AXE_FIXTURE=<path> reads and writes that file instead of the committed fixture.
// SURFACE_AXE_DIR=<directory> sets where the results go (default: <tmp>/surface-axe): runs/<surface>/<one file per run>.json,
//   surfaces/<surface>.json, summary.json and summary.md.
// SURFACE_AXE_VERBOSE=1 prints each step of a surface with the time it took.
// SURFACE_AXE_INJECT=1 puts an image without a text alternative and a low-contrast label into every root before it is scanned, to show
//   that the spec catches a new violation and names its section; it cannot be combined with an update.
const SCAN_VIEWPORTS = ['1440x900', '390x844'];
const UPDATE = process.env[UPDATE_VARIABLE] === '1';
const ALLOW_SILLYBUNNY = process.env[ALLOW_VARIABLE] === '1';
const FIXTURE = process.env[FIXTURE_VARIABLE] ? path.resolve(process.env[FIXTURE_VARIABLE]) : BASELINE_PATH;
const OUTPUT = path.resolve(process.env.SURFACE_AXE_DIR || path.join(os.tmpdir(), 'surface-axe'));
const STEP_CAP_MS = 90_000;
const VERBOSE = process.env.SURFACE_AXE_VERBOSE === '1';
const INJECT = process.env.SURFACE_AXE_INJECT === '1';
const SUMMARY_LOCK = path.join(OUTPUT, 'summary');

/** Surfaces that this scan does not run, with what is true of each. The registry owns their open steps. */
const SKIPPED_SURFACES = Object.freeze({
    'status.chat-tools.no-chats-mobile': 'the sheet closes itself shortly after it opens, because no character is open, so it is gone before a scan finishes',
    'status.persona-picker.empty': 'the menu opens, and the scan of it then does not return within the 90 s that a step may take; the cause is not known',
    'status.persona-picker.no-notes': 'the menu opens, and the scan of it then does not return within the 90 s that a step may take; the cause is not known',
    'panel.moving.visual-novel': 'its open step waits for a sprite of every group member, which can fail while the app is still loading',
    'list.logit-bias': 'the rows of the bias list are built after the surface reports ready, so which cells show a violation on them varies',
    'status.sampling.unavailable': 'its open step waits for the rows of the bias list, which are not always built',
});

/** Regions that a scan leaves out of a surface, because another surface covers them. */
const EXCLUDED_REGIONS = Object.freeze({
    'settings.backend.sampling': ['.openai_logit_bias_list'],
});

const selection = selectSurfaces();

const seenIds = new Set();
const runnable = [];
const invalid = [];
for (const surface of selection.surfaces.filter(candidate => !(candidate.id in SKIPPED_SURFACES))) {
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

test('the registry is valid', () => {
    const problems = selection.active ? [...loadProblemsFor(selection.families), ...invalid] : validateSurfaces();
    expect(problems, 'registry problems (a surface with a problem is not scanned)').toEqual([]);
});

if (selection.problem) {
    test('the surface filter selects surfaces', () => {
        expect(selection.problem, 'the surface filter').toBeNull();
    });
} else if (selection.surfaces.length > 0 && runnable.length === 0 && invalid.length === 0) {
    test('the surface filter selects a surface that is scanned', () => {
        expect(runnable.map(surface => surface.id), `every selected surface is skipped (${selection.surfaces.map(surface => surface.id).join(', ')})`).not.toEqual([]);
    });
}

// A skipped surface is declared as a test that is not run, so that the reporter lists it, with its reason, in every run that selects it.
for (const surface of selection.surfaces.filter(candidate => candidate.id in SKIPPED_SURFACES)) {
    // eslint-disable-next-line playwright/no-skipped-test, playwright/expect-expect -- the point is that the reporter prints the skip
    test.fixme(`${surface.id}`, { annotation: { type: 'skipped', description: SKIPPED_SURFACES[surface.id] } }, async () => {});
}

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

/** The units that one boot scans: each backend of the surface, then each state at the first backend. */
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

for (const surface of runnable) {
    test(`${surface.id}`, async ({ browser, baseURL, extraHTTPHeaders, locale, timezoneId }) => {
        const viewports = viewportsFor(surface).filter(id => SCAN_VIEWPORTS.includes(id));
        const units = plannedUnits(surface, viewports);
        const scans = units.reduce((total, unit) => total + unit.cells.length, 0);
        test.setTimeout(60_000 + viewports.length * THEMES.length * 2 * 40_000 + scans * 2 * 15_000);

        const runDirectory = path.join(OUTPUT, 'runs', surface.id);
        fs.rmSync(runDirectory, { recursive: true, force: true });
        fs.mkdirSync(runDirectory, { recursive: true });

        const started = Date.now();
        const step = message => VERBOSE && console.log(`${surface.id} +${Math.round((Date.now() - started) / 1000)}s ${message}`);
        const runs = [];
        const errors = [];
        const retried = [];
        const excluded = new Set();

        /** Boots the app in one cell and scans every unit of the surface in it. Nothing is kept here; the caller decides. */
        async function scanCell(viewport, theme) {
            const cell = { runs: [], errors: [], retried: [], excluded: new Set(), stalled: false };
            const variant = { viewport, theme: theme.id };
            const context = await browser.newContext({ ...variantContextOptions(variant), baseURL, locale, timezoneId, ...(extraHTTPHeaders && { extraHTTPHeaders }) });
            try {
                const page = await context.newPage();
                trackRequests(page);
                step(`boot ${theme.id} ${viewport}`);
                await capped(surface, `boot ${theme.id} ${viewport}`, () => bootSurfaceApp(page, baseURL, { variant, needs: surface.needs }));
                for (const unit of unitsAt(surface, viewport)) {
                    const label = `${theme.id} ${viewport} ${unit.state ? `state ${unit.state}` : `surface${unit.backend ? ` [${unit.backend}]` : ''}`}`;
                    try {
                        step(`open ${label}`);
                        // The app clicks the message box from a timer a moment after a chat loads, and that scripted click dismisses an open
                        // menu while it is scanned. Scripted clicks are stopped from the end of the open until the scan is done; the
                        // clicks that the registry's open steps make have finished by then.
                        const scan = () => capped(surface, label, async () => {
                            const opened = await openSurface(page, surface, { stateId: unit.state, backend: unit.backend, viewport });
                            await page.evaluate(() => window.addEventListener('click', window.__sbAxeClickGuard = event => event.isTrusted || event.stopImmediatePropagation(), true));
                            try {
                                await expect(page.locator(opened).first(), `${opened} is visible`).toBeVisible();
                                if (INJECT) {
                                    await page.locator(opened).first().evaluate(host => host.insertAdjacentHTML('afterbegin', '<img data-sb-axe-probe src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="8" height="8"><span data-sb-axe-probe style="position:fixed;top:0;left:0;z-index:2147483647;padding:4px;font-size:16px;color:#bbb;background:#fff">Probe label</span>'));
                                }
                                step(`scan ${label}`);
                                return { root: opened, found: await scanStable(page, opened, { exclude: EXCLUDED_REGIONS[surface.id] }) };
                            } finally {
                                await page.evaluate(() => window.removeEventListener('click', window.__sbAxeClickGuard, true)).catch(() => {});
                            }
                        });
                        // A surface that closes itself a moment after it opens is opened once more.
                        const { root, found } = await scan().catch(error => {
                            if (error.stalled) {
                                throw error;
                            }
                            cell.retried.push(label);
                            return scan();
                        });
                        // The section is decided by the element that has the violation, so it is kept with the node.
                        const withSection = violations => violations.map(violation => ({
                            ...violation,
                            nodes: violation.nodes.map(node => ({ ...node, section: sectionOf(surface, { sillybunnyElement: isSillyBunnyElement(node) }) })),
                        }));
                        const run = {
                            surface: surface.id, family: surface.family, owner: surface.owner, state: unit.state, backend: unit.backend, theme: theme.id, viewport, root,
                            settled: found.settled, stable: found.stable, violations: withSection(found.violations), bestPractice: withSection(found.bestPractice), incomplete: found.incomplete,
                        };
                        cell.runs.push(run);
                        if (surface.close && unit.state === undefined) {
                            await surface.close(page);
                        }
                    } catch (error) {
                        if (error.stalled) {
                            throw error;
                        }
                        await page.screenshot({ path: path.join(runDirectory, `failed_${sanitise(label)}.png`) }).catch(() => {});
                        cell.excluded.add(unit.state ?? '');
                        cell.errors.push(`${label}: ${String(error.message).split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join(' | ')}`);
                    }
                }
            } catch (error) {
                cell.stalled = Boolean(error.stalled);
                for (const unit of cell.stalled ? units : unitsAt(surface, viewport)) {
                    cell.excluded.add(unit.state ?? '');
                }
                cell.errors.push(cell.stalled ? error.message : `${theme.id} ${viewport} boot: ${String(error.message).split('\n').slice(0, 3).join(' | ')}`);
            } finally {
                await context.close().catch(() => {});
            }
            return cell;
        }

        let stalled = false;
        for (const viewport of viewports) {
            for (const theme of THEMES) {
                if (stalled) {
                    break;
                }
                // A cell whose open step failed (a panel that was not built in time under load) is run once more from a fresh boot.
                let cell = await scanCell(viewport, theme);
                if (cell.errors.length && !cell.stalled) {
                    retried.push(`${theme.id} ${viewport}: whole cell (${cell.errors[0].slice(0, 120)})`);
                    cell = await scanCell(viewport, theme);
                }
                stalled = cell.stalled;
                runs.push(...cell.runs);
                errors.push(...cell.errors);
                retried.push(...cell.retried);
                cell.excluded.forEach(state => excluded.add(state));
                for (const run of cell.runs) {
                    fs.writeFileSync(path.join(runDirectory, `${sanitise([run.state ?? 'surface', run.backend ?? '', run.theme, run.viewport].filter(Boolean).join('__'))}.json`), `${JSON.stringify(run, null, 2)}\n`);
                }
            }
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
        await withFileLock(SUMMARY_LOCK, () => writeSummary(OUTPUT, runnable.map(candidate => candidate.id), SKIPPED_SURFACES));

        if (UPDATE) {
            await updateBaselineFile({ observed, units: judged, inScope }, { allowSillybunny: ALLOW_SILLYBUNNY, file: FIXTURE });
            expect(errors, 'runs that could not be scanned (their records are left as they are)').toEqual([]);
            return;
        }
        const baseline = readBaseline(FIXTURE);
        expect(baseline, `${path.basename(FIXTURE)} is missing. Write it with ${ALLOW_VARIABLE}=1 and: ${UPDATE_COMMAND}`).not.toBeNull();
        const cellsOf = record => [...new Set(observations
            .filter(item => item.state === record.state && item.rule === record.rule && item.target === record.target
                && ['theme', 'viewport', 'backend'].every(key => record[key] === undefined || item.cell[key] === record[key]))
            .map(item => [item.cell.theme, item.cell.viewport, item.cell.backend].filter(Boolean).join(' ')))].join('; ');
        const problems = formatComparison(compareToBaseline({ observed, baseline, units: judged, inScope }), { cellsOf });
        expect([...errors.map(message => `could not be scanned (its records are not judged): ${message}`), ...problems], `${surface.id} against ${path.basename(FIXTURE)}`).toEqual([]);
    });
}
