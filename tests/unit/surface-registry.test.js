import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';
import {
    DEFAULT_VARIANT,
    EXTRA_AXES,
    EXTRA_AXIS_VIEWPORT_IDS,
    MATRIX_VIEWPORTS,
    VIEWPORT_IDS,
    applyVariant,
    resolveVariant,
    variantContextOptions,
    viewportById,
    viewportsFor,
} from '../helpers/surface-matrix.js';
import fs from 'node:fs';
import { assertSeedableServer, seedFailuresOf } from '../helpers/surfaces/seed-guard.js';
import {
    applySettingsFixtures,
    FIXTURES,
    loadNeedModules,
    NEED_LOAD_PROBLEMS,
    needClosure,
    validateNeedModules,
} from '../helpers/surfaces/fixture-data.js';
import {
    BACKENDS,
    DEFAULT_BACKEND,
    FAMILIES,
    NEEDS,
    SURFACES,
    backendsOf,
    findMissingSources,
    loadFamilies,
    loadProblemsFor,
    selectSurfaces,
    statesFor,
    surfaceById,
    surfacesByFamily,
    validateSurfaces,
} from '../helpers/surfaces/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const noop = async () => {};

/** A valid entry to break one field at a time. */
const entry = (overrides = {}) => ({
    id: 'dialog.example.one',
    family: 'dialog',
    owner: 'A',
    title: 'Example',
    root: '.example',
    open: noop,
    needs: [],
    sources: ['public/index.html'],
    ...overrides,
});

describe('surface registry validation', () => {
    test('the registered surfaces are valid, and their sources exist', () => {
        expect(validateSurfaces()).toEqual([]);
        expect(findMissingSources(repositoryRoot)).toEqual([]);
    });

    test('a valid entry passes', () => {
        expect(validateSurfaces([entry(), entry({ id: 'dialog.example.two', states: [{ id: 'menu-open', open: noop }], masks: ['.clock'], viewports: ['1440x900'], backends: ['novelai'] })])).toEqual([]);
    });

    test('ids must be unique', () => {
        expect(validateSurfaces([entry(), entry()])).toEqual(['dialog.example.one: id is used by another surface.']);
    });

    test.each(['Dialog.Example', 'dialog', 'dialog..one', 'dialog.example one', '', 'dialog.-one'])('id "%s" is refused', id => {
        expect(validateSurfaces([entry({ id })]).join('\n')).toMatch(/id must be dotted lowercase words/);
    });

    test('family and owner class must be known', () => {
        expect(validateSurfaces([entry({ family: 'popup' })])).toEqual([expect.stringContaining('family "popup" is not one of')]);
        expect(validateSurfaces([entry({ owner: 'D' })])).toEqual([expect.stringContaining('owner "D" is not one of A, B, C')]);
    });

    test.each([
        ['title', { title: '' }, 'title is required'],
        ['root', { root: undefined }, 'root must be a selector'],
        ['open', { open: 'click' }, 'open must be a function'],
        ['close', { close: 'back' }, 'close must be a function'],
        ['needs', { needs: undefined }, 'needs must be a list'],
        ['needs value', { needs: ['spaceship'] }, 'needs must be a list'],
        ['sources', { sources: [] }, 'sources must list at least one source file'],
        ['masks', { masks: [''] }, 'masks must be a list of selectors'],
        ['viewports', { viewports: ['100x100'] }, 'viewports must be a non-empty list'],
        ['backends', { backends: ['gopher'] }, 'backends must be a non-empty list'],
        ['primaryFlow', { primaryFlow: 'yes' }, 'primaryFlow must be true or false'],
        ['unknown field', { colour: 'red' }, 'has an unknown field "colour"'],
    ])('%s is checked', (_name, overrides, message) => {
        const problems = validateSurfaces([entry(overrides)]);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(message);
        expect(problems[0]).toMatch(/^dialog\.example\.one: /);
    });

    test('states need unique ids and an open function', () => {
        const problems = validateSurfaces([entry({ states: [{ id: 'a', open: noop }, { id: 'a', open: noop }, { id: 'Bad Id', open: noop }, { id: 'b' }] })]);
        expect(problems).toEqual([
            'dialog.example.one: state "a" is used twice.',
            'dialog.example.one: state "Bad Id" needs an id of lowercase words joined by dashes.',
            'dialog.example.one: state "b" needs an open function.',
        ]);
    });

    test('an editor needs a type, and no other family may have one', () => {
        expect(validateSurfaces([entry({ family: 'editor' })])).toEqual([expect.stringContaining('an editor needs editorType')]);
        expect(validateSurfaces([entry({ family: 'editor', editorType: 'single' })])).toEqual([]);
        expect(validateSurfaces([entry({ editorType: 'list' })])).toEqual([expect.stringContaining('editorType is only for the editor family')]);
    });
});

describe('surface registry lookups', () => {
    test('every family file registers surfaces of its own family, in order', () => {
        const order = SURFACES.map(surface => FAMILIES.indexOf(surface.family));
        expect(order).toEqual([...order].sort((first, second) => first - second));
        expect(SURFACES.every(surface => FAMILIES.includes(surface.family))).toBe(true);
    });

    test('lookup by id and by family', () => {
        const connections = surfaceById('settings.backend.connections');
        expect(connections).toBe(SURFACES.find(surface => surface.id === 'settings.backend.connections'));
        expect(surfaceById('nothing.here')).toBeUndefined();
        expect(surfacesByFamily('settings').length).toBeGreaterThanOrEqual(15);
        expect(() => surfacesByFamily('popup')).toThrow(/Unknown family "popup"/);
    });

    test('backends default to a single run without one', () => {
        expect(backendsOf(surfaceById('settings.backend.editor'))).toEqual([undefined]);
        expect(backendsOf(surfaceById('settings.backend.sampling'))).toEqual(Object.keys(BACKENDS));
        expect(backendsOf(surfaceById('settings.backend.connections'))).toEqual(Object.keys(BACKENDS));
        expect(backendsOf(surfaceById('settings.backend.presets'))).toEqual(['chat-completion', 'text-completion', 'novelai', 'horde']);
    });

    test('the settings family holds the 15 settings surfaces', () => {
        expect(surfacesByFamily('settings').map(surface => surface.id)).toEqual([
            'settings.backend.connections',
            'settings.backend.sampling',
            'settings.backend.presets',
            'settings.backend.editor',
            'settings.backend.formatting',
            'settings.backend.agents',
            'settings.customize.appearance',
            'settings.customize.extensions',
            'settings.customize.interface',
            'settings.customize.messages',
            'settings.customize.data-security',
            'settings.customize.logs',
            'settings.worldinfo.global',
            'settings.persona.global',
            'settings.characters.import',
        ]);
    });

    test('surfaces ask only for fixtures that exist', () => {
        const wanted = new Set(SURFACES.flatMap(surface => surface.needs));
        expect([...wanted].every(need => NEEDS.includes(need))).toBe(true);
        expect(Object.keys(FIXTURES).sort()).toEqual([...NEEDS].sort());
    });
});

describe('matrix data', () => {
    test('the twelve viewports of the test matrix', () => {
        expect(MATRIX_VIEWPORTS.map(viewport => `${viewport.id} ${viewport.pointer} ${viewport.appliesTo}`)).toEqual([
            '3440x1440 fine every',
            '1920x1080 fine every',
            '1440x900 fine every',
            '1024x600 fine every',
            '900x700 fine every',
            '768x1024 coarse every',
            '844x390 coarse every',
            '820x360 coarse top-bar-and-overlays',
            '390x844 coarse every',
            '360x640 coarse every',
            '360x294 coarse overlays-and-primary-flows',
            '320x568 coarse primary-flows',
        ]);
        expect(VIEWPORT_IDS).toHaveLength(12);
        expect(EXTRA_AXIS_VIEWPORT_IDS).toEqual(['1440x900', '390x844']);
        expect(EXTRA_AXES.map(axis => axis.id)).toEqual(['forced-colors', 'text-200', 'reduced-motion']);
    });

    test('the "applies to" restriction follows the family and the primary flow', () => {
        expect(viewportsFor({ family: 'list' })).toEqual(['3440x1440', '1920x1080', '1440x900', '1024x600', '900x700', '768x1024', '844x390', '390x844', '360x640']);
        expect(viewportsFor({ family: 'dialog' })).toContain('820x360');
        expect(viewportsFor({ family: 'dialog' })).toContain('360x294');
        expect(viewportsFor({ family: 'dialog' })).not.toContain('320x568');
        expect(viewportsFor({ family: 'header' })).toContain('820x360');
        expect(viewportsFor({ family: 'header' })).not.toContain('360x294');
        expect(viewportsFor({ family: 'list', primaryFlow: true })).toEqual(expect.arrayContaining(['360x294', '320x568']));
        expect(viewportsFor({ family: 'list', primaryFlow: true })).not.toContain('820x360');
        expect(viewportsFor({ family: 'dialog', viewports: ['390x844', '820x360', '320x568'] })).toEqual(['820x360', '390x844']);
    });

    test('an entry of another family that is an overlay gets the overlay viewports', () => {
        const small = ['820x360', '360x294'];
        expect(viewportsFor({ family: 'home' })).not.toEqual(expect.arrayContaining(small));
        expect(viewportsFor({ family: 'home', overlay: true })).toEqual(expect.arrayContaining(['820x360', '360x294']));
        expect(viewportsFor({ family: 'home', overlay: true })).not.toContain('320x568');
        expect(viewportsFor({ family: 'home', overlay: true, primaryFlow: true })).toContain('320x568');
        expect(viewportsFor({ family: 'home', overlay: false })).toEqual(viewportsFor({ family: 'home' }));
        expect(viewportsFor({ family: 'dialog' })).toEqual(expect.arrayContaining(small));
        expect(validateSurfaces([entry({ family: 'dialog', overlay: true })])).toEqual([]);
        expect(validateSurfaces([entry({ overlay: 'yes' })])).toEqual(['dialog.example.one: overlay must be true or false.']);
    });

    test('a variant is refused on a page that is not guarded against saving settings', async () => {
        await expect(applyVariant({}, {})).rejects.toThrow(/protectMaintainerServer\(page\).*bootSurfaceApp/);
    });

    test('a coarse viewport is a touch context and a fine one is not', () => {
        expect(variantContextOptions({ viewport: '390x844' })).toMatchObject({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        expect(variantContextOptions({ viewport: '1024x600' })).toMatchObject({ viewport: { width: 1024, height: 600 }, hasTouch: false, isMobile: false });
        expect(variantContextOptions({ forcedColors: 'active' })).toMatchObject({ forcedColors: 'active', reducedMotion: 'no-preference' });
    });

    test('the default runs the animated path, and the reduced-motion axis is the cell that differs', () => {
        expect(DEFAULT_VARIANT.reducedMotion).toBe('no-preference');
        const axis = EXTRA_AXES.find(candidate => candidate.id === 'reduced-motion');
        expect(variantContextOptions(axis.variant).reducedMotion).toBe('reduce');
    });

    test('a variant is resolved against the defaults and refuses unknown values', () => {
        expect(resolveVariant()).toEqual(DEFAULT_VARIANT);
        expect(resolveVariant({ density: 'compact', theme: 'libadwaita-light' })).toMatchObject({ density: 'compact', theme: 'libadwaita-light', viewport: '1440x900' });
        expect(() => resolveVariant({ density: 'roomy' })).toThrow(/Unknown density/);
        expect(() => resolveVariant({ theme: 'gruvbox' })).toThrow(/Unknown theme/);
        expect(() => viewportById('1x1')).toThrow(/Unknown matrix viewport/);
    });
});

describe('settings fixtures', () => {
    test('the settings of a boot get the persona, the tags and the folders that the needs ask for', () => {
        const settings = applySettingsFixtures({ power_user: { personas: { 'user-default.png': 'User' } } }, ['persona', 'tags', 'folders']);
        expect(settings.power_user.personas).toEqual({ 'user-default.png': 'User', [FIXTURES.persona.avatar]: FIXTURES.persona.name });
        expect(settings.tags).toHaveLength(FIXTURES.tags.names.length);
        expect(settings.tag_map[FIXTURES.character.avatar]).toHaveLength(FIXTURES.tags.assigned);
        expect(settings.power_user.sb_folders.characters.members[FIXTURES.character.avatar]).toBe(FIXTURES.folders.characters[0].id);
        expect(settings.power_user.sb_folders.migratedFromTags).toBe(true);
    });

    test('a need that is not asked for leaves the settings alone', () => {
        expect(applySettingsFixtures({ power_user: {} }, ['character', 'lorebook'])).toEqual({ power_user: {} });
    });

    test('the output is the same on every call', () => {
        const first = JSON.stringify(applySettingsFixtures({}, NEEDS));
        expect(JSON.stringify(applySettingsFixtures({}, NEEDS))).toBe(first);
    });
});

describe('tolerant loading', () => {
    test('a family file that fails to import is a problem that names the file and the error, and the others still load', async () => {
        const good = { id: 'list.fine.one', family: 'list' };
        const { surfaces, problems } = await loadFamilies(['settings', 'list', 'dialog', 'menu'], family => family !== 'menu', async family => {
            if (family === 'settings') {
                throw new SyntaxError('Unexpected token }');
            }
            return family === 'list' ? { surfaces: [good] } : { surfaces: 'nope' };
        });
        expect(surfaces).toEqual([good]);
        expect(problems).toEqual([
            { family: 'settings', message: 'settings.js could not be loaded: Unexpected token }' },
            { family: 'dialog', message: 'dialog.js must export a `surfaces` array.' },
        ]);
    });

    test('an entry of another family is a problem and is still listed', async () => {
        const { surfaces, problems } = await loadFamilies(['list'], () => true, async () => ({ surfaces: [{ id: 'dialog.x.y', family: 'dialog' }] }));
        expect(surfaces).toHaveLength(1);
        expect(problems[0].message).toBe('dialog.x.y is in list.js but its family is "dialog".');
    });

    test('an entry that is not an object is a problem and is left out', async () => {
        const good = { id: 'list.fine.one', family: 'list' };
        const { surfaces, problems } = await loadFamilies(['list'], () => true, async () => ({ surfaces: [null, good, 'text', 7] }));
        expect(surfaces).toEqual([good]);
        expect(problems.map(problem => problem.message)).toEqual([
            'list.js entry #0 is not an object, so it is left out.',
            'list.js entry #2 is not an object, so it is left out.',
            'list.js entry #3 is not an object, so it is left out.',
        ]);
    });

    test('a need module that fails to import is a problem, and the others still load', async () => {
        const { modules, fixtures, problems } = await loadNeedModules(['broken', 'fine'], async name => {
            if (name === 'broken') {
                throw new Error('boom');
            }
            return { default: {}, fixture: { a: 1 } };
        });
        expect(Object.keys(modules)).toEqual(['fine']);
        expect(fixtures).toEqual({ fine: { a: 1 } });
        expect(problems).toEqual(['needs/broken.js could not be loaded: boom']);
    });

    test('the real registry loaded without problems', () => {
        expect(NEED_LOAD_PROBLEMS).toEqual([]);
    });
});

describe('surface filter', () => {
    test('no filter selects the whole registry', () => {
        expect(selectSurfaces({})).toMatchObject({ active: false, problem: null, surfaces: SURFACES });
    });

    test('a family and an id narrow the run, and combine', () => {
        expect(selectSurfaces({ SURFACE_FAMILY: 'settings' }).surfaces).toHaveLength(surfacesByFamily('settings').length);
        expect(selectSurfaces({ SURFACE_ID: 'settings.backend.editor, settings.customize.logs' }).surfaces.map(surface => surface.id)).toEqual(['settings.backend.editor', 'settings.customize.logs']);
        expect(selectSurfaces({ SURFACE_FAMILY: 'settings', SURFACE_ID: 'settings.backend.editor' }).surfaces).toHaveLength(1);
    });

    test.each([
        [{ SURFACE_FAMILY: 'popup' }, 'SURFACE_FAMILY "popup" is not one of'],
        [{ SURFACE_ID: 'settings.nothing.here' }, 'SURFACE_ID "settings.nothing.here" is not a registered surface.'],
        [{ SURFACE_FAMILY: 'settings', SURFACE_ID: 'settings.backend.editor,settings.typo' }, 'SURFACE_ID "settings.typo" is not a registered surface.'],
        [{ SURFACE_FAMILY: 'dialog', SURFACE_ID: 'settings.backend.editor' }, 'No registered surface matches the filter.'],
    ])('a filter that cannot be satisfied says why: %j', (env, message) => {
        const { problem } = selectSurfaces(env);
        expect(problem).toContain(message);
    });
});

describe('surface filter and a family that failed to load', () => {
    const loadProblems = [{ family: 'list', message: 'list.js could not be loaded: boom' }];

    test('an id of a family that failed to load carries the load problem', () => {
        const { problem } = selectSurfaces({ SURFACE_ID: 'list.rows.main' }, { surfaces: SURFACES, loadProblems });
        expect(problem).toContain('SURFACE_ID "list.rows.main" is not a registered surface.');
        expect(problem).toContain('list.js could not be loaded: boom');
        expect(selectSurfaces({ SURFACE_ID: 'dialog.rows.main' }, { surfaces: SURFACES, loadProblems }).problem).not.toContain('boom');
        expect(loadProblemsFor(['list'], loadProblems)).toEqual(['list.js could not be loaded: boom']);
    });
});

describe('the ready of Persona Global Settings', () => {
    const ready = surfaceById('settings.persona.global').ready;

    test('a phone names the settings pane, a desktop the fixture row', () => {
        expect(ready({ viewport: '390x844' })).toContain('.sb-persona-settings');
        expect(ready({ viewport: '768x1024' })).toContain('.sb-persona-settings');
        expect(ready({ viewport: '1440x900' })).toContain('Audit Persona');
        expect(ready({})).toContain('Audit Persona');
    });
});

describe('states that exist at some viewports only', () => {
    const always = { id: 'always', open: noop };
    const phone = { id: 'sheet', open: noop, viewports: ['390x844'] };
    const surface = entry({ family: 'dialog', states: [always, phone, { id: 'both', open: noop, viewports: ['1440x900', '390x844'] }] });

    test('a state is listed only where it applies', () => {
        expect(validateSurfaces([surface])).toEqual([]);
        expect(statesFor(surface, '1440x900').map(state => state.id)).toEqual(['always', 'both']);
        expect(statesFor(surface, '390x844').map(state => state.id)).toEqual(['always', 'sheet', 'both']);
        expect(statesFor(surface, '320x568')).toEqual([always]);
        expect(statesFor(entry(), '390x844')).toEqual([]);
    });

    test.each([['an empty list', []], ['an unknown id', ['1x1']], ['a string', '390x844'], ['a list with a number', [390]]])('%s is refused', (_name, viewports) => {
        expect(validateSurfaces([entry({ states: [{ id: 'more', open: noop, viewports }] })])).toEqual([
            expect.stringContaining('dialog.example.one: state "more" viewports must be a non-empty list of '),
        ]);
    });

    test('a viewport that does not apply to the entry is refused', () => {
        const problems = validateSurfaces([entry({ viewports: ['1440x900'], states: [{ id: 'more', open: noop, viewports: ['390x844'] }] })]);
        expect(problems).toEqual([expect.stringContaining('state "more" viewports must be among the viewports that apply to the surface (1440x900)')]);
        expect(validateSurfaces([entry({ family: 'list', states: [{ id: 'more', open: noop, viewports: ['820x360'] }] })])).toHaveLength(1);
    });
});

describe('the ready field', () => {
    test.each([
        ['a selector', '.row'],
        ['a list of selectors', ['.row', '.title']],
        ['a function of the context', () => ['.row']],
    ])('%s is accepted, on a surface and on a state', (_name, ready) => {
        expect(validateSurfaces([entry({ ready, states: [{ id: 'more', open: noop, ready }] })])).toEqual([]);
    });

    test.each([['an empty string', ''], ['an empty list', []], ['a number', 3], ['a list with a number', ['.row', 3]]])('%s is refused', (_name, ready) => {
        const message = 'ready must be a selector, a non-empty list of selectors, or a function of the context.';
        expect(validateSurfaces([entry({ ready })])).toEqual([`dialog.example.one: ${message}`]);
        expect(validateSurfaces([entry({ states: [{ id: 'more', open: noop, ready }] })])).toEqual([`dialog.example.one: state "more" ${message}`]);
    });
});

describe('seeding safety', () => {
    const list = ports => JSON.stringify(ports.map(port => ({ url: `http://127.0.0.1:${port}` })));

    test('a server that the config started is accepted', () => {
        expect(() => assertSeedableServer('http://127.0.0.1:5103', 'Seeding', { SILLYBUNNY_TEST_SERVER_LIST: list([5102, 5103]) })).not.toThrow();
    });

    test('the server that the runner started for a shard is accepted, and only that one', () => {
        const env = { E2E_BASE_URL: 'http://127.0.0.1:5104', SILLYBUNNY_TEST_BASE_URL: 'http://127.0.0.1:5104' };
        expect(() => assertSeedableServer('http://127.0.0.1:5104', 'Seeding', env)).not.toThrow();
        expect(() => assertSeedableServer('http://127.0.0.1:5105', 'Seeding', env)).toThrow(/this run started/);
        expect(() => assertSeedableServer('http://127.0.0.1:5104', 'Seeding', { SILLYBUNNY_TEST_BASE_URL: 'http://127.0.0.1:5104' })).toThrow(/this run started/);
    });

    test('a stale runner address on a port the runner does not use is refused', () => {
        const stale = { E2E_BASE_URL: 'http://127.0.0.1:8000', SILLYBUNNY_TEST_BASE_URL: 'http://127.0.0.1:8000' };
        expect(() => assertSeedableServer('http://127.0.0.1:8000', 'Seeding', stale)).toThrow(/ports 5101 to 5999/);
        expect(() => assertSeedableServer('http://127.0.0.1:5100', 'Seeding', { E2E_BASE_URL: 'http://127.0.0.1:5100' })).toThrow();
        expect(() => assertSeedableServer('http://127.0.0.1:5101', 'Seeding', { E2E_BASE_URL: 'http://127.0.0.1:5101' })).not.toThrow();
        expect(() => assertSeedableServer('http://127.0.0.1:5999', 'Seeding', { E2E_BASE_URL: 'http://127.0.0.1:5999' })).not.toThrow();
        expect(() => assertSeedableServer('http://127.0.0.1:6000', 'Seeding', { E2E_BASE_URL: 'http://127.0.0.1:6000' })).toThrow();
    });

    test('any other server is refused unless the override is set on purpose', () => {
        const env = { SILLYBUNNY_TEST_SERVER_LIST: list([5103]) };
        expect(() => assertSeedableServer('http://127.0.0.1:5200', 'Seeding', env)).toThrow(/only the servers that this run started.*SILLYBUNNY_AUDIT_SEED=1/);
        expect(() => assertSeedableServer('http://127.0.0.1:5200', 'Seeding', {})).toThrow(/this run started/);
        expect(() => assertSeedableServer('http://127.0.0.1:5200', 'Seeding', { SILLYBUNNY_AUDIT_SEED: '1' })).not.toThrow();
        expect(() => assertSeedableServer('http://127.0.0.1:5200', 'Seeding', { SILLYBUNNY_AUDIT_SEED: 'yes' })).toThrow();
    });

    test('a host that is not loopback is refused, even when it is listed or the override is set', () => {
        const env = { SILLYBUNNY_AUDIT_SEED: '1', SILLYBUNNY_TEST_SERVER_LIST: JSON.stringify([{ url: 'http://192.168.1.5:5103' }]) };
        expect(() => assertSeedableServer('http://192.168.1.5:5103', 'Seeding', env)).toThrow(/loopback/);
        expect(() => assertSeedableServer('https://example.com', 'Seeding', env)).toThrow(/loopback/);
        expect(() => assertSeedableServer('not a url', 'Seeding', env)).toThrow(/not a URL/);
    });

    test('port 4444 is refused in every case, in CI too', () => {
        const every = { CI: 'true', SILLYBUNNY_AUDIT_SEED: '1', E2E_BASE_URL: 'http://127.0.0.1:4444', SILLYBUNNY_TEST_SERVER_LIST: list([4444]) };
        for (const env of [every, { E2E_BASE_URL: every.E2E_BASE_URL }, { SILLYBUNNY_TEST_SERVER_LIST: every.SILLYBUNNY_TEST_SERVER_LIST }, { SILLYBUNNY_AUDIT_SEED: '1' }, {}]) {
            expect(() => assertSeedableServer('http://127.0.0.1:4444', 'Seeding', env)).toThrow(/never seeds port 4444/);
            expect(() => assertSeedableServer('http://localhost:4444', 'Seeding', env)).toThrow(/never seeds port 4444/);
        }
    });

    test('the needs that failed to seed on a server are read from the setup', () => {
        const env = { SILLYBUNNY_AUDIT_SEED_FAILURES: JSON.stringify({ 'http://127.0.0.1:5103': { chat: 'boom' } }) };
        expect(seedFailuresOf('http://127.0.0.1:5103', ['character', 'chat'], env)).toEqual({ chat: 'boom' });
        expect(seedFailuresOf('http://127.0.0.1:5104', ['chat'], env)).toEqual({});
        expect(seedFailuresOf('http://127.0.0.1:5103', ['chat'], {})).toEqual({});
    });
});

describe('what the other configs run', () => {
    /** A glob as Playwright reads it for a path under the config directory: a pattern without a slash matches the base name. */
    const matches = (pattern, file) => {
        const target = pattern.includes('/') ? file : path.basename(file);
        const source = pattern.replace(/^\.\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\0').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\0/g, '(?:.*/)?');
        return new RegExp(`^${source}$`).test(target);
    };
    const patternsOf = value => (value === undefined ? [] : [value].flat().map(String));
    const picksUp = (config, file) => {
        const root = (config.testDir ?? '.').replace(/^\.\//, '').replace(/^\.$/, '');
        const inside = root === '' || file.startsWith(`${root}/`);
        const wanted = patternsOf(config.testMatch ?? '**/*.@(spec|test).?(c|m)[jt]s?(x)').some(pattern => matches(pattern, file));
        const ignored = patternsOf(config.testIgnore).some(pattern => matches(pattern, file));
        return inside && wanted && !ignored;
    };
    const auditSpecs = fs.readdirSync(new URL('../audit/', import.meta.url)).filter(name => name.endsWith('.e2e.js')).map(name => `audit/${name}`);

    test('there are audit specs to check', () => {
        expect(auditSpecs.length).toBeGreaterThan(0);
    });

    test.each([
        ['default', '../playwright.config.js'],
        ['Firefox', '../playwright.firefox.config.js'],
        ['WebKit', '../playwright.webkit.config.js'],
        ['foundation', '../playwright.foundation.config.js'],
    ])('the %s config does not pick up audit/', async (_name, file) => {
        const { default: config } = await import(file);
        for (const spec of auditSpecs) {
            expect({ spec, picked: picksUp(config, spec) }).toEqual({ spec, picked: false });
        }
    });

    test('the audit config does pick it up, and the default config still picks up an ordinary spec', async () => {
        const { default: audit } = await import('../playwright.audit.config.js');
        const { default: base } = await import('../playwright.config.js');
        expect(auditSpecs.every(spec => picksUp(audit, spec))).toBe(true);
        expect(picksUp(base, 'sample.e2e.js')).toBe(true);
    });
});

describe('backends', () => {
    test('the first four and the default are kept, and the extra Text Completion sources name their own source', () => {
        expect(Object.keys(BACKENDS).slice(0, 4)).toEqual(['chat-completion', 'text-completion', 'novelai', 'horde']);
        expect(DEFAULT_BACKEND).toBe('chat-completion');
        expect(BACKENDS['text-completion'].source).toBe('ooba');
        expect(Object.entries(BACKENDS).filter(([, backend]) => backend.api === 'textgenerationwebui').map(([id, backend]) => `${id}:${backend.source}`))
            .toEqual(['text-completion:ooba', 'koboldcpp:koboldcpp', 'llamacpp:llamacpp', 'aphrodite:aphrodite']);
    });
});

describe('need modules', () => {
    const noop = async () => {};

    test('every file of needs/ is a need, and the shipped modules are valid', () => {
        const files = fs.readdirSync(new URL('../helpers/surfaces/needs/', import.meta.url)).map(name => name.replace(/\.js$/, '')).sort();
        expect(NEEDS).toEqual(files);
        expect(validateNeedModules()).toEqual([]);
    });

    test('a need is seeded after the needs it requires, once', () => {
        expect(needClosure(['chat'])).toEqual(['character', 'chat']);
        expect(needClosure(['tags', 'chat', 'group', 'character'])).toEqual(['character', 'tags', 'chat', 'folders', 'characters-many', 'group']);
        expect(needClosure(['group-chat'])).toEqual(['character', 'tags', 'folders', 'characters-many', 'group', 'group-chat']);
        expect(() => needClosure(['spaceship'])).toThrow(/need "spaceship" is not available/);
    });

    test('a cycle, an unknown requirement, a seed without exists, and an unknown key are refused', () => {
        const modules = {
            a: { requires: ['b'] },
            b: { requires: ['a'] },
            c: { requires: ['zzz'] },
            d: { seed: noop },
            e: { colour: 'red' },
        };
        const fixtures = { a: {}, b: {}, c: {}, d: {}, e: {} };
        const problems = validateNeedModules(modules, fixtures).join('\n');
        expect(problems).toContain('needs/a.js: needs require each other in a cycle: a > b > a.');
        expect(problems).toContain('needs/c.js: requires must list needs that exist');
        expect(problems).toContain('needs/d.js: seed needs an exists function');
        expect(problems).toContain('needs/e.js: has an unknown field "colour".');
        expect(validateNeedModules({ x: {} }, {})).toEqual(['needs/x.js: must export `fixture`, the data that surfaces read.']);
    });

    test('settings seeding follows the requirements', () => {
        const settings = applySettingsFixtures({}, ['tags']);
        expect(settings.tag_map).toBeDefined();
        expect(settings.power_user.personas).toBeUndefined();
    });
});
