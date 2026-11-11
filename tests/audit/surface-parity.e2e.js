import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { variantContextOptions, viewportsFor } from '../helpers/surface-matrix.js';
import { bootSurfaceApp, openSurface, readySelectors } from '../helpers/surfaces/boot.js';
import { backendsOf, loadProblemsFor, selectSurfaces, validateSurfaces } from '../helpers/surfaces/index.js';
import { readAllowlist } from '../helpers/parity/allowlist.js';
import { buildRows, checkSurface, rulesFor } from '../helpers/parity/compare.js';
import { measureSurface, skeletonOf } from '../helpers/parity/measure.js';
import { PARITY_FAMILIES, PARITY_VIEWPORTS, RULES } from '../helpers/parity/index.js';
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect, playwright/no-skipped-test, playwright/expect-expect -- Record mode and the optional outputs are chosen by the environment, and a rules file can skip a surface by id. */

// The census and the parity check of the surface families. Every surface of a family that has rules (`helpers/parity/`) is
// opened at 1440x900 and 390x844, where it applies, and each part of it that the family's rules name is measured. A member
// is compared with the family's canonical value for each property (exact within 0.5px; within 1px for the sizes of an element);
// every shown instance of a part is measured. A difference passes only when `fixtures/parity-allowlist.json` lists that value of
// that cell, and an entry whose difference no longer occurs fails ("remove this entry").
// SURFACE_FAMILY=<family>[,<family>] and SURFACE_ID=<id>[,<id>] limit the run, as in the other audit specs.
// SB_CENSUS_DIR=<directory> writes the measurements of each surface to <directory>/raw; `node scripts/update-parity-allowlist.js
// --census <directory>` turns them into the census files and, with --write, into the allow-list.
// SB_PARITY_RECORD=1 measures without asserting, which is how the allow-list is generated.
// SB_PARITY_ALLOWLIST=<file> reads that allow-list instead of the fixture.
// SB_PARITY_INJECT_CSS=<css> adds a style to the page before it is measured, to prove that the check fails on a difference.
// SB_PARITY_DUMP=<directory> writes an outline of each opened surface (classes and sizes), for writing the selectors of a rules file.
const RECORD = process.env.SB_PARITY_RECORD === '1';
const CENSUS_DIR = process.env.SB_CENSUS_DIR;
const INJECT_CSS = process.env.SB_PARITY_INJECT_CSS;
const DUMP_DIR = process.env.SB_PARITY_DUMP;

const selection = selectSurfaces();
const entries = RECORD ? [] : readAllowlist().entries;

const seenIds = new Set();
const runnable = [];
const skipped = [];
const withoutRules = [];
for (const surface of selection.surfaces) {
    if (!PARITY_FAMILIES.includes(surface.family)) {
        withoutRules.push(surface.id);
        continue;
    }
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

test('the registry is valid', () => {
    const problems = selection.active ? [...loadProblemsFor(selection.families), ...skipped] : validateSurfaces();
    expect(problems, 'registry problems (a surface with a problem is not run)').toEqual([]);
});

if (selection.problem) {
    test('the surface filter selects surfaces', () => {
        expect(selection.problem, 'the surface filter').toBeNull();
    });
} else if (runnable.length === 0) {
    test('the surface filter selects a family that has parity rules', () => {
        expect(withoutRules, `the selected surfaces have no parity rules (${PARITY_FAMILIES.join(', ')} do)`).toEqual([]);
        expect(runnable.length, 'surfaces to measure').toBeGreaterThan(0);
    });
}

function writeJson(file, data) {
    mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true });
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

for (const viewportId of PARITY_VIEWPORTS) {
    test.describe(`surfaces at ${viewportId}`, () => {
        test.use(variantContextOptions({ viewport: viewportId }));

        for (const surface of runnable.filter(candidate => viewportsFor(candidate).includes(viewportId))) {
            const familyRules = RULES[surface.family];
            const rules = rulesFor(familyRules, surface.id);
            const skipReason = familyRules.skip?.[surface.id];
            if (skipReason) {
                test.skip(`${surface.id} (not measured: ${skipReason})`, () => {});
                continue;
            }
            test(`${surface.id}`, async ({ page, baseURL }) => {
                const rawFile = CENSUS_DIR ? `${CENSUS_DIR}/raw/${surface.id}@${viewportId}.json` : null;
                if (rawFile) {
                    rmSync(rawFile, { force: true });
                }
                await bootSurfaceApp(page, baseURL, { variant: { viewport: viewportId }, needs: surface.needs });
                const root = await openSurface(page, surface, { backend: backendsOf(surface)[0], viewport: viewportId });
                if (INJECT_CSS) {
                    await page.addStyleTag({ content: INJECT_CSS });
                    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                }
                if (DUMP_DIR) {
                    mkdirSync(DUMP_DIR, { recursive: true });
                    writeFileSync(`${DUMP_DIR}/${surface.id}@${viewportId}.txt`, `${await skeletonOf(page, root)}\n`);
                }
                const ready = readySelectors(surface, { backend: backendsOf(surface)[0], viewport: viewportId });
                for (const selector of ready) {
                    await expect(page.locator(selector).first(), `${surface.id}: ${selector} is shown`).toBeVisible();
                }
                const measured = await measureSurface(page, root, rules, ready);
                const { rows, parts } = buildRows({ surface: surface.id, viewport: viewportId, rules, measured });
                if (rawFile) {
                    writeJson(rawFile, {
                        family: surface.family,
                        surface: surface.id,
                        viewport: viewportId,
                        group: familyRules.groupOf?.(surface) ?? '',
                        pointer: measured.pointer,
                        parts,
                        rows,
                    });
                }
                if (!RECORD) {
                    const { failures } = checkSurface({ surface: surface.id, viewport: viewportId, rows, entries });
                    expect(failures, `${surface.id} at ${viewportId}: differences from the canonical values of the ${surface.family} family`).toEqual([]);
                }
            });
        }
    });
}
