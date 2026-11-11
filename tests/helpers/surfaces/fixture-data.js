/**
 * Loads the need modules of `needs/` and works with them: the data of each (`FIXTURES`), the order they seed in, and
 * the settings-side seeding. Plain data and functions with no Playwright import, so the registry loads in Jest.
 * `fixtures.js` does the server side. See `index.js` for the shape of a need module.
 */

import { NEED_ID_PATTERN, NEEDS } from './schema.js';

const MODULE_KEYS = new Set(['requires', 'exists', 'seed', 'settings']);

/**
 * Imports the module of each need, one at a time: a module that fails to load is recorded and left out, so one
 * half-written need does not stop the others.
 * @param {readonly string[]} names
 * @param {(name: string) => Promise<any>} importModule
 */
export async function loadNeedModules(names, importModule) {
    const modules = {};
    const fixtures = {};
    const problems = [];
    for (const name of names) {
        try {
            const loaded = await importModule(name);
            modules[name] = loaded.default;
            fixtures[name] = loaded.fixture;
        } catch (error) {
            problems.push(`needs/${name}.js could not be loaded: ${error?.message ?? error}`);
        }
    }
    return { modules, fixtures, problems };
}

const loaded = await loadNeedModules(NEEDS, name => import(`./needs/${name}.js`));

/** The default export of each need module that loaded, by need id. */
export const NEED_MODULES = Object.freeze(loaded.modules);

/** The `fixture` data of each need module that loaded, by need id. */
export const FIXTURES = Object.freeze(loaded.fixtures);

/** One message per need module that failed to load. */
export const NEED_LOAD_PROBLEMS = Object.freeze(loaded.problems);

/**
 * Checks the shape of need modules: a name that works as an id, a `fixture` object, only the known keys, and `requires`
 * naming needs that exist without a cycle. A module that seeds must also say whether its data exists, because that is
 * what keeps a second seeding from creating anything.
 * @param {Record<string, any>} [modules]
 * @param {Record<string, any>} [fixtures]
 * @returns {string[]}
 */
export function validateNeedModules(modules = NEED_MODULES, fixtures = FIXTURES) {
    const problems = [];
    for (const [id, module] of Object.entries(modules)) {
        const problem = message => problems.push(`needs/${id}.js: ${message}`);
        if (!NEED_ID_PATTERN.test(id)) {
            problem('the file name must be lowercase words joined by dashes.');
        }
        if (!module || typeof module !== 'object') {
            problem('must export a default object.');
            continue;
        }
        if (!fixtures[id] || typeof fixtures[id] !== 'object') {
            problem('must export `fixture`, the data that surfaces read.');
        }
        for (const key of Object.keys(module)) {
            if (!MODULE_KEYS.has(key)) {
                problem(`has an unknown field "${key}".`);
            }
        }
        for (const key of ['exists', 'seed', 'settings']) {
            if (module[key] !== undefined && typeof module[key] !== 'function') {
                problem(`${key} must be a function.`);
            }
        }
        if (typeof module.seed === 'function' && typeof module.exists !== 'function') {
            problem('seed needs an exists function, so that seeding twice creates nothing.');
        }
        if (module.requires !== undefined && !(Array.isArray(module.requires) && module.requires.every(name => name in modules))) {
            problem(`requires must list needs that exist (${Object.keys(modules).join(', ')}).`);
        }
    }
    for (const id of Object.keys(modules)) {
        try {
            needClosure([id], modules);
        } catch (error) {
            problems.push(`needs/${id}.js: ${error.message}`);
        }
    }
    return problems;
}

/**
 * The needs to seed for `needs`, each after the needs it requires, without repeats.
 * @param {readonly string[]} needs
 * @param {Record<string, any>} [modules]
 * @returns {string[]}
 */
export function needClosure(needs, modules = NEED_MODULES) {
    const order = [];
    const visit = (id, path) => {
        if (order.includes(id)) {
            return;
        }
        if (path.includes(id)) {
            throw new Error(`needs require each other in a cycle: ${[...path, id].join(' > ')}.`);
        }
        if (!modules[id]) {
            const reason = NEED_LOAD_PROBLEMS.find(message => message.startsWith(`needs/${id}.js`));
            throw new Error(`need "${id}" is not available${reason ? `: ${reason}` : '.'}`);
        }
        for (const required of modules[id].requires ?? []) {
            visit(required, [...path, id]);
        }
        order.push(id);
    };
    for (const id of needs) {
        visit(id, []);
    }
    return order;
}

/**
 * Lets every need in `needs` (and what it requires) edit the parsed `settings` of a `/api/settings/get` answer, in place.
 * @param {Record<string, any>} settings
 * @param {readonly string[]} needs
 * @returns {Record<string, any>} The same object.
 */
export function applySettingsFixtures(settings, needs) {
    settings.power_user ??= {};
    for (const id of needClosure(needs)) {
        NEED_MODULES[id].settings?.(settings);
    }
    return settings;
}
