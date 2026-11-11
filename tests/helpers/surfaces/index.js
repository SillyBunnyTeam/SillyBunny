/**
 * The surface registry: every surface that a user can open, with its family, its owner class and the steps that open it.
 * The audit tools iterate over `SURFACES`. `schema.js` holds the vocabulary (families, owner classes, backends) and
 * `settings.js` is a family file.
 *
 * Family files. The loader imports `<family>.js` from this directory for each name in `FAMILIES` that has a file, one at a
 * time. The file exports `surfaces`, an array of `Surface` entries (below) whose `family` is the file's family. A file
 * that fails to import, does not export an array, or holds an entry that is not an object is recorded in `LOAD_PROBLEMS`
 * and leaves the other files alone; an entry of another family is recorded and still listed. A family file imports
 * nothing from Playwright, because the registry also loads under Jest; `steps.js` has the open and wait steps that
 * families share. `validateSurfaces()` checks the entries, and a smoke run registers a test only for an entry that passes.
 *
 * Need modules. The loader (`fixture-data.js`) imports every file of `needs/`; the file name is the need id and `NEEDS` is
 * the list of files. A module exports `fixture`, a plain object with the data that surfaces read, and a default object
 * with these optional parts:
 *   requires  the ids of needs that are seeded first
 *   exists    async ({ post, baseURL }) => boolean: the data is on the server already
 *   seed      async ({ post, baseURL }) => string: creates the data through the app's API and returns a description of
 *             what it made; `post(path, requestOptions, { allow: [status] })` sends a request with the CSRF token and
 *             throws on any other failure
 *   settings  (settings) => void: edits the parsed `/api/settings/get` answer of a boot in place; nothing is saved
 * A module that has `seed` has `exists`, so that seeding twice creates nothing. A need that holds data only in the
 * account settings has `settings` and no `seed`. Seeding writes only to a server that `seed-guard.js` accepts.
 *
 * @typedef {object} SurfaceState An overlay or expander of a surface, opened on top of the surface as found.
 * @property {string} id Lowercase words joined by dashes. Unique within the surface.
 * @property {(page: import('@playwright/test').Page, ctx: SurfaceContext) => Promise<void>} open Runs with the surface already open.
 * @property {string} [root] The root of the state when it is not the root of the surface.
 * @property {Ready} [ready] What must be shown once the state is open. A state with neither `ready` nor its own `root` is the surface
 * with more shown, so the surface's `ready` applies to it.
 *
 * @typedef {string | string[] | ((ctx: SurfaceContext) => string | string[])} Ready Selectors for `page.locator()`, or a
 * function of the run's context that returns them. Each selected element must be visible and inside the viewport once
 * the surface or state is open. A surface whose root can be open and empty (a lazily built panel, a block that depends on
 * the backend) names an element that exists only when the content is there.
 *
 * @typedef {object} SurfaceContext
 * @property {string} [backend] A key of `BACKENDS`, for a surface that lists `backends`.
 * @property {string} [viewport] The viewport id of the run.
 *
 * @typedef {object} Surface
 * @property {string} id Stable and dotted, usable in file names: `settings.backend.connections`.
 * @property {string} family One of `FAMILIES`.
 * @property {'A' | 'B' | 'C'} owner The owner class (see `OWNER_CLASSES`).
 * @property {string} title A developer-facing name.
 * @property {string} root A selector for the root element of the open surface. Tools clip, measure and scan inside it.
 * @property {(page: import('@playwright/test').Page, ctx: SurfaceContext) => Promise<void>} open Opens the surface from a booted app and waits until `root` has settled.
 * @property {(page: import('@playwright/test').Page) => Promise<void>} [close] Leaves the surface, where a reload is not enough.
 * @property {Ready} [ready] The elements that must be shown once the surface is open; see `Ready`.
 * @property {SurfaceState[]} [states]
 * @property {string[]} [masks] Selectors of regions that differ between runs.
 * @property {string[]} [viewports] Viewport ids of `surface-matrix.js`; all that apply when absent.
 * @property {string[]} needs Fixture data of `NEEDS` that the surface requires; `[]` for none.
 * @property {string[]} sources Main source files, relative to the repository root.
 * @property {'single' | 'list'} [editorType] Required for the `editor` family and not allowed elsewhere.
 * @property {string[]} [backends] Keys of `BACKENDS`: the surface differs between backends, and `open` reads `ctx.backend`.
 * @property {boolean} [primaryFlow] The surface is part of a primary flow, so the small-phone viewports apply to it.
 * @property {boolean} [overlay] The surface is an overlay (a window, sheet or menu) although its family is not an overlay family, so the overlay viewports apply to it as well.
 * @property {boolean} [upstreamMarkup] An A surface whose markup is upstream's, restyled by SillyBunny.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VIEWPORT_IDS } from '../surface-matrix.js';
import { NEED_LOAD_PROBLEMS, validateNeedModules } from './fixture-data.js';
import { BACKENDS, DEFAULT_BACKEND, EDITOR_TYPES, FAMILIES, ID_PATTERN, NEEDS, OWNER_CLASSES } from './schema.js';

export { BACKENDS, DEFAULT_BACKEND, EDITOR_TYPES, FAMILIES, NEEDS, OWNER_CLASSES };

const ALLOWED_KEYS = new Set(['id', 'family', 'owner', 'title', 'root', 'open', 'close', 'states', 'masks', 'viewports', 'needs', 'sources', 'editorType', 'backends', 'primaryFlow', 'overlay', 'upstreamMarkup', 'ready']);
const STATE_KEYS = new Set(['id', 'open', 'root', 'ready']);
const STATE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Imports the file of each family, one at a time. A file that fails to import is recorded as a problem that names the
 * file and the error, and the other families still load, so one half-written family file does not stop anyone else's run.
 * @param {readonly string[]} families
 * @param {(family: string) => boolean} exists Whether `<family>.js` exists.
 * @param {(family: string) => Promise<{ surfaces?: unknown }>} importFamily
 * @returns {Promise<{ surfaces: any[], problems: { family: string, message: string }[] }>}
 */
export async function loadFamilies(families, exists, importFamily) {
    const surfaces = [];
    const problems = [];
    for (const family of families) {
        if (!exists(family)) {
            continue;
        }
        let module;
        try {
            module = await importFamily(family);
        } catch (error) {
            problems.push({ family, message: `${family}.js could not be loaded: ${error?.message ?? error}` });
            continue;
        }
        if (!Array.isArray(module.surfaces)) {
            problems.push({ family, message: `${family}.js must export a \`surfaces\` array.` });
            continue;
        }
        for (const [index, surface] of module.surfaces.entries()) {
            if (!surface || typeof surface !== 'object') {
                problems.push({ family, message: `${family}.js entry #${index} is not an object, so it is left out.` });
                continue;
            }
            if (surface.family !== family) {
                problems.push({ family, message: `${surface.id ?? '(no id)'} is in ${family}.js but its family is "${surface.family}".` });
            }
            surfaces.push(surface);
        }
    }
    return { surfaces, problems };
}

const registry = await loadFamilies(
    FAMILIES,
    family => fs.existsSync(fileURLToPath(new URL(`./${family}.js`, import.meta.url))),
    family => import(`./${family}.js`),
);

/** One entry per family file that failed to load or registered a surface of another family. */
export const LOAD_PROBLEMS = Object.freeze(registry.problems);

/** Every registered surface, family by family in the order of `FAMILIES`. */
export const SURFACES = Object.freeze(registry.surfaces);

/**
 * The load problems of the given families.
 * @param {readonly string[]} families
 * @param {readonly { family: string, message: string }[]} [problems] The registry's by default.
 * @returns {string[]}
 */
export function loadProblemsFor(families, problems = LOAD_PROBLEMS) {
    return problems.filter(problem => families.includes(problem.family)).map(problem => problem.message);
}

const isText = value => typeof value === 'string' && value.trim() !== '';
const isTextList = value => Array.isArray(value) && value.every(isText);
const isReady = value => typeof value === 'function' || isText(value) || (isTextList(value) && value.length > 0);

/**
 * Checks a list of surfaces: unique and well-formed ids, known family and owner class, the required fields, and no
 * field that the schema does not know (which catches a misspelt optional one).
 * @param {readonly Surface[]} [surfaces] The registry by default.
 * @returns {string[]} One message per problem, each naming the surface; empty when the list is valid.
 */
export function validateSurfaces(surfaces = SURFACES) {
    const problems = surfaces === SURFACES
        ? [...LOAD_PROBLEMS.map(problem => problem.message), ...NEED_LOAD_PROBLEMS, ...validateNeedModules()]
        : [];
    const seen = new Set();
    for (const [index, surface] of surfaces.entries()) {
        const name = isText(surface?.id) ? surface.id : `entry #${index}`;
        const problem = message => problems.push(`${name}: ${message}`);
        if (!surface || typeof surface !== 'object') {
            problem('is not an object.');
            continue;
        }
        if (!isText(surface.id) || !ID_PATTERN.test(surface.id)) {
            problem('id must be dotted lowercase words, such as "settings.backend.connections".');
        } else if (seen.has(surface.id)) {
            problem('id is used by another surface.');
        }
        seen.add(surface.id);
        for (const key of Object.keys(surface)) {
            if (!ALLOWED_KEYS.has(key)) {
                problem(`has an unknown field "${key}".`);
            }
        }
        if (!FAMILIES.includes(surface.family)) {
            problem(`family "${surface.family}" is not one of ${FAMILIES.join(', ')}.`);
        }
        if (!OWNER_CLASSES.includes(surface.owner)) {
            problem(`owner "${surface.owner}" is not one of ${OWNER_CLASSES.join(', ')}.`);
        }
        if (!isText(surface.title)) {
            problem('title is required.');
        }
        if (!isText(surface.root)) {
            problem('root must be a selector.');
        }
        if (typeof surface.open !== 'function') {
            problem('open must be a function.');
        }
        if (surface.close !== undefined && typeof surface.close !== 'function') {
            problem('close must be a function.');
        }
        if (!Array.isArray(surface.needs) || !surface.needs.every(need => NEEDS.includes(need))) {
            problem(`needs must be a list of ${NEEDS.join(', ')} (an empty list for none).`);
        }
        if (!isTextList(surface.sources) || surface.sources.length === 0) {
            problem('sources must list at least one source file.');
        }
        if (surface.family === 'editor') {
            if (!EDITOR_TYPES.includes(surface.editorType)) {
                problem(`an editor needs editorType, one of ${EDITOR_TYPES.join(', ')}.`);
            }
        } else if (surface.editorType !== undefined) {
            problem('editorType is only for the editor family.');
        }
        if (surface.masks !== undefined && !isTextList(surface.masks)) {
            problem('masks must be a list of selectors.');
        }
        if (surface.viewports !== undefined && (!isTextList(surface.viewports) || surface.viewports.length === 0 || !surface.viewports.every(id => VIEWPORT_IDS.includes(id)))) {
            problem(`viewports must be a non-empty list of ${VIEWPORT_IDS.join(', ')}.`);
        }
        if (surface.backends !== undefined && (!isTextList(surface.backends) || surface.backends.length === 0 || !surface.backends.every(id => id in BACKENDS))) {
            problem(`backends must be a non-empty list of ${Object.keys(BACKENDS).join(', ')}.`);
        }
        if (surface.primaryFlow !== undefined && typeof surface.primaryFlow !== 'boolean') {
            problem('primaryFlow must be true or false.');
        }
        if (surface.overlay !== undefined && typeof surface.overlay !== 'boolean') {
            problem('overlay must be true or false.');
        }
        if (surface.upstreamMarkup !== undefined && typeof surface.upstreamMarkup !== 'boolean') {
            problem('upstreamMarkup must be true or false.');
        }
        if (surface.ready !== undefined && !isReady(surface.ready)) {
            problem('ready must be a selector, a non-empty list of selectors, or a function of the context.');
        }
        if (surface.states !== undefined) {
            if (!Array.isArray(surface.states)) {
                problem('states must be a list.');
                continue;
            }
            const stateIds = new Set();
            for (const state of surface.states) {
                const label = `state "${state?.id}"`;
                if (!isText(state?.id) || !STATE_ID_PATTERN.test(state.id)) {
                    problem(`${label} needs an id of lowercase words joined by dashes.`);
                } else if (stateIds.has(state.id)) {
                    problem(`${label} is used twice.`);
                }
                stateIds.add(state?.id);
                if (typeof state?.open !== 'function') {
                    problem(`${label} needs an open function.`);
                }
                if (state?.root !== undefined && !isText(state.root)) {
                    problem(`${label} root must be a selector.`);
                }
                if (state?.ready !== undefined && !isReady(state.ready)) {
                    problem(`${label} ready must be a selector, a non-empty list of selectors, or a function of the context.`);
                }
                for (const key of Object.keys(state ?? {})) {
                    if (!STATE_KEYS.has(key)) {
                        problem(`${label} has an unknown field "${key}".`);
                    }
                }
            }
        }
    }
    return problems;
}

/**
 * Checks the registry and throws with every problem listed.
 * @param {readonly Surface[]} [surfaces]
 */
export function assertValidSurfaces(surfaces = SURFACES) {
    const problems = validateSurfaces(surfaces);
    if (problems.length) {
        throw new Error(`The surface registry is invalid:\n${problems.map(problem => `  ${problem}`).join('\n')}`);
    }
}

/**
 * @param {string} id
 * @returns {Surface | undefined}
 */
export function surfaceById(id) {
    return SURFACES.find(surface => surface.id === id);
}

/**
 * @param {string} family One of `FAMILIES`.
 * @returns {Surface[]}
 */
export function surfacesByFamily(family) {
    if (!FAMILIES.includes(family)) {
        throw new Error(`Unknown family "${family}". Known: ${FAMILIES.join(', ')}.`);
    }
    return SURFACES.filter(surface => surface.family === family);
}

const listOf = value => String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);

/**
 * The surfaces that a run covers. `SURFACE_FAMILY` (family names) and `SURFACE_ID` (surface ids) take comma-separated
 * lists and combine: a surface must match each one that is set. Neither set means the whole registry. A filter that names
 * an unknown family or id, or that matches nothing, comes back with a `problem` that says why, including the load problem of
 * a requested family whose file failed to import, so a run never passes with zero tests.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ surfaces?: readonly Surface[], loadProblems?: readonly { family: string, message: string }[] }} [registryState] The registry's by default.
 * @returns {{ active: boolean, surfaces: Surface[], families: string[], problem: string | null }}
 */
export function selectSurfaces(env = process.env, { surfaces: registered = SURFACES, loadProblems = LOAD_PROBLEMS } = {}) {
    const families = listOf(env.SURFACE_FAMILY);
    const ids = listOf(env.SURFACE_ID);
    const active = families.length > 0 || ids.length > 0;
    const unknown = [
        ...families.filter(family => !FAMILIES.includes(family)).map(family => `SURFACE_FAMILY "${family}" is not one of ${FAMILIES.join(', ')}.`),
        ...ids.filter(id => !registered.some(surface => surface.id === id)).map(id => `SURFACE_ID "${id}" is not a registered surface.`),
    ];
    const surfaces = registered.filter(surface => (!families.length || families.includes(surface.family)) && (!ids.length || ids.includes(surface.id)));
    // A surface id starts with its family, so an id that is not registered may belong to a family that failed to load.
    const idFamilies = ids.filter(id => !registered.some(surface => surface.id === id)).map(id => id.split('.')[0]);
    const reasons = [...unknown, ...new Set([...loadProblemsFor(families, loadProblems), ...loadProblemsFor(idFamilies, loadProblems)])];
    if (surfaces.length === 0 && reasons.length === 0) {
        reasons.push(active ? 'No registered surface matches the filter.' : 'The registry has no surfaces.');
    }
    const problem = unknown.length || surfaces.length === 0
        ? `The surfaces to run cannot be chosen (SURFACE_FAMILY=${env.SURFACE_FAMILY ?? ''} SURFACE_ID=${env.SURFACE_ID ?? ''}). ${reasons.join(' ')}`
        : null;
    return { active, surfaces, families, problem };
}

/**
 * The backends to run a surface with: its own list, or `[undefined]` when the surface does not depend on the backend.
 * @param {Surface} surface
 * @returns {(string | undefined)[]}
 */
export function backendsOf(surface) {
    return surface.backends ?? [undefined];
}

/**
 * Source files of surfaces that do not exist in the repository.
 * @param {string} repositoryRoot
 * @param {readonly Surface[]} [surfaces]
 * @returns {string[]}
 */
export function findMissingSources(repositoryRoot, surfaces = SURFACES) {
    return surfaces.flatMap(surface => surface.sources
        .filter(source => !fs.existsSync(`${repositoryRoot}/${source}`))
        .map(source => `${surface.id}: ${source}`));
}
