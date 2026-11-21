import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { variantContextOptions } from '../helpers/surface-matrix.js';
import { backendsOf, surfacesByFamily } from '../helpers/surfaces/index.js';
import { BACKENDS } from '../helpers/surfaces/schema.js';
import {
    buildFixture,
    checkParts,
    sectionKey,
    serializeInventory,
    validateAccepted,
    validateInventory,
} from '../helpers/settings-inventory.js';
import { ACCEPTED_DIFFERENCES, skipSelectorsFor } from '../helpers/settings-inventory-rules.js';
import { checkSection, recordSection } from '../helpers/settings-inventory-run.js';
import {
    EXTENSION_DETAIL,
    bootInventoryPage,
    closeExtensionSubpage,
    listExtensionRows,
    openExtensionSubpage,
    openSection,
    selectSource,
    settleRequests,
    sourcesOf,
} from '../helpers/settings-inventory-steps.js';
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Record mode and check mode run the same walk, and a surface lists its own backends and states. */

// The settings inventory: a fixture of every control of every settings page and a check that each control is still there, can still
// be reached, and still saves what it saved. A recording writes each test's sections to SB_INVENTORY_PARTS; the test that completes the
// set writes the fixture (SB_INVENTORY_FIXTURE overrides its path) and the findings next to the parts. SURFACE_ID limits a run to some
// surfaces, and a recording of some of the pages writes no fixture. SB_INVENTORY_VIEWPORT is a viewport id of the surface matrix.
// The page boots with a throwaway server and every write stubbed, and the outbound endpoints answer 503.

const RECORD = process.env.SB_INVENTORY_RECORD === '1';
const VIEWPORT = process.env.SB_INVENTORY_VIEWPORT ?? '1440x900';
const FIXTURE_PATH = process.env.SB_INVENTORY_FIXTURE ?? fileURLToPath(new URL('../fixtures/settings-inventory.json', import.meta.url));
const PARTS = process.env.SB_INVENTORY_PARTS;
const EXTENSIONS_ID = 'settings.customize.extensions';
const SUBPAGES_TEST = `${EXTENSIONS_ID}:subpages`;
const CONNECTIONS_ID = 'settings.backend.connections';
/** The select that picks the provider of a backend whose Connections page changes with it. */
const SOURCE_SELECTS = Object.freeze({ 'chat-completion': '#chat_completion_source', 'text-completion': '#textgen_type' });
/** Quick Image Gen has no round trip: its controls generate and save images, and the rest of the extensions do round-trip. */
const REACH_ONLY_EXTENSIONS = new Set(['qig-settings']);
/** States that open on top of a page and are checked as sections of their own; `expanded` and `detail-page` are the walk itself. */
const OWN_SECTION_STATES = surface => (surface.states ?? []).filter(state => !['expanded', 'detail-page'].includes(state.id));

const only = (process.env.SURFACE_ID ?? '').split(',').map(id => id.trim()).filter(Boolean);
const surfaces = surfacesByFamily('settings').filter(surface => !only.length || only.includes(surface.id));

/** The tests of a run: one per surface and backend, and one for the extensions' subpages. */
const plan = surfaces.flatMap(surface => [
    ...backendsOf(surface).map(backend => ({ id: backend ? `${surface.id}@${backend}` : surface.id, surface, backend })),
    ...(surface.id === EXTENSIONS_ID ? [{ id: SUBPAGES_TEST, surface, subpages: true }] : []),
]);
const everySurface = only.length === 0;

let fixture = null;
let fixtureProblem = null;
if (!RECORD) {
    try {
        fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
        fixtureProblem = validateInventory(fixture);
    } catch (error) {
        fixtureProblem = [`The fixture ${FIXTURE_PATH} could not be read: ${error.message}`];
    }
}

test.use(variantContextOptions({ viewport: VIEWPORT }));

/** Runs `work` while this process holds the lock directory of the parts (mkdir fails when it exists, in every process). */
async function lockedBy(directory, work) {
    const lock = path.join(directory, '.lock');
    const deadline = Date.now() + 30_000;
    for (;;) {
        try {
            mkdirSync(lock);
            break;
        } catch (error) {
            if (error.code !== 'EEXIST' || Date.now() > deadline) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
    try {
        return work();
    } finally {
        rmdirSync(lock);
    }
}

const partFile = id => `${id.replace(/[^A-Za-z0-9.@-]+/g, '_')}.json`;

/** Writes a test's part and, when it is the one that completes the set, the fixture and the findings. */
async function writePart(id, part) {
    if (!PARTS) {
        throw new Error('A recording needs SB_INVENTORY_PARTS: an empty directory for the parts.');
    }
    mkdirSync(PARTS, { recursive: true });
    await lockedBy(PARTS, () => {
        writeFileSync(path.join(PARTS, partFile(id)), JSON.stringify(part));
        const parts = Object.fromEntries(readdirSync(PARTS).filter(name => name.endsWith('.json') && name !== 'findings.json')
            .map(name => [name.slice(0, -'.json'.length), JSON.parse(readFileSync(path.join(PARTS, name), 'utf8'))]));
        const have = Object.fromEntries(Object.entries(parts).map(([, value]) => [value.id, value]));
        const { complete } = checkParts(have, plan.map(entry => entry.id));
        writeFileSync(path.join(PARTS, 'findings.json'), JSON.stringify(Object.values(have).flatMap(value => value.findings), null, 1));
        if (!complete || !everySurface) {
            return;
        }
        const commit = (() => {
            try {
                return execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: path.dirname(FIXTURE_PATH), encoding: 'utf8' }).trim();
            } catch {
                return 'unknown';
            }
        })();
        const built = buildFixture(have, { commit, viewport: VIEWPORT, date: new Date().toISOString().slice(0, 10) });
        const problems = validateInventory(built);
        mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
        writeFileSync(`${FIXTURE_PATH}.tmp`, serializeInventory(built));
        renameSync(`${FIXTURE_PATH}.tmp`, FIXTURE_PATH);
        if (problems.length) {
            writeFileSync(path.join(PARTS, 'fixture-problems.json'), JSON.stringify(problems, null, 1));
        }
    });
}

if (!RECORD) {
    test('the fixture is valid and covers every surface', () => {
        expect(fixtureProblem, 'problems of the fixture').toEqual([]);
        expect(validateAccepted(ACCEPTED_DIFFERENCES, fixture), 'problems of the accepted differences').toEqual([]);
        const missing = plan.filter(entry => !entry.subpages)
            .flatMap(entry => [sectionKey(entry.surface.id, { backend: entry.backend }), ...(entry.backend === backendsOf(entry.surface)[0] ? OWN_SECTION_STATES(entry.surface).map(state => sectionKey(entry.surface.id, { state: state.id })) : [])])
            .filter(key => !(key in fixture.sections));
        expect(missing, 'sections of the registry that the fixture has not recorded').toEqual([]);
    });
}

for (const entry of plan) {
    test(`${RECORD ? 'record' : 'inventory'} ${entry.id}`, async ({ page, baseURL }) => {
        test.setTimeout(1_200_000);
        expect(RECORD ? [] : fixtureProblem, 'problems of the fixture').toEqual([]);
        const { surface, backend } = entry;
        const recorder = await bootInventoryPage(page, baseURL, { needs: surface.needs, viewport: VIEWPORT, mode: RECORD ? 'record' : 'check' });
        const sections = {};
        const findings = [];
        const failures = [];

        /** Runs one section: records it, or checks it against the fixture. */
        const run = async ({ key, root, skip, roundTrip = true, onlyShown = () => true }) => {
            if (RECORD) {
                const result = await recordSection(page, recorder, { key, root, skip, roundTrip, only: onlyShown });
                sections[key] = result.section;
                findings.push(...result.findings);
            } else {
                const section = fixture.sections[key];
                if (!section) {
                    failures.push(`${key}: the fixture has no section for it.`);
                    return;
                }
                failures.push(...await checkSection(page, recorder, { key, root, section, fixture, only: onlyShown }));
            }
            await settleRequests(recorder);
        };

        /**
         * Every provider that the page's own select offers, one after the other: the controls that only that provider shows are in
         * a section of their own, and are round-tripped there. A provider that is a backend of its own has sections of its own.
         */
        const runSources = async ({ root, baseKey, selector, backend }) => {
            const { api, source: standard } = BACKENDS[backend];
            const baseControls = (RECORD ? sections[baseKey] : fixture.sections[baseKey]).controls;
            const baseShown = new Set(baseControls.filter(control => control.where !== 'hidden').map(control => control.identity));
            const covered = new Set(Object.values(BACKENDS).filter(other => other.api === api).map(other => other.source));
            const offered = await sourcesOf(page, selector);
            if (!RECORD) {
                for (const known of Object.keys(fixture.sections).filter(name => name.startsWith(`${CONNECTIONS_ID}@${backend}:`))) {
                    if (!offered.includes(known.slice(`${CONNECTIONS_ID}@${backend}:`.length))) {
                        failures.push(`${known}: the provider is no longer offered by ${selector}.`);
                    }
                }
            }
            for (const source of offered.filter(value => !covered.has(value) && value !== standard)) {
                const key = sectionKey(CONNECTIONS_ID, { backend, source });
                if (!RECORD && fixture.sections[key]?.skipped) {
                    continue;
                }
                const selected = await selectSource(page, selector, source, root);
                if (!selected.ok) {
                    if (RECORD) {
                        sections[key] = { root, skipped: selected.reason };
                        findings.push(`${key}: not recorded; ${selected.reason}.`);
                    } else {
                        failures.push(`${key}: ${selected.reason}.`);
                    }
                    continue;
                }
                await run({ key, root, skip: [], onlyShown: item => item.shown && !baseShown.has(item.identity) });
            }
        };

        if (entry.subpages) {
            await openSection(page, { surface, viewport: VIEWPORT });
            const rows = await listExtensionRows(page);
            const recordedRows = RECORD ? rows.map(row => row.container) : Object.keys(fixture.sections).filter(key => key.startsWith('extension:')).map(key => key.slice('extension:'.length));
            if (!RECORD) {
                for (const row of rows.filter(candidate => !recordedRows.includes(candidate.container))) {
                    failures.push(`${EXTENSIONS_ID}: new extension row ${row.container} ("${row.title}") is not in the fixture.`);
                }
            }
            for (const container of recordedRows) {
                if (!rows.some(row => row.container === container)) {
                    failures.push(`${EXTENSIONS_ID}: the row of extension ${container} is missing from the list.`);
                    continue;
                }
                await openExtensionSubpage(page, container);
                await run({ key: `extension:${container}`, root: EXTENSION_DETAIL, skip: skipSelectorsFor(`extension:${container}`), roundTrip: !REACH_ONLY_EXTENSIONS.has(container) });
                await closeExtensionSubpage(page);
            }
        } else {
            const targets = [
                { key: sectionKey(surface.id, { backend }), stateId: undefined },
                ...(backend === backendsOf(surface)[0] ? OWN_SECTION_STATES(surface).map(state => ({ key: sectionKey(surface.id, { state: state.id }), stateId: state.id })) : []),
            ];
            for (const { key, stateId } of targets) {
                const root = await openSection(page, { surface, backend, stateId, viewport: VIEWPORT });
                await run({ key, root, skip: skipSelectorsFor(surface.id, stateId) });
                if (surface.id === CONNECTIONS_ID && SOURCE_SELECTS[backend] && stateId === undefined) {
                    await runSources({ root, baseKey: key, selector: SOURCE_SELECTS[backend], backend });
                }
            }
        }

        if (RECORD) {
            await writePart(entry.id, { id: entry.id, sections, findings });
            test.info().annotations.push({ type: 'findings', description: `${findings.length}` });
            return;
        }
        expect(failures, `${entry.id}: the page no longer matches the settings inventory`).toEqual([]);
    });
}

