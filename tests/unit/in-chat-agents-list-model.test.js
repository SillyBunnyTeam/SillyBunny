/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Parameterised Jest tests do not use Playwright. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

const CATEGORIES = {
    tracker: { label: 'Tracker', icon: 'fa-chart-line' },
    randomizer: { label: 'Randomizer', icon: 'fa-dice' },
    content: { label: 'Content', icon: 'fa-film' },
    tool: { label: 'Tool', icon: 'fa-screwdriver-wrench' },
    companion: { label: 'Companion', icon: 'fa-user-astronaut' },
    custom: { label: 'Custom', icon: 'fa-puzzle-piece' },
};
const SUBCATEGORIES = {
    world: { category: 'tracker', label: 'World & Scene' },
    characters: { category: 'tracker', label: 'Character State' },
    progress: { category: 'tracker', label: 'Player Progress' },
    'player-choices': { category: 'tracker', label: 'Player Choices' },
    'prose-quality': { category: 'content', label: 'Prose Quality' },
    pov: { category: 'content', label: 'Point of View' },
    behaviour: { category: 'content', label: 'Behaviour & Tone' },
};

function entry(id, overrides = {}, { kind = 'agent', template = null, subcategory = '' } = {}) {
    return {
        key: `${kind}:${id}`,
        kind,
        agent: {
            id,
            name: id,
            description: '',
            prompt: 'Instructions',
            tags: [],
            category: 'custom',
            phase: 'pre',
            execution: 'inline',
            enabled: false,
            favorite: false,
            version: 1,
            injection: { order: 10 },
            ...overrides,
        },
        template,
        subcategory,
    };
}

function bundled(id, overrides = {}, { unused = false, version = 2, templateId = 'tpl-helper', subcategory = 'behaviour' } = {}) {
    const template = { id: templateId, name: 'Bundled Helper', category: 'content', version, subcategory };
    return entry(id, { category: 'content', sourceTemplateId: templateId, ...overrides }, {
        kind: unused ? 'agent-template' : 'agent', template, subcategory,
    });
}

function freeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
}

async function loadModel() {
    return await import('../../public/scripts/extensions/in-chat-agents/ui/agent-list-model.js');
}

function build(model, entries, options = {}) {
    return model.buildAgentListModel({ entries, categories: CATEGORIES, subcategories: SUBCATEGORIES, ...options });
}

function rows(model) {
    return model.sections.flatMap(section => section.groups.flatMap(group => group.rows));
}

function stageRows(model, key) {
    return model.sections.find(section => section.key === key)?.groups.flatMap(group => group.rows) ?? [];
}

function menuIds(model, selected, entries = [selected], options = {}) {
    const { rowKey = selected.key, ...listOptions } = options;
    const list = build(model, entries, listOptions);
    return model.getAgentRowMenuItems(selected, { model: list, rowKey }).map(item => item.id);
}

function middleEntries(selected) {
    return [
        { ...selected, key: 'agent:before', kind: 'agent', agent: { ...selected.agent, id: 'before', injection: { order: 0 } } },
        selected,
        { ...selected, key: 'agent:after', kind: 'agent', agent: { ...selected.agent, id: 'after', injection: { order: 20 } } },
    ];
}

const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
});

describe('Agents list grouping and visibility', () => {
    test('imports and builds without document, jQuery, a browser entry mock or a persistence adapter', async () => {
        const model = await loadModel();
        expect(typeof globalThis.document).toBe('undefined');
        expect(typeof globalThis.$).toBe('undefined');
        expect(build(model, []).sections).toEqual([]);
    });

    test('groups Pinned shortcuts followed by before, both, after and companion execution', async () => {
        const model = await loadModel();
        const list = build(model, [
            entry('after', { phase: 'post' }),
            entry('both', { phase: 'both' }),
            entry('sidecar', { phase: 'pre', execution: 'companion' }),
            entry('before', { favorite: true }),
        ]);

        expect(list.sections.map(section => section.key)).toEqual(['pinned', 'pre', 'both', 'post', 'companion']);
        expect(stageRows(list, 'pinned').map(row => row.key)).toEqual(['pinned:agent:before']);
        expect(stageRows(list, 'pre').map(row => row.key)).toEqual(['agent:before']);
        expect(stageRows(list, 'both').map(row => row.key)).toEqual(['agent:both']);
        expect(stageRows(list, 'post').map(row => row.key)).toEqual(['agent:after']);
        expect(stageRows(list, 'companion').map(row => row.key)).toEqual(['agent:sidecar']);
        expect(stageRows(list, 'pinned')[0]).toMatchObject({ selectionKey: 'agent:before', pinnedCopy: true });
    });

    test('companion category implies companion execution even for a legacy inline flag', async () => {
        const model = await loadModel();
        expect(build(model, [entry('legacy', { category: 'companion', execution: 'inline', phase: 'both' })])
            .sections.map(section => section.key)).toEqual(['companion']);
    });

    test('orders categories by AGENT_CATEGORIES, not the sketch order or input order', async () => {
        const model = await loadModel();
        const entries = ['custom', 'companion', 'tool', 'content', 'randomizer', 'tracker']
            .map(category => entry(category, { category, execution: 'companion' }));
        const list = build(model, entries);
        expect(list.sections[0].groups.map(group => group.category)).toEqual([
            'tracker', 'randomizer', 'content', 'tool', 'companion', 'custom',
        ]);
    });

    test('uses catalogue subcategory for saved copies; agent.subcategory is not a saved schema field', async () => {
        const model = await loadModel();
        const saved = bundled('saved', { category: 'tracker' }, { subcategory: 'world' });
        const custom = entry('custom', { category: 'tracker', subcategory: 'world' });
        const list = build(model, [saved, custom]);
        expect(list.sections[0].groups.map(group => group.label)).toEqual(['Tracker', 'Tracker · World & Scene']);
        expect(list.sections[0].groups[0].rows.map(row => row.key)).toEqual(['agent:custom']);
        expect(list.sections[0].groups[1].rows.map(row => row.key)).toEqual(['agent:saved']);
        expect(saved.agent).not.toHaveProperty('subcategory');
    });

    test('uses known subcategory order after the plain heading, with deterministic unknown headings last', async () => {
        const model = await loadModel();
        const entries = [
            bundled('progress', { category: 'tracker' }, { subcategory: 'progress' }),
            bundled('z', { category: 'tracker' }, { subcategory: 'z-extra' }),
            bundled('characters', { category: 'tracker' }, { subcategory: 'characters' }),
            entry('plain', { category: 'tracker' }),
            bundled('world', { category: 'tracker' }, { subcategory: 'world' }),
            bundled('a', { category: 'tracker' }, { subcategory: 'a-extra' }),
        ];
        expect(build(model, entries).sections[0].groups.map(group => group.subcategory)).toEqual([
            '', 'world', 'characters', 'progress', 'a-extra', 'z-extra',
        ]);
    });

    test('keeps a bundled row visible when its edited category differs from its template subcategory category', async () => {
        const model = await loadModel();
        const selected = bundled('recategorised', { category: 'custom' }, { subcategory: 'behaviour' });
        const list = build(model, [selected]);
        expect(list.visibleKeys).toEqual(['agent:recategorised']);
        expect(list.sections[0].groups[0].label).toBe('Custom · Behaviour & Tone');
    });

    test('sorts within a sub-heading by numeric injection.order then name then canonical key', async () => {
        const model = await loadModel();
        const entries = [
            entry('z', { name: 'Zulu', injection: { order: 2 } }),
            entry('b', { name: 'Alpha', injection: { order: 2 } }),
            entry('first', { name: 'Zulu', injection: { order: -5 } }),
            entry('a', { name: 'Alpha', injection: { order: 2 } }),
            entry('numeric-string', { name: 'Middle', injection: { order: '1' } }),
        ];
        expect(stageRows(build(model, entries), 'pre').map(row => row.key)).toEqual([
            'agent:first', 'agent:numeric-string', 'agent:a', 'agent:b', 'agent:z',
        ]);
    });

    test('Q51: saved rows precede unused rows, which sort by name rather than template order', async () => {
        const model = await loadModel();
        const list = build(model, [
            bundled('tpl-z', { name: 'Zulu', injection: { order: -100 } }, { unused: true }),
            bundled('saved', { name: 'Saved', injection: { order: 100 } }),
            bundled('tpl-a', { name: 'Alpha', injection: { order: 999 } }, { unused: true }),
        ]);
        expect(list.visibleKeys).toEqual(['agent:saved', 'agent-template:tpl-a', 'agent-template:tpl-z']);
    });

    test('nonfinite or absent order falls back to zero, without changing saved values', async () => {
        const model = await loadModel();
        const entries = freeze([
            entry('late', { injection: { order: 3 } }),
            entry('A', { injection: { order: Infinity } }),
            entry('B', { injection: {} }),
        ]);
        expect(stageRows(build(model, entries), 'pre').map(row => row.key)).toEqual(['agent:A', 'agent:B', 'agent:late']);
        expect(entries[1].agent.injection.order).toBe(Infinity);
    });

    test('omits empty sections and sub-headings and gives each displayed grouping a unique key', async () => {
        const model = await loadModel();
        const list = build(model, [entry('one', { phase: 'post' })]);
        expect(list.sections.map(section => section.key)).toEqual(['post']);
        expect(list.sections[0].groups).toHaveLength(1);
        expect(new Set(list.sections.flatMap(section => section.groups.map(group => group.key))).size).toBe(1);
        expect(build(model, [], { search: 'missing' }).sections).toEqual([]);
    });

    test.each([
        ['source-linked Pathfinder', entry('internal', { sourceTemplateId: 'tpl-pathfinder' })],
        ['legacy Pathfinder name', entry('legacy', { name: 'Pathfinder' })],
        ['Pathfinder tool', entry('tools', { category: 'tool', tools: [{ name: 'Pathfinder_Search' }] })],
        ['hidden template', bundled('tpl-pathfinder', {}, { unused: true, templateId: 'tpl-pathfinder' })],
        ['removed saved bundle', entry('removed', { sourceTemplateId: 'tpl-director-core' })],
        ['removed template', bundled('tpl-anti-slop-regex', {}, { unused: true, templateId: 'tpl-anti-slop-regex' })],
        ['legacy removed bundle name and author', entry('legacy-removed', { name: 'NSFW Mode', author: 'SillyBunny' })],
    ])('excludes %s without deleting or mutating the supplied entry', async (_label, excluded) => {
        const model = await loadModel();
        const entries = freeze([excluded, entry('kept')]);
        const before = structuredClone(entries);
        expect(build(model, entries).visibleKeys).toEqual(['agent:kept']);
        expect(entries).toEqual(before);
    });

    test('does not hide a custom same-name record or a companion hidden only from automatic runs', async () => {
        const model = await loadModel();
        const list = build(model, [
            entry('user', { name: 'NSFW Mode', author: 'User' }),
            entry('hidden-from-runs', { execution: 'companion' }),
        ]);
        expect(list.visibleKeys).toEqual(['agent:user', 'agent:hidden-from-runs']);
    });

    test.each([
        ['name', { name: 'MiXeD Helper' }, 'mixed'],
        ['description', { description: 'Bright RED sky' }, 'red'],
        ['tags', { tags: ['Some-Tag'] }, 'SOME-tag'],
    ])('search matches %s case-insensitively across all stages', async (_field, fields, search) => {
        const model = await loadModel();
        const list = build(model, [entry('one', fields), entry('two', { ...fields, phase: 'post' }), entry('not-matched')], { search });
        expect(list.visibleKeys).toEqual(['agent:one', 'agent:two']);
    });

    test('search does not silently expand to prompt text', async () => {
        const model = await loadModel();
        expect(build(model, [entry('one', { prompt: 'SecretPromptTerm' })], { search: 'secretpromptterm' }).visibleKeys).toEqual([]);
    });

    test('only-on uses scoped canonical enabled keys, not the aggregate legacy flag or Pinned copies', async () => {
        const model = await loadModel();
        const entries = [
            entry('other-scope', { enabled: true }),
            entry('active-scope', { enabled: false, favorite: true }),
        ];
        const list = build(model, entries, { enabledKeys: new Set(['agent:active-scope']), filters: { onlyOn: true, categories: [] } });
        expect(list.visibleKeys).toEqual(['agent:active-scope']);
        expect(rows(list).map(row => row.key)).toEqual(['pinned:agent:active-scope', 'agent:active-scope']);
        expect(rows(list).every(row => row.enabled)).toBe(true);
        expect(list.onCount).toBe(1);
    });

    test('unused catalogue entries are off even if supplied with a stale enabled flag or template ID in the scope set', async () => {
        const model = await loadModel();
        const unused = bundled('tpl-unused', { enabled: true }, { unused: true, templateId: 'tpl-unused' });
        const list = build(model, [unused], { enabledKeys: new Set([unused.key]), filters: { onlyOn: true, categories: [] } });
        expect(list.visibleKeys).toEqual([]);
        expect(list.onCount).toBe(0);
    });

    test('category checkboxes are a union combined with search and only-on; filtering never changes enablement or order', async () => {
        const model = await loadModel();
        const entries = freeze([
            entry('tracker', { category: 'tracker', name: 'Match Tracker', enabled: true }),
            entry('content', { category: 'content', name: 'Match Content', enabled: true }),
            entry('custom', { name: 'Match Custom', enabled: true }),
            entry('off', { category: 'content', name: 'Match Off' }),
            entry('other-name', { category: 'content', enabled: true }),
        ]);
        const before = structuredClone(entries);
        const list = build(model, entries, { search: 'match', filters: { onlyOn: true, categories: ['content', 'tracker'] } });
        expect(list.visibleKeys).toEqual(['agent:tracker', 'agent:content']);
        expect(list.onCount).toBe(4);
        expect(entries).toEqual(before);
        expect(build(model, entries).visibleKeys).toHaveLength(5);
    });

    test('the same search and category visibility applies to Pinned shortcuts and canonical rows', async () => {
        const model = await loadModel();
        const list = build(model, [entry('hidden', { favorite: true }), entry('match', { category: 'content', favorite: true })], {
            search: 'match', filters: { categories: ['content'], onlyOn: false },
        });
        expect(rows(list).map(row => row.key)).toEqual(['pinned:agent:match', 'agent:match']);
    });
});

describe('Agents row-menu rules', () => {
    test.each([
        ['pre', ['pin', 'preview-prompt', 'apply-last', 'apply-target', 'convert-companion', 'duplicate', 'export', 'delete']],
        ['both', ['pin', 'preview-prompt', 'apply-last', 'apply-target', 'convert-companion', 'duplicate', 'export', 'delete']],
        ['post', ['pin', 'apply-last', 'apply-target', 'convert-companion', 'duplicate', 'export', 'delete']],
    ])('custom inline %s has only applicable actions, in section order', async (phase, expected) => {
        const model = await loadModel();
        const selected = entry('custom', { phase });
        expect(menuIds(model, selected)).toEqual(expected);
    });

    test('blank inline prompt removes preview, not apply/target or other actions', async () => {
        const model = await loadModel();
        const selected = entry('empty', { prompt: '   ' });
        expect(menuIds(model, selected)).toEqual(['pin', 'apply-last', 'apply-target', 'convert-companion', 'duplicate', 'export', 'delete']);
    });

    test('companion run is not duplicated as Apply Last and feedback preview remains discoverable when feedback is off', async () => {
        const model = await loadModel();
        const selected = entry('companion', { execution: 'companion', companion: { feedback: { enabled: false } } });
        expect(menuIds(model, selected)).toEqual(['pin', 'preview-feedback', 'run-last', 'convert-inline', 'duplicate', 'export', 'delete']);
    });

    test('tool agents cannot convert but keep their existing preview and manual-target actions', async () => {
        const model = await loadModel();
        expect(menuIds(model, entry('tool', { category: 'tool' }))).toEqual([
            'pin', 'preview-prompt', 'apply-last', 'apply-target', 'duplicate', 'export', 'delete',
        ]);
    });

    test.each([1, 2])('Q50: Delete and Restore both appear with %i saved bundled copies', async copies => {
        const model = await loadModel();
        const selected = bundled('saved', { version: 2 });
        const entries = copies === 1 ? [selected] : [selected, bundled('extra', { version: 2 })];
        const items = model.getAgentRowMenuItems(selected, { model: build(model, entries), rowKey: selected.key });
        expect(items.filter(item => item.section === 'destructive')).toEqual([
            { id: 'restore-default', section: 'destructive', danger: true },
            { id: 'delete', section: 'destructive', danger: true },
        ]);
    });

    test('saved bundled inline with an update has 12 actions at most, including both move actions and both destructive actions', async () => {
        const model = await loadModel();
        const selected = bundled('saved');
        const items = model.getAgentRowMenuItems(selected, { model: build(model, middleEntries(selected)), rowKey: selected.key });
        expect(items.map(item => item.id)).toEqual([
            'pin', 'move-up', 'move-down', 'preview-prompt', 'apply-last', 'apply-target',
            'convert-companion', 'duplicate', 'update', 'export', 'restore-default', 'delete',
        ]);
        expect(items.find(item => item.id === 'update')).toMatchObject({ version: 2 });
        expect(items).toHaveLength(12);
        expect(items.every(item => !Object.hasOwn(item, 'disabled'))).toBe(true);
    });

    test('a current saved bundled copy omits Update without hiding Restore or Delete', async () => {
        const model = await loadModel();
        expect(menuIds(model, bundled('current', { version: 2 }))).toEqual([
            'pin', 'preview-prompt', 'apply-last', 'apply-target', 'convert-companion', 'duplicate', 'export', 'restore-default', 'delete',
        ]);
    });

    test('saved bundled companion uses feedback/run/convert-inline and its own versioned update', async () => {
        const model = await loadModel();
        expect(menuIds(model, bundled('companion', { execution: 'companion' }))).toEqual([
            'pin', 'preview-feedback', 'run-last', 'convert-inline', 'duplicate', 'update', 'export', 'restore-default', 'delete',
        ]);
    });

    test('an imported/orphan record without a matching template has no Restore or Update', async () => {
        const model = await loadModel();
        const selected = entry('imported', { sourceTemplateId: 'tpl-no-longer-shipped' });
        expect(menuIds(model, selected)).toEqual([
            'pin', 'preview-prompt', 'apply-last', 'apply-target', 'convert-companion', 'duplicate', 'export', 'delete',
        ]);
    });

    test.each(['inline', 'companion'])('unused %s has no destructive or Update action, but is not a disabled placeholder', async execution => {
        const model = await loadModel();
        const selected = bundled('tpl-unused', { execution }, { unused: true, templateId: 'tpl-unused' });
        expect(menuIds(model, selected)).toEqual(execution === 'inline'
            ? ['pin', 'preview-prompt', 'apply-last', 'apply-target', 'convert-companion', 'duplicate', 'export']
            : ['pin', 'preview-feedback', 'run-last', 'convert-inline', 'duplicate', 'export']);
    });

    test('Pin changes to Unpin without adding a second command', async () => {
        const model = await loadModel();
        expect(menuIds(model, entry('pinned', { favorite: true }))[0]).toBe('unpin');
    });

    test('Move actions respect sub-heading edges, not only the entire list edges', async () => {
        const model = await loadModel();
        const first = entry('first', { injection: { order: 0 } });
        const last = entry('last', { injection: { order: 20 } });
        const otherCategory = entry('earlier', { category: 'tracker', injection: { order: -10 } });
        expect(menuIds(model, first, [otherCategory, first, last]).filter(id => id.startsWith('move-'))).toEqual(['move-down']);
        expect(menuIds(model, last, [otherCategory, first, last]).filter(id => id.startsWith('move-'))).toEqual(['move-up']);
        expect(menuIds(model, otherCategory, [otherCategory, first, last]).filter(id => id.startsWith('move-'))).toEqual([]);
    });

    test.each([
        ['search', { search: 'saved' }],
        ['category', { filters: { categories: ['content'], onlyOn: false } }],
        ['only-on', { filters: { categories: [], onlyOn: true } }],
        ['Pinned shortcut', { rowKey: 'pinned:agent:saved' }],
    ])('omits both Move commands during %s, even when the canonical row is in the middle', async (_label, options) => {
        const model = await loadModel();
        const selected = bundled('saved', { favorite: true, enabled: true });
        expect(menuIds(model, selected, middleEntries(selected), options).filter(id => id.startsWith('move-'))).toEqual([]);
    });

    test('Move actions cannot cross stages or template subcategories', async () => {
        const model = await loadModel();
        const selected = bundled('saved', { phase: 'both' }, { subcategory: 'pov' });
        const entries = [selected, bundled('other-stage', { phase: 'post' }, { subcategory: 'pov' }), bundled('other-subcategory')];
        expect(menuIds(model, selected, entries).filter(id => id.startsWith('move-'))).toEqual([]);
    });

    test('every menu in the saved/unused, stage, category, update, filter and Pinned matrix stays within Q50\'s 13-item cap', async () => {
        const model = await loadModel();
        let largest = 0;
        for (const category of Object.keys(CATEGORIES)) {
            for (const phase of ['pre', 'both', 'post']) {
                for (const execution of ['inline', 'companion']) {
                    for (const unused of [false, true]) {
                        for (const version of [1, 2]) {
                            const selected = bundled('selected', { category, phase, execution, version, favorite: true, enabled: true }, { unused });
                            for (const options of [{}, { search: 'selected' }, { filters: { onlyOn: true, categories: [] } }, { rowKey: `pinned:${selected.key}` }]) {
                                const ids = menuIds(model, selected, middleEntries(selected), options);
                                expect(new Set(ids).size).toBe(ids.length);
                                expect(ids.length).toBeLessThanOrEqual(13);
                                largest = Math.max(largest, ids.length);
                            }
                        }
                    }
                }
            }
        }
        expect(largest).toBe(12);
    });
});

describe('Agents canonical identity and selection', () => {
    test('a toggle changes enabled state without changing normal or Pinned keys', async () => {
        const model = await loadModel();
        const selected = entry('with:colons', { favorite: true });
        const off = build(model, [selected], { enabledKeys: new Set() });
        const on = build(model, [selected], { enabledKeys: new Set([selected.key]) });
        expect(rows(off).map(row => row.key)).toEqual(['pinned:agent:with:colons', 'agent:with:colons']);
        expect(rows(on).map(row => row.key)).toEqual(['pinned:agent:with:colons', 'agent:with:colons']);
        expect(rows(off).every(row => row.enabled === false)).toBe(true);
        expect(rows(on).every(row => row.enabled === true)).toBe(true);
        expect(selected.agent.enabled).toBe(false);
    });

    test('materialisation intentionally replaces only the template key; unaffected row keys remain stable', async () => {
        const model = await loadModel();
        const unused = bundled('tpl:helper', { favorite: true }, { unused: true, templateId: 'tpl:helper' });
        const saved = bundled('saved:uuid', { favorite: true }, { templateId: 'tpl:helper' });
        const before = build(model, [unused, entry('other')]);
        const after = build(model, [saved, entry('other')]);
        expect(before.visibleKeys).toEqual(['agent-template:tpl:helper', 'agent:other']);
        expect(after.visibleKeys).toEqual(['agent:saved:uuid', 'agent:other']);
        expect(model.remapAgentListKeys(rows(before).map(row => row.key), { fromKey: unused.key, toKey: saved.key }))
            .toEqual(rows(after).map(row => row.key));
    });

    test('selection canonicalises exactly one Pinned prefix and preserves ID colons', async () => {
        const model = await loadModel();
        expect(model.getAgentSelectionKey('pinned:agent:with:colons')).toBe('agent:with:colons');
        expect(model.getAgentSelectionKey('agent:pinned:embedded')).toBe('agent:pinned:embedded');
        expect(model.getAgentSelectionKey('agent-template:tpl:helper')).toBe('agent-template:tpl:helper');
    });

    test('filtered Select All includes unused entries once, excludes hidden records and does not select fixed destinations', async () => {
        const model = await loadModel();
        const list = build(model, [
            entry('match', { name: 'Match', favorite: true, category: 'content' }),
            bundled('tpl-match', { name: 'Match Template' }, { unused: true, templateId: 'tpl-match' }),
            entry('filtered', { category: 'tracker' }),
            entry('not-matched', { name: 'Other', category: 'content' }),
            entry('internal', { name: 'Match', sourceTemplateId: 'tpl-pathfinder' }),
        ], { search: 'match', filters: { categories: ['content'], onlyOn: false } });
        expect(model.getAgentSelectionKeys(list)).toEqual(['agent:match', 'agent-template:tpl-match']);
        expect(model.getAgentSelectionKeys(list)).not.toEqual(expect.arrayContaining(['settings', 'companions', 'groups']));
    });

    test('remapping materialised selection does not duplicate a key already present and does not mutate its input', async () => {
        const model = await loadModel();
        const keys = freeze(['agent-template:tpl:helper', 'agent:uuid', 'agent:other']);
        expect(model.remapAgentListKeys(keys, { fromKey: 'agent-template:tpl:helper', toKey: 'agent:uuid' }))
            .toEqual(['agent:uuid', 'agent:other']);
        expect(keys).toEqual(['agent-template:tpl:helper', 'agent:uuid', 'agent:other']);
    });
});

describe('Agents shared movement', () => {
    test('menu/grip nudge and a drag permutation return the same persistence order and focus key', async () => {
        const model = await loadModel();
        const entries = freeze([entry('a', { injection: { order: 0 } }), entry('b'), entry('c', { injection: { order: 20 } })]);
        const list = build(model, entries);
        const nudge = model.moveAgentWithinSubheading(list, { key: 'agent:b', direction: -1 });
        const drag = model.moveAgentWithinSubheading(list, { key: 'agent:b', orderedKeys: ['agent:b', 'agent:a', 'agent:c'] });
        expect(nudge).toEqual({ orderedKeys: ['agent:b', 'agent:a', 'agent:c'], materialiseKeys: [], focusKey: 'agent:b' });
        expect(drag).toEqual(nudge);
        expect(entries.map(item => item.key)).toEqual(['agent:a', 'agent:b', 'agent:c']);
    });

    test('downward nudge changes just the matching sub-heading, not other categories, stages or subcategories', async () => {
        const model = await loadModel();
        const selected = bundled('a', { injection: { order: 0 } });
        const next = bundled('b');
        const list = build(model, [selected, next, entry('other'), bundled('post', { phase: 'post' }), bundled('pov', {}, { subcategory: 'pov' })]);
        expect(model.moveAgentWithinSubheading(list, { key: selected.key, direction: 1 })).toEqual({
            orderedKeys: ['agent:b', 'agent:a'], materialiseKeys: [], focusKey: 'agent:a',
        });
    });

    test.each([
        ['first row up', {}, { key: 'agent:a', direction: -1 }],
        ['last row down', {}, { key: 'agent:b', direction: 1 }],
        ['missing row', {}, { key: 'agent:missing', direction: 1 }],
        ['Pinned copy', {}, { key: 'pinned:agent:a', direction: 1 }],
        ['search', { search: 'a' }, { key: 'agent:a', direction: 1 }],
        ['category filter', { filters: { categories: ['custom'], onlyOn: false } }, { key: 'agent:a', direction: 1 }],
        ['only-on filter', { filters: { categories: [], onlyOn: true } }, { key: 'agent:a', direction: 1 }],
        ['cross-heading drag', {}, { key: 'agent:a', orderedKeys: ['agent:a', 'agent:b', 'agent:other'] }],
        ['incomplete drag', {}, { key: 'agent:a', orderedKeys: ['agent:a'] }],
        ['duplicate drag keys', {}, { key: 'agent:a', orderedKeys: ['agent:a', 'agent:a'] }],
    ])('declines %s instead of persisting a misleading reorder', async (_label, options, move) => {
        const model = await loadModel();
        const list = build(model, [entry('a', { enabled: true, favorite: true, injection: { order: 0 } }), entry('b', { enabled: true }), entry('other', { category: 'content' })], options);
        expect(model.moveAgentWithinSubheading(list, move)).toBeNull();
    });

    test('Q51: unused rows cannot move and expose no Move commands; saved edges ignore unused neighbours', async () => {
        const model = await loadModel();
        const unused = bundled('tpl-unused', {}, { unused: true, templateId: 'tpl-unused' });
        const saved = bundled('saved', { injection: { order: 0 } });
        const list = build(model, [saved, unused]);
        expect(model.moveAgentWithinSubheading(list, { key: unused.key, direction: -1 })).toBeNull();
        expect(menuIds(model, unused, [saved, unused]).filter(id => id.startsWith('move-'))).toEqual([]);
        expect(menuIds(model, saved, [saved, unused]).filter(id => id.startsWith('move-'))).toEqual([]);
    });

    test('the two shared move inputs yield identical real store order slots, preserving other saved agents', async () => {
        const model = await loadModel();
        jest.resetModules();
        await jest.unstable_mockModule('../../public/script.js', () => ({ getRequestHeaders: () => ({}), saveSettingsDebounced: jest.fn() }));
        await jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({ extension_settings: {}, getContext: () => ({ groupId: null }) }));
        await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({ uuidv4: () => 'unused-uuid', regexFromString: value => new RegExp(value) }));
        globalThis.fetch = jest.fn(async () => ({ ok: true }));
        const store = await import('../../public/scripts/extensions/in-chat-agents/agent-store.js');
        const entries = [
            entry('a', { injection: { order: 0 } }),
            entry('outside', { category: 'content', injection: { order: 10 } }),
            entry('b', { injection: { order: 20 } }),
            entry('c', { injection: { order: 30 } }),
        ];
        const list = build(model, entries);
        const nudge = model.moveAgentWithinSubheading(list, { key: 'agent:b', direction: -1 });
        const drag = model.moveAgentWithinSubheading(list, { key: 'agent:b', orderedKeys: ['agent:b', 'agent:a', 'agent:c'] });
        const persist = async move => {
            store.loadAgents(entries.map(item => item.agent));
            await store.reorderAgentsIntoOrderSlots(move.orderedKeys.map(key => key.slice('agent:'.length)));
            return store.getAgents().sort((a, b) => a.injection.order - b.injection.order).map(agent => [agent.id, agent.injection.order]);
        };
        const nudgeSaved = await persist(nudge);
        const dragSaved = await persist(drag);
        expect(nudgeSaved).toEqual([['b', 0], ['outside', 10], ['a', 20], ['c', 30]]);
        expect(dragSaved).toEqual(nudgeSaved);
        expect(nudge.focusKey).toBe('agent:b');
        expect(drag.focusKey).toBe('agent:b');
    });
});
