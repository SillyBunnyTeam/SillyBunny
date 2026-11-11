import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { variantContextOptions, viewportById, viewportsFor } from '../helpers/surface-matrix.js';
import { visibleContent } from '../helpers/surfaces/content.js';
import { bootSurfaceApp, openSurface, readySelectors } from '../helpers/surfaces/boot.js';
import { backendsOf, loadProblemsFor, selectSurfaces, validateSurfaces } from '../helpers/surfaces/index.js';
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- A surface lists its own backends and states, and a close step is optional. */

// Proves that every surface of the registry opens, with each of its backends and states, at the desktop and the phone
// reference size: the root is visible, has a box, lies in the viewport and shows a control, a sized image, video or canvas, or text, and every element
// that the surface's (or state's) `ready` names is visible and in the viewport. A failure names the surface id, then the
// backend or the state. An entry that fails `validateSurfaces()` gets no test of its own and is listed by the first test.
// SURFACE_FAMILY=<family>[,<family>] and SURFACE_ID=<id>[,<id>] limit the run to those families and surfaces; a filter that
// selects nothing fails the run. SURFACE_DENSITY=compact and SURFACE_TEXT_SCALE=<number> run every surface in that cell of
// the variant matrix instead of the default one (the boot asserts that the app took the setting). SURFACE_SMOKE_SHOTS=<directory> also saves a screenshot of every opened surface and state there.
const SMOKE_VIEWPORTS = ['1440x900', '390x844'];
const SHOT_DIRECTORY = process.env.SURFACE_SMOKE_SHOTS;
const CELL = {
    ...(process.env.SURFACE_DENSITY && { density: process.env.SURFACE_DENSITY }),
    ...(process.env.SURFACE_TEXT_SCALE && { textScale: Number(process.env.SURFACE_TEXT_SCALE) }),
};

const selection = selectSurfaces();

// An entry is run only when it is valid on its own and its id is not taken by an earlier entry, so one malformed entry
// of one family does not stop the others from running.
const seenIds = new Set();
const runnable = [];
const skipped = [];
for (const surface of selection.surfaces) {
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
        mkdirSync(SHOT_DIRECTORY, { recursive: true });
        const name = `${page.viewportSize().width}x${page.viewportSize().height}-${label}`.replace(/[^a-z0-9.-]+/gi, '_');
        await page.screenshot({ path: `${SHOT_DIRECTORY}/${name}.png` });
    }
}

for (const viewportId of SMOKE_VIEWPORTS) {
    test.describe(`surfaces at ${viewportId}`, () => {
        test.use(variantContextOptions({ ...CELL, viewport: viewportId }));

        for (const surface of runnable.filter(candidate => viewportsFor(candidate).includes(viewportId))) {
            test(`${surface.id}`, async ({ page, baseURL }) => {
                const pageErrors = [];
                page.on('pageerror', error => pageErrors.push(error.message));
                await bootSurfaceApp(page, baseURL, { variant: { ...CELL, viewport: viewportId }, needs: surface.needs });
                const pointer = await page.evaluate(() => (matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine'));
                expect(pointer, `${surface.id}: pointer type of ${viewportId}`).toBe(viewportById(viewportId).pointer);

                const failures = [];
                const attempt = async (label, run) => {
                    try {
                        await run();
                    } catch (error) {
                        const detail = String(error.message).split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join(' | ');
                        failures.push(detail.startsWith(label) ? detail : `${label}: ${detail}`);
                    }
                };

                for (const backend of backendsOf(surface)) {
                    const label = backend ? `${surface.id} [${backend}]` : surface.id;
                    await attempt(label, async () => {
                        const options = { backend, viewport: viewportId };
                        await expectOpen(page, label, await openSurface(page, surface, options), readySelectors(surface, options));
                    });
                    if (surface.close) {
                        await attempt(`${label} close`, async () => {
                            await surface.close(page);
                            await expect(page.locator(surface.root).first(), `${label}: ${surface.root} is gone after close`).toBeHidden();
                        });
                    }
                }
                for (const state of surface.states ?? []) {
                    const label = `${surface.id} state ${state.id}`;
                    await attempt(label, async () => {
                        const options = { stateId: state.id, backend: backendsOf(surface)[0], viewport: viewportId };
                        await expectOpen(page, label, await openSurface(page, surface, options), readySelectors(surface, options));
                    });
                }
                if (pageErrors.length) {
                    test.info().annotations.push({ type: 'page errors', description: pageErrors.join('\n') });
                }
                expect(failures, `surfaces that did not open at ${viewportId}`).toEqual([]);
            });
        }
    });
}
