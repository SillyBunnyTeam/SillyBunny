/* eslint-disable playwright/no-standalone-expect -- These are parameterised Jest tests. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../../public/scripts/sillybunny-persona-model.js';

const personaSource = readFileSync(new URL('../../public/scripts/personas.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

function functionSource(name) {
    const match = personaSource.match(new RegExp(`^(?:export )?((?:async )?function ${name}\\([\\s\\S]*?^})`, 'm'));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[1];
}

function selectOptions(id) {
    const select = indexSource.match(new RegExp(`<select\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)<\\/select>`));
    if (!select) throw new Error(`Missing select ${id}`);
    return [...select[1].matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map(([, attributes, label]) => ({
        value: attributes.match(/\bvalue="([^"]*)"/)[1],
        label,
        i18n: attributes.match(/\bdata-i18n="([^"]*)"/)[1],
    }));
}

function fixture() {
    const descriptor = {
        description: 'Base description',
        position: 0,
        depth: 2,
        role: 0,
        lorebook: 'Lore',
        connections: [{ type: 'character', id: 'friend.png' }],
        title: 'Title',
        appendices: [
            { id: 'first', name: 'First', description: 'First note' },
            { id: 'second', name: 'Second', description: 'Second note' },
        ],
        activeAppendices: { __default__: ['first', 'second'], 'friend.png': ['second'] },
        extension: { nested: ['kept'] },
    };
    const state = { personas: { 'ari.png': 'Ari' }, persona_descriptions: { 'ari.png': descriptor } };
    const baseline = model.personaToDraft({ name: 'Ari', descriptor });
    const draft = structuredClone(baseline);
    return { state, descriptor, baseline, draft };
}

function depsFor(state, overrides = {}) {
    return {
        state,
        isActive: jest.fn(() => false),
        project: jest.fn(),
        setUserName: jest.fn(),
        save: jest.fn(async () => true),
        emit: jest.fn(async () => {}),
        events: { PERSONA_UPDATED: 'updated', PERSONA_RENAMED: 'renamed' },
        ...overrides,
    };
}

function legacyAppendixNormalizer() {
    return runInNewContext([
        ...['createPersonaAppendixId', 'normalizePersonaAppendixSelections', 'normalizePersonaAppendices'].map(functionSource),
        'normalizePersonaAppendices;',
    ].join('\n'), {
        Date: { now: () => 123 },
        PERSONA_APPENDICES_DEFAULT_SCOPE_KEY: '__default__',
        PERSONA_APPENDICES_SELECTIONS_KEY: 'activeAppendices',
    });
}

describe('persona schema parity', () => {
    test('positions match the legacy enum and role/depth defaults stay fixed', () => {
        const literal = personaSource.match(/export const persona_description_positions = (\{[\s\S]*?^\});/m)[1];
        expect(model.PERSONA_POSITION).toEqual(runInNewContext(`(${literal})`));
        expect(model.PERSONA_ROLE).toEqual({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });
        expect(model.DEFAULT_DEPTH).toBe(2);
        expect(model.DEFAULT_ROLE).toBe(0);
        expect(model.MAX_DEPTH).toBe(9999);
        expect(Object.isFrozen(model.PERSONA_POSITION)).toBe(true);
        expect(Object.isFrozen(model.PERSONA_ROLE)).toBe(true);
    });

    test('position and role options match the legacy selects, in order', () => {
        expect(model.POSITION_OPTIONS).toEqual(selectOptions('persona_description_position'));
        expect(model.ROLE_OPTIONS).toEqual(selectOptions('persona_depth_role'));
        expect(Object.isFrozen(model.POSITION_OPTIONS)).toBe(true);
        expect(Object.isFrozen(model.ROLE_OPTIONS)).toBe(true);
    });

    test.each(['Hello, World!', '---', '', undefined, 'é日本語', 'a'.repeat(70), ' An_Appendix '])(
        'appendix id slug matches legacy for %p', name => {
            const legacy = runInNewContext(`${functionSource('createPersonaAppendixId')}; createPersonaAppendixId`, {
                Date: { now: () => 123 },
            });
            expect(model.createAppendixId(name, 123)).toBe(legacy(name));
        },
    );
});

describe('persona draft boundary', () => {
    test('missing fields produce exactly the draft keys and their defaults', () => {
        expect(model.personaToDraft()).toEqual({
            name: '', title: '', description: '', position: 0, depth: 2, role: 0, appendices: [],
        });
        expect(Object.keys(model.personaToDraft())).toEqual(model.DRAFT_KEYS);
    });

    test('drafts use the base description, exclude metadata, and detach notes', () => {
        const { descriptor } = fixture();
        const draft = model.personaToDraft({ name: 123, descriptor, persona_description: 'Composed text' });
        draft.appendices[0].description = 'Edited';
        draft.appendices.push({ id: 'new', name: 'New', description: 'New text' });
        expect(draft.name).toBe('123');
        expect(draft.description).toBe('Base description');
        expect(Object.keys(draft)).toEqual(model.DRAFT_KEYS);
        expect(descriptor.appendices[0].description).toBe('First note');
        expect(descriptor.appendices).toHaveLength(2);
        expect(descriptor.activeAppendices.__default__).toEqual(['first', 'second']);
    });

    test.each([1, '1', 5, -1, null, undefined, 'invalid', Infinity])('position %p migrates to in-prompt', position => {
        expect(model.personaToDraft({ descriptor: { position } }).position).toBe(0);
    });

    test('draft numeric and string fields are parsed at the boundary', () => {
        expect(model.personaToDraft({ descriptor: { title: 12, description: 34, position: '4', depth: '3.9', role: '2' } }))
            .toMatchObject({ title: '12', description: '34', position: 4, depth: 3, role: 2 });
        expect(model.personaToDraft({ descriptor: { depth: 'bad', role: 1.5 } }))
            .toMatchObject({ depth: 2, role: 0 });
    });

    test.each([
        ['4.9', 4], ['-1', 0], ['0', 0], ['100000', 9999], [3.8, 3],
    ])('parseDepth(%p) clamps and floors to %p', (raw, expected) => {
        expect(model.parseDepth(raw, 7)).toBe(expected);
    });

    test.each(['', ' ', 'invalid', null, undefined, Infinity, NaN, true, [], {}])(
        'invalid UI input %p uses the supplied fallback', raw => {
            expect(model.parseDepth(raw, 7)).toBe(7);
            expect(model.parseRole(raw, 2)).toBe(2);
            expect(model.parsePosition(raw, 9)).toBe(9);
        },
    );

    test('enum parsers accept only supported roles and positions', () => {
        expect(model.parseRole('1', 2)).toBe(1);
        expect(model.parseRole('1.5', 2)).toBe(2);
        expect(model.parseRole(3, 1)).toBe(1);
        expect(model.parsePosition('4', 9)).toBe(4);
        expect(model.parsePosition('1', 9)).toBe(0);
        expect(model.parsePosition(6, 9)).toBe(9);
    });

    test.each(['', '  \n\t', null, undefined])('validation rejects a missing or blank name %p', name => {
        expect(model.validateDraft({ name })).toEqual({ ok: false, errors: { name: 'required' } });
    });

    test('optional fields do not block a valid name', () => {
        expect(model.validateDraft({ name: ' Ari ', depth: -999, position: 'unknown', description: '' }))
            .toEqual({ ok: true, errors: {} });
    });

    test.each(['', ' \n\t', null, undefined])('validation rejects a blank note name %p', name => {
        expect(model.validateDraft({ name: 'Ari', appendices: [{ name: 'Valid' }, { name }] }))
            .toEqual({ ok: false, errors: { appendices: { 1: 'required' } } });
    });
});

describe('persona apply and rollback', () => {
    test('note receipts canonicalize previous and written notes exactly like the legacy normalizer', () => {
        const clock = jest.spyOn(Date, 'now').mockReturnValue(123);
        try {
            const { state, descriptor, baseline, draft } = fixture();
            const notes = [
                { id: ' same ', name: ' First ', description: 1, extra: true },
                { id: 'same', name: '  ' },
                { id: 'same-1', name: false, description: null },
                { id: ' ', name: 0, description: false },
                null,
                { name: ' Missing id ' },
            ];
            descriptor.appendices = structuredClone(notes);
            draft.appendices = [...notes, { id: 'same', name: ' Last ' }];
            const expectedPrevious = legacyAppendixNormalizer()({ appendices: notes });
            const expectedWritten = legacyAppendixNormalizer()({ appendices: draft.appendices });
            const applied = model.applyDraft(state, 'ari.png', baseline, draft);
            expect(applied.previous.appendices).toEqual(expectedPrevious);
            expect(descriptor.appendices).toEqual(expectedWritten);
            expect(model.revertDraft(state, 'ari.png', applied)).toEqual(['appendices']);
            expect(descriptor.appendices).toEqual(expectedPrevious);
        } finally {
            clock.mockRestore();
        }
    });

    test('writes only dirty keys into the live descriptor, preserving unknown and immediate-action keys', () => {
        const { state, descriptor, baseline, draft } = fixture();
        const connections = descriptor.connections;
        const extension = descriptor.extension;
        const selections = descriptor.activeAppendices;
        descriptor.description = 'Later external description';
        descriptor.lorebook = 'Later lore';
        draft.title = 'New title';
        draft.unknown = 'Not editable';

        expect(model.applyDraft(state, 'ari.png', baseline, draft)).toEqual({
            keys: ['title'], previous: { title: 'Title' }, renamed: null,
        });
        expect(state.persona_descriptions['ari.png']).toBe(descriptor);
        expect(descriptor).toMatchObject({ description: 'Later external description', title: 'New title', lorebook: 'Later lore' });
        expect(descriptor.connections).toBe(connections);
        expect(descriptor.extension).toBe(extension);
        expect(descriptor.activeAppendices).toBe(selections);
        expect(descriptor).not.toHaveProperty('unknown');
    });

    test('rename trims the new name and records the live name, not a stale baseline', () => {
        const { state, baseline, draft } = fixture();
        state.personas['ari.png'] = 'External name';
        draft.name = '  New name  ';
        const applied = model.applyDraft(state, 'ari.png', baseline, draft);
        expect(state.personas['ari.png']).toBe('New name');
        expect(applied).toEqual({
            keys: ['name'], previous: { name: 'External name' }, renamed: { oldName: 'External name', newName: 'New name' },
        });
    });

    test('whitespace-only name differences do not report a semantic rename', () => {
        const { state, baseline, draft } = fixture();
        draft.name = ' Ari ';
        expect(model.applyDraft(state, 'ari.png', baseline, draft).renamed).toBeNull();
    });

    test('a missing descriptor receives all defaults only when a descriptor key changes', () => {
        const state = { personas: { 'ari.png': 'Ari' }, persona_descriptions: {} };
        const baseline = model.personaToDraft({ name: 'Ari' });
        const draft = { ...baseline, name: 'New' };
        model.applyDraft(state, 'ari.png', baseline, draft);
        expect(state.persona_descriptions).toEqual({});
        draft.description = 'New description';
        const applied = model.applyDraft(state, 'ari.png', { ...baseline, name: 'New' }, draft);
        expect(applied.previous).toEqual({ description: undefined });
        expect(state.persona_descriptions['ari.png']).toEqual({
            description: 'New description', position: 0, depth: 2, role: 0, lorebook: '',
            connections: [], title: '', appendices: [], activeAppendices: {},
        });
    });

    test('unchanged drafts never create descriptors', () => {
        const state = { personas: { 'ari.png': 'Ari' }, persona_descriptions: {} };
        const draft = model.personaToDraft({ name: 'Ari' });
        expect(model.applyDraft(state, 'ari.png', draft, draft)).toEqual({ keys: [], previous: {}, renamed: null });
        expect(state.persona_descriptions).toEqual({});
    });

    test('note edits prune every roleplay, group, default, and Conversation scope and detach written values', () => {
        const { state, descriptor, baseline, draft } = fixture();
        descriptor.activeAppendices = {
            __default__: ['first', 'second'],
            'friend.png': ['second', 'first'],
            'group-123': ['second'],
            'persona:ari.png:conversation-1': ['second', 'first'],
            'persona:ari.png:conversation-2': [],
            extension: 'preserved',
        };
        draft.appendices = [draft.appendices[0]];
        const applied = model.applyDraft(state, 'ari.png', baseline, draft);
        draft.appendices[0].name = 'Changed after apply';
        baseline.appendices[1].name = 'Changed baseline';
        expect(applied.keys).toEqual(['appendices']);
        expect(descriptor.appendices).toEqual([{ id: 'first', name: 'First', description: 'First note' }]);
        expect(applied.previous.appendices[1].name).toBe('Second');
        expect(descriptor.activeAppendices).toEqual({
            __default__: ['first'], 'friend.png': ['first'], 'group-123': [],
            'persona:ari.png:conversation-1': ['first'], 'persona:ari.png:conversation-2': [], extension: 'preserved',
        });
    });

    test('rollback restores written keys only when another writer has not changed them', () => {
        const { state, descriptor, baseline, draft } = fixture();
        draft.name = 'New';
        draft.title = 'New title';
        draft.description = 'New description';
        const applied = model.applyDraft(state, 'ari.png', baseline, draft);
        descriptor.title = 'Later writer';
        state.personas['ari.png'] = 'Later name';
        expect(model.revertDraft(state, 'ari.png', applied)).toEqual(['description']);
        expect(state.personas['ari.png']).toBe('Later name');
        expect(descriptor).toMatchObject({ title: 'Later writer', description: baseline.description });
    });

    test('rollback restores trimmed renames and removes previously absent keys', () => {
        const { state, descriptor, baseline, draft } = fixture();
        delete descriptor.title;
        draft.name = 'New';
        draft.title = 'New title';
        const applied = model.applyDraft(state, 'ari.png', baseline, draft);
        expect(model.revertDraft(state, 'ari.png', applied)).toEqual(['name', 'title']);
        expect(state.personas['ari.png']).toBe('Ari');
        expect(descriptor).not.toHaveProperty('title');
        expect(model.revertDraft(state, 'ari.png', applied)).toEqual([]);
    });

    test('rollback restores pruned selections per scope without discarding later activation changes', () => {
        const { state, descriptor, baseline, draft } = fixture();
        draft.appendices = [draft.appendices[0]];
        const applied = model.applyDraft(state, 'ari.png', baseline, draft);
        descriptor.activeAppendices['friend.png'] = ['first'];
        descriptor.activeAppendices['new-scope'] = ['first'];
        expect(model.revertDraft(state, 'ari.png', applied)).toEqual(['appendices']);
        expect(descriptor.appendices).toEqual(baseline.appendices);
        expect(descriptor.activeAppendices).toEqual({
            __default__: ['first', 'second'], 'friend.png': ['first'], 'new-scope': ['first'],
        });
    });

    test('rollback never resurrects a descriptor deleted by another writer', () => {
        const { state, baseline, draft } = fixture();
        draft.description = 'New description';
        const applied = model.applyDraft(state, 'ari.png', baseline, draft);
        delete state.persona_descriptions['ari.png'];
        expect(model.revertDraft(state, 'ari.png', applied)).toEqual([]);
        expect(state.persona_descriptions).toEqual({});
    });

    test('a later note writer also wins over rollback of selection pruning', () => {
        const { state, descriptor, baseline, draft } = fixture();
        draft.appendices = [draft.appendices[0]];
        const applied = model.applyDraft(state, 'ari.png', baseline, draft);
        descriptor.appendices = [{ id: 'later', name: 'Later', description: 'Later text' }];
        expect(model.revertDraft(state, 'ari.png', applied)).toEqual([]);
        expect(descriptor.appendices[0].id).toBe('later');
        expect(descriptor.activeAppendices.__default__).toEqual(['first']);
    });
});

describe('persona draft concurrency', () => {
    test('changedKeys compares JSON values and ignores non-draft properties by default', () => {
        expect(model.changedKeys({ title: 'same', description: undefined }, { title: 'same' })).toEqual([]);
        expect(model.changedKeys({ title: 'old', lorebook: 'old' }, { title: 'new', lorebook: 'new' })).toEqual(['title']);
        expect(model.changedKeys({ lorebook: 'old' }, { lorebook: 'new' }, ['lorebook'])).toEqual(['lorebook']);
    });

    test('rebasing clean keys follows live data; dirty keys retain user edits with a fresh baseline', () => {
        const baseline = { title: 'Old title', description: 'Old description', appendices: [] };
        const draft = { ...baseline, title: 'User title' };
        const live = { title: 'Live title', description: 'Live description', appendices: [{ id: 'new' }] };
        expect(model.rebaseKey(live, baseline, draft, 'title')).toBe(false);
        expect(baseline.title).toBe('Live title');
        expect(draft.title).toBe('User title');
        expect(model.rebaseKey(live, baseline, draft, 'description')).toBe(true);
        expect(draft.description).toBe('Live description');
        expect(model.rebaseKey(live, baseline, draft, 'appendices')).toBe(true);
        draft.appendices[0].id = 'draft';
        expect(baseline.appendices).toEqual([{ id: 'new' }]);
        expect(live.appendices).toEqual([{ id: 'new' }]);
    });

    test('rebasing a missing key removes it from baseline and a clean draft', () => {
        const baseline = { title: 'Old' };
        const draft = { title: 'Old' };
        expect(model.rebaseKey({}, baseline, draft, 'title')).toBe(true);
        expect(baseline).toEqual({});
        expect(draft).toEqual({});
    });

    test('externalChanges only reports editable fields', () => {
        expect(model.externalChanges({ title: 'Live', lorebook: 'Live' }, { title: 'Old', lorebook: 'Old' })).toEqual(['title']);
    });

    test('fingerprints sort nested object keys without changing array order or input data', () => {
        const first = { name: 'Ari', appendices: [{ name: 'A', description: 'Text', extra: { z: 1, a: 2 } }] };
        const second = { appendices: [{ extra: { a: 2, z: 1 }, description: 'Text', name: 'A' }], name: 'Ari' };
        expect(model.fingerprint(first)).toBe(model.fingerprint(second));
        expect(Object.keys(first)).toEqual(['name', 'appendices']);
        expect(model.fingerprint({ ids: ['a', 'b'] })).not.toBe(model.fingerprint({ ids: ['b', 'a'] }));
    });
});

describe('acknowledged persona commits', () => {
    test('failed active saves fully restore notes after real legacy projection normalization', async () => {
        const { state, descriptor, baseline, draft } = fixture();
        const previous = structuredClone(descriptor);
        const normalize = legacyAppendixNormalizer();
        const projected = [];
        draft.appendices = [
            { id: 'first', name: ' Renamed ', description: 'Changed' },
            { id: 'first', name: ' Added ', description: 7 },
        ];
        const deps = depsFor(state, {
            isActive: jest.fn(() => true),
            project: jest.fn(() => {
                const before = structuredClone(descriptor.appendices);
                normalize(descriptor);
                projected.push({ before, after: structuredClone(descriptor.appendices) });
            }),
            save: jest.fn(async () => false),
        });
        await expect(model.commit(deps, 'ari.png', baseline, draft)).resolves.toEqual({ ok: false, reason: 'save' });
        expect(descriptor).toEqual(previous);
        expect(deps.project).toHaveBeenCalledTimes(2);
        for (const { before, after } of projected) expect(after).toEqual(before);
        expect(deps.emit).not.toHaveBeenCalled();
    });

    test('real legacy projection still preserves a concurrent note writer after a failed save', async () => {
        const { state, descriptor, baseline, draft } = fixture();
        const normalize = legacyAppendixNormalizer();
        const later = [{ id: 'later', name: 'Later', description: 'External edit' }];
        draft.appendices[0].name = ' My edit ';
        const deps = depsFor(state, {
            isActive: jest.fn(() => true),
            project: jest.fn(() => normalize(descriptor)),
            save: jest.fn(async () => { descriptor.appendices = structuredClone(later); return false; }),
        });
        await expect(model.commit(deps, 'ari.png', baseline, draft)).resolves.toEqual({ ok: false, reason: 'save' });
        expect(descriptor.appendices).toEqual(later);
    });

    test('invalid note names never apply, save, project, or emit', async () => {
        const { state, descriptor, baseline, draft } = fixture();
        const deps = depsFor(state, { isActive: jest.fn(() => true) });
        draft.appendices[0].name = ' ';
        await expect(model.commit(deps, 'ari.png', baseline, draft)).resolves.toEqual({
            ok: false, reason: 'invalid', errors: { appendices: { 0: 'required' } },
        });
        expect(descriptor.appendices).toEqual(baseline.appendices);
        expect(deps.save).not.toHaveBeenCalled();
        expect(deps.project).not.toHaveBeenCalled();
        expect(deps.emit).not.toHaveBeenCalled();
    });

    test('invalid names do not apply, save, project, or emit', async () => {
        const { state, baseline, draft } = fixture();
        const deps = depsFor(state);
        draft.name = ' ';
        await expect(model.commit(deps, 'ari.png', baseline, draft)).resolves.toEqual({
            ok: false, reason: 'invalid', errors: { name: 'required' },
        });
        expect(state.personas['ari.png']).toBe('Ari');
        expect(deps.save).not.toHaveBeenCalled();
        expect(deps.project).not.toHaveBeenCalled();
        expect(deps.emit).not.toHaveBeenCalled();
    });

    test('unchanged drafts are successful without saving or projecting', async () => {
        const { state, baseline, draft } = fixture();
        const deps = depsFor(state, { isActive: jest.fn(() => true) });
        await expect(model.commit(deps, 'ari.png', baseline, draft)).resolves.toEqual({ ok: true, keys: [] });
        expect(deps.save).not.toHaveBeenCalled();
        expect(deps.project).not.toHaveBeenCalled();
        expect(deps.setUserName).not.toHaveBeenCalled();
        expect(deps.emit).not.toHaveBeenCalled();
    });

    test('inactive commits never project or change the active name', async () => {
        const { state, baseline, draft } = fixture();
        const deps = depsFor(state);
        draft.name = 'New';
        await expect(model.commit(deps, 'ari.png', baseline, draft)).resolves.toMatchObject({ ok: true, keys: ['name'] });
        expect(deps.isActive).toHaveBeenCalledWith('ari.png');
        expect(deps.project).not.toHaveBeenCalled();
        expect(deps.setUserName).not.toHaveBeenCalled();
        expect(deps.save).toHaveBeenCalledTimes(1);
    });

    test('active commits apply, project, rename, save, then emit updated and renamed in order', async () => {
        const { state, baseline, draft } = fixture();
        const order = [];
        draft.name = ' New ';
        draft.description = 'New description';
        const deps = depsFor(state, {
            isActive: jest.fn(() => true),
            project: jest.fn(() => { order.push(`project:${state.persona_descriptions['ari.png'].description}`); }),
            setUserName: jest.fn(name => { order.push(`name:${name}`); }),
            save: jest.fn(async () => { order.push('save'); return true; }),
            emit: jest.fn(async event => { order.push(event); }),
        });
        await expect(model.commit(deps, 'ari.png', baseline, draft)).resolves.toEqual({
            ok: true, keys: ['name', 'description'], renamed: { oldName: 'Ari', newName: 'New' },
        });
        expect(order).toEqual(['project:New description', 'name:New', 'save', 'updated', 'renamed']);
        expect(deps.emit).toHaveBeenNthCalledWith(1, 'updated', 'ari.png');
        expect(deps.emit).toHaveBeenNthCalledWith(2, 'renamed', { avatarId: 'ari.png', oldName: 'Ari', newName: 'New' });
    });

    test('content-only commits project without renaming and emit only updated', async () => {
        const { state, baseline, draft } = fixture();
        const deps = depsFor(state, { isActive: jest.fn(() => true) });
        draft.title = 'New title';
        await expect(model.commit(deps, 'ari.png', baseline, draft)).resolves.toEqual({ ok: true, keys: ['title'], renamed: null });
        expect(deps.project).toHaveBeenCalledTimes(1);
        expect(deps.setUserName).not.toHaveBeenCalled();
        expect(deps.emit).toHaveBeenCalledTimes(1);
    });

    test('failed saves revert keys and active projection, restore the name, and emit nothing', async () => {
        const { state, descriptor, baseline, draft } = fixture();
        const deps = depsFor(state, { isActive: jest.fn(() => true), save: jest.fn(async () => false) });
        draft.name = 'New';
        draft.description = 'New description';
        draft.appendices = [];
        await expect(model.commit(deps, 'ari.png', baseline, draft)).resolves.toEqual({ ok: false, reason: 'save' });
        expect(state.personas['ari.png']).toBe('Ari');
        expect(descriptor.description).toBe('Base description');
        expect(descriptor.appendices).toEqual(baseline.appendices);
        expect(descriptor.activeAppendices.__default__).toEqual(['first', 'second']);
        expect(deps.project).toHaveBeenCalledTimes(2);
        expect(deps.setUserName.mock.calls).toEqual([['New'], ['Ari']]);
        expect(deps.emit).not.toHaveBeenCalled();
    });

    test('inactive save failure preserves later writes and never projects', async () => {
        const { state, descriptor, baseline, draft } = fixture();
        draft.description = 'My edit';
        const deps = depsFor(state, {
            save: jest.fn(async () => { descriptor.description = 'Later writer'; return false; }),
        });
        await expect(model.commit(deps, 'ari.png', baseline, draft)).resolves.toEqual({ ok: false, reason: 'save' });
        expect(descriptor.description).toBe('Later writer');
        expect(deps.project).not.toHaveBeenCalled();
        expect(deps.setUserName).not.toHaveBeenCalled();
    });

    test('throwing saves are failed receipts with the error retained', async () => {
        const { state, descriptor, baseline, draft } = fixture();
        const error = new Error('Offline');
        const deps = depsFor(state, { save: jest.fn().mockRejectedValue(error) });
        draft.title = 'New title';
        await expect(model.commit(deps, 'ari.png', baseline, draft)).resolves.toEqual({ ok: false, reason: 'save', error });
        expect(descriptor.title).toBe('Title');
        expect(deps.emit).not.toHaveBeenCalled();
    });

    test('a persona switched away during a failed save is not re-projected', async () => {
        const { state, baseline, draft } = fixture();
        let active = true;
        const deps = depsFor(state, {
            isActive: jest.fn(() => active),
            save: jest.fn(async () => { active = false; return false; }),
        });
        draft.name = 'New';
        await model.commit(deps, 'ari.png', baseline, draft);
        expect(state.personas['ari.png']).toBe('Ari');
        expect(deps.project).toHaveBeenCalledTimes(1);
        expect(deps.setUserName.mock.calls).toEqual([['New']]);
    });

    test('listener errors cannot turn a saved commit into failure or skip the remaining event', async () => {
        const { state, baseline, draft } = fixture();
        const deps = depsFor(state, { emit: jest.fn().mockRejectedValue(new Error('Listener failed')) });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        draft.name = 'New';
        try {
            await expect(model.commit(deps, 'ari.png', baseline, draft)).resolves.toMatchObject({ ok: true });
            expect(state.personas['ari.png']).toBe('New');
            expect(deps.emit).toHaveBeenCalledTimes(2);
            expect(warn).toHaveBeenCalledTimes(2);
        } finally {
            warn.mockRestore();
        }
    });
});

function createApi(overrides = {}, legacyFunctions = []) {
    const { state } = fixture();
    const dom = { toggleClass: jest.fn(), val: jest.fn(), trigger: jest.fn(), text: jest.fn() };
    const context = {
        power_user: state,
        user_avatar: 'active.png',
        selected_group: null,
        characters: [{ avatar: 'friend.png' }],
        this_chid: 0,
        name2: 'Friend',
        DEFAULT_DEPTH: 2,
        DEFAULT_ROLE: 0,
        PERSONA_APPENDICES_DEFAULT_SCOPE_KEY: '__default__',
        PERSONA_APPENDICES_SELECTIONS_KEY: 'activeAppendices',
        PERSONA_APPENDICES_METADATA_KEY: 'persona_appendices',
        chat_metadata: {},
        persona_description_positions: model.PERSONA_POSITION,
        default_user_avatar: 'default.png',
        normalizePersonaAppendices: jest.fn(),
        getUserAvatars: jest.fn(async () => ['ari.png']),
        addMissingPersonas: jest.fn(async () => {}),
        getPersonaStates: jest.fn(() => ({ default: true, locked: { chat: false, character: true } })),
        syncPersonaDescriptionFromDescriptor: jest.fn(),
        countPersonaDescriptionTokens: jest.fn(),
        updatePersonaUIStates: jest.fn(),
        updatePersonaConnectionsAvatarList: jest.fn(),
        saveSettings: jest.fn(async () => true),
        saveSettingsDebounced: jest.fn(),
        setUserName: jest.fn(),
        setUserAvatar: jest.fn(async () => {}),
        toggleDefaultPersona: jest.fn(async () => {}),
        lockPersona: jest.fn(async () => {}),
        unlockPersona: jest.fn(async () => {}),
        setActivePersonaAppendixIds: jest.fn(async () => {}),
        getCurrentConnectionObj: jest.fn(() => ({ type: 'character', id: 'friend.png' })),
        initPersona: jest.fn(async () => {}),
        uploadUserAvatar: jest.fn(async () => {}),
        duplicatePersona: jest.fn(async () => 'copy.png'),
        deletePersona: jest.fn(async () => true),
        eventSource: { emit: jest.fn(async () => {}) },
        event_types: { PERSONA_UPDATED: 'updated', PERSONA_RENAMED: 'renamed' },
        $: jest.fn(() => dom),
        console: { warn: jest.fn() },
        personaEditorAdapter: null,
        t: strings => strings.join(''),
        ...overrides,
    };
    const start = personaSource.indexOf('// #region SillyBunny persona editor adapter and data API');
    const end = personaSource.indexOf('// #endregion', start);
    const apiSource = personaSource.slice(start, end).replace(/^export /gm, '');
    runInNewContext([apiSource, ...legacyFunctions.map(functionSource)].join('\n'), context);
    return { api: context, state: context.power_user, dom };
}

describe('targetable persona API', () => {
    test('record reads normalize live notes but never create absent descriptors or personas', () => {
        const { api, state } = createApi();
        const record = api.getPersonaRecord('ari.png');
        expect(record).toEqual({ avatarId: 'ari.png', name: 'Ari', descriptor: state.persona_descriptions['ari.png'] });
        expect(record.descriptor).toBe(state.persona_descriptions['ari.png']);
        expect(api.normalizePersonaAppendices).toHaveBeenCalledWith(record.descriptor);
        expect(api.getPersonaRecord('absent.png')).toBeNull();
        delete state.persona_descriptions['ari.png'];
        expect(api.getPersonaRecord('ari.png').descriptor).toBeUndefined();
        expect(state.persona_descriptions).toEqual({});
    });

    test('record reads run legacy note normalization before returning', () => {
        const { api, state } = createApi({}, ['normalizePersonaAppendices', 'normalizePersonaAppendixSelections', 'createPersonaAppendixId']);
        state.persona_descriptions['ari.png'].appendices = [
            { id: 'same', name: ' First ', description: 1 },
            { id: 'same', name: 'Second' },
        ];
        const { descriptor } = api.getPersonaRecord('ari.png');
        expect(descriptor.appendices).toEqual([
            { id: 'same', name: 'First', description: '1' },
            { id: 'same-1', name: 'Second', description: '' },
        ]);
        expect(descriptor.activeAppendices.__default__).toEqual([]);
    });

    test('listing fetches without rendering and applies missing-persona initialization', async () => {
        const { api } = createApi();
        await expect(api.listPersonaAvatars()).resolves.toEqual(['ari.png']);
        expect(api.getUserAvatars).toHaveBeenCalledWith(false, '', { strict: true });
        expect(api.addMissingPersonas).toHaveBeenCalledWith(['ari.png']);
    });

    test('listing accepts a genuinely empty library', async () => {
        const { api } = createApi({ getUserAvatars: jest.fn(async () => []) });
        await expect(api.listPersonaAvatars()).resolves.toEqual([]);
    });

    test.each([undefined, null, {}])('listing rejects a failed response %p instead of caching an empty library', async value => {
        const { api } = createApi({ getUserAvatars: jest.fn(async () => value) });
        await expect(api.listPersonaAvatars()).rejects.toThrow();
        expect(api.addMissingPersonas).not.toHaveBeenCalled();
    });

    test('listing handles fetch rejection', async () => {
        const error = new Error('Offline');
        const { api } = createApi({ getUserAvatars: jest.fn().mockRejectedValue(error) });
        await expect(api.listPersonaAvatars()).rejects.toBe(error);
    });

    test('states wrap the legacy state and add in-use without exposing another schema', () => {
        const { api } = createApi();
        expect(api.getPersonaEditorStates('ari.png')).toEqual({ inUse: false, default: true, locked: { chat: false, character: true } });
        expect(api.getPersonaEditorStates('active.png').inUse).toBe(true);
        expect(api.getPersonaStates).toHaveBeenCalledWith('ari.png');
    });

    test.each([
        [null, [{ avatar: 'friend.png' }], { key: 'friend.png', kind: 'character' }],
        ['group-1', [{ avatar: 'friend.png' }], { key: 'group-1', kind: 'group' }],
        [null, [], { key: '__default__', kind: 'default' }],
    ])('scope uses the existing roleplay scope for group %p and characters %p', (selected_group, characters, expected) => {
        const { api } = createApi({ selected_group, characters }, ['getPersonaAppendixScopeKey']);
        expect(api.getPersonaAppendixScope()).toEqual(expected);
    });

    test('projection reads only the active descriptor without saving, renaming, or locking', () => {
        const { api, state, dom } = createApi({ user_avatar: 'ari.png' });
        state.persona_descriptions['ari.png'].position = 4;
        state.persona_descriptions['ari.png'].depth = 8;
        state.persona_descriptions['ari.png'].role = 2;
        api.projectActivePersona();
        expect(state).toMatchObject({
            persona_description_position: 4, persona_description_depth: 8, persona_description_role: 2,
            persona_description_lorebook: 'Lore',
        });
        expect(api.syncPersonaDescriptionFromDescriptor).toHaveBeenCalledTimes(1);
        expect(dom.toggleClass).toHaveBeenCalledWith('world_set', true);
        expect(api.saveSettingsDebounced).not.toHaveBeenCalled();
        expect(api.setUserName).not.toHaveBeenCalled();
        expect(api.lockPersona).not.toHaveBeenCalled();
        expect(api.eventSource.emit).not.toHaveBeenCalled();
    });

    test('projection migrates the deprecated after-character position on the global only', () => {
        const { api, state } = createApi({ user_avatar: 'ari.png' });
        state.persona_descriptions['ari.png'].position = 1;
        api.projectActivePersona();
        expect(state.persona_description_position).toBe(0);
        expect(state.persona_descriptions['ari.png'].position).toBe(1);
    });

    test('projection uses defaults without creating an active descriptor', () => {
        const { api, state, dom } = createApi();
        api.projectActivePersona();
        expect(state).toMatchObject({
            persona_description_position: 0, persona_description_depth: 2, persona_description_role: 0,
            persona_description_lorebook: '',
        });
        expect(state.persona_descriptions).not.toHaveProperty('active.png');
        expect(dom.toggleClass).toHaveBeenCalledWith('world_set', false);
    });

    test('the model and API recompose active prompt text from the base and scoped notes on save', async () => {
        const { api, state } = createApi({ user_avatar: 'ari.png' }, [
            'syncPersonaDescriptionFromDescriptor', 'composePersonaDescription', 'getActivePersonaAppendices',
            'getActivePersonaAppendixIds', 'getPersonaAppendices', 'getLegacyPersonaAppendicesMetadata',
            'normalizePersonaAppendices', 'normalizePersonaAppendixSelections', 'createPersonaAppendixId',
            'getPersonaAppendixScopeKey',
        ]);
        const record = api.getPersonaRecord('ari.png');
        const baseline = model.personaToDraft(record);
        const draft = { ...baseline, description: 'Updated base' };
        await expect(model.commit(api.getPersonaModelDeps(), 'ari.png', baseline, draft)).resolves.toMatchObject({ ok: true });
        expect(state.persona_description).toBe('Updated base\n\n(Second)\nSecond note');
        expect(state.persona_descriptions['ari.png'].description).toBe('Updated base');
        expect(api.saveSettings).toHaveBeenCalledWith(0, { returnResult: true });
    });

    test.each([true, false, undefined])('immediate save returns the acknowledged result for %p', async result => {
        const { api } = createApi({ saveSettings: jest.fn(async () => result) });
        await expect(api.savePersonaSettingsNow()).resolves.toBe(Boolean(result));
        expect(api.saveSettings).toHaveBeenCalledWith(0, { returnResult: true });
    });

    test('immediate save catches errors', async () => {
        const { api } = createApi({ saveSettings: jest.fn().mockRejectedValue(new Error('Offline')) });
        await expect(api.savePersonaSettingsNow()).resolves.toBe(false);
    });

    test('use and lock APIs delegate without changing their target', async () => {
        const { api } = createApi();
        await api.usePersona('ari.png');
        expect(api.setUserAvatar).toHaveBeenCalledWith('ari.png');
        await expect(api.setPersonaChatLock('ari.png', true)).resolves.toBe(false);
        expect(api.lockPersona).not.toHaveBeenCalled();
        await expect(api.setPersonaChatLock('active.png', true)).resolves.toBe(true);
        expect(api.lockPersona).toHaveBeenCalledWith('chat');
        await expect(api.setPersonaChatLock('active.png', false)).resolves.toBe(true);
        expect(api.unlockPersona).toHaveBeenCalledWith('chat');
    });

    test('default is an idempotent setter using the legacy quiet path', async () => {
        const { api, state } = createApi();
        await api.setPersonaDefault('ari.png', false);
        expect(api.toggleDefaultPersona).not.toHaveBeenCalled();
        await api.setPersonaDefault('ari.png', true);
        expect(api.toggleDefaultPersona).toHaveBeenCalledWith('ari.png', { quiet: true });
        state.default_persona = 'ari.png';
        api.toggleDefaultPersona.mockClear();
        await api.setPersonaDefault('ari.png', true);
        expect(api.toggleDefaultPersona).not.toHaveBeenCalled();
        await api.setPersonaDefault('ari.png', false);
        expect(api.toggleDefaultPersona).toHaveBeenCalledWith('ari.png', { quiet: true });
    });

    test('connections target an inactive persona, return unlinked ids, and preserve other connections', async () => {
        const { api, state } = createApi();
        state.personas['other.png'] = 'Other';
        state.persona_descriptions['other.png'] = {
            connections: [{ type: 'character', id: 'friend.png' }, { type: 'group', id: 'friend.png' }],
        };
        state.persona_descriptions['ari.png'].connections = [{ type: 'character', id: 'else.png' }];
        await expect(api.setPersonaCharacterConnection('ari.png', true)).resolves.toEqual({ ok: true, unlinked: ['other.png'] });
        expect(state.persona_descriptions['ari.png'].connections).toEqual([
            { type: 'character', id: 'else.png' }, { type: 'character', id: 'friend.png' },
        ]);
        expect(state.persona_descriptions['other.png'].connections).toEqual([{ type: 'group', id: 'friend.png' }]);
        expect(api.saveSettingsDebounced).toHaveBeenCalledTimes(1);
        expect(api.eventSource.emit).not.toHaveBeenCalled();
        await expect(api.setPersonaCharacterConnection('ari.png', false)).resolves.toEqual({ ok: true, unlinked: [] });
        expect(state.persona_descriptions['ari.png'].connections).toEqual([{ type: 'character', id: 'else.png' }]);
    });

    test('multiple-connection mode preserves links on other personas', async () => {
        const { api, state } = createApi();
        state.persona_allow_multi_connections = true;
        state.persona_descriptions['other.png'] = { connections: [{ type: 'character', id: 'friend.png' }] };
        await expect(api.setPersonaCharacterConnection('ari.png', true)).resolves.toEqual({ ok: true, unlinked: [] });
        expect(state.persona_descriptions['other.png'].connections).toHaveLength(1);
    });

    test('connections require an existing persona and a current character or group', async () => {
        const { api } = createApi();
        await expect(api.setPersonaCharacterConnection('absent.png', true)).resolves.toEqual({ ok: false, unlinked: [] });
        api.getCurrentConnectionObj.mockReturnValue(null);
        await expect(api.setPersonaCharacterConnection('ari.png', true)).resolves.toEqual({ ok: false, unlinked: [] });
        expect(api.saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('one connection can be removed without affecting another type with the same id', async () => {
        const { api, state } = createApi();
        state.persona_descriptions['ari.png'].connections.push({ type: 'group', id: 'friend.png' });
        await expect(api.removePersonaConnection('ari.png', { type: 'character', id: 'friend.png' })).resolves.toBe(true);
        expect(state.persona_descriptions['ari.png'].connections).toEqual([{ type: 'group', id: 'friend.png' }]);
        expect(api.saveSettingsDebounced).toHaveBeenCalledTimes(1);
        expect(api.eventSource.emit).not.toHaveBeenCalled();
    });

    test('lorebook changes create a descriptor only for existing personas and leave inactive globals alone', async () => {
        const { api, state, dom } = createApi();
        delete state.persona_descriptions['ari.png'];
        await expect(api.setPersonaLorebook('absent.png', 'New lore')).resolves.toBe(false);
        await expect(api.setPersonaLorebook('ari.png', 'New lore')).resolves.toBe(true);
        expect(state.persona_descriptions['ari.png'].lorebook).toBe('New lore');
        expect(state.persona_description_lorebook).toBeUndefined();
        expect(dom.toggleClass).not.toHaveBeenCalled();
        expect(api.eventSource.emit).toHaveBeenCalledWith('updated', 'ari.png');
        api.user_avatar = 'ari.png';
        await api.setPersonaLorebook('ari.png', '');
        expect(state.persona_description_lorebook).toBe('');
        expect(dom.toggleClass).toHaveBeenCalledWith('world_set', false);
    });

    test('activation, duplication, deletion and image change delegate to legacy data paths', async () => {
        const { api, dom } = createApi();
        await api.setPersonaAppendicesActive('ari.png', ['first']);
        expect(api.setActivePersonaAppendixIds).toHaveBeenCalledWith('ari.png', ['first']);
        await expect(api.duplicatePersonaRecord('ari.png')).resolves.toBe('copy.png');
        expect(api.duplicatePersona).toHaveBeenCalledWith('ari.png', { silent: true });
        await expect(api.deletePersonaRecord('ari.png')).resolves.toBe(true);
        expect(api.deletePersona).toHaveBeenCalledWith('ari.png');
        api.changePersonaImage('ari.png');
        expect(api.$.mock.calls).toEqual([['#avatar_upload_overwrite'], ['#avatar_upload_file']]);
        expect(dom.val).toHaveBeenCalledWith('ari.png');
        expect(dom.trigger).toHaveBeenCalledWith('click');
    });

    test('provisional cleanup can delete silently through the legacy API', async () => {
        const { api } = createApi();
        await expect(api.deletePersonaRecord('ari.png', { silent: true })).resolves.toBe(true);
        expect(api.deletePersona).toHaveBeenCalledWith('ari.png', { silent: true });
    });

    test('creation uses the legacy id scheme and default avatar, without activation', async () => {
        const { api } = createApi({ Date: { now: () => 123 } });
        await expect(api.createPersonaRecord({ name: ' Ari! ', title: 'Title', description: 'Text' })).resolves.toBe('123-Ari.png');
        expect(api.initPersona).toHaveBeenCalledWith('123-Ari.png', 'Ari!', 'Text', 'Title');
        expect(api.uploadUserAvatar).toHaveBeenCalledWith('default.png', '123-Ari.png');
        expect(api.setUserAvatar).not.toHaveBeenCalled();
        await expect(api.createPersonaRecord({ name: ' ' })).resolves.toBe('');
        api.uploadUserAvatar.mockRejectedValue(new Error('Offline'));
        await expect(api.createPersonaRecord({ name: 'Ari' })).resolves.toBe('');
    });

    test('dependency adapter supplies active projection, acknowledged saves, and the existing event bus', async () => {
        const { api, state } = createApi();
        const deps = api.getPersonaModelDeps();
        expect(deps.state).toBe(state);
        expect(deps.isActive('ari.png')).toBe(false);
        expect(deps.isActive('active.png')).toBe(true);
        expect(deps.project).toBe(api.projectActivePersona);
        expect(deps.setUserName).toBe(api.setUserName);
        expect(deps.save).toBe(api.savePersonaSettingsNow);
        expect(deps.events).toEqual({ PERSONA_UPDATED: 'updated', PERSONA_RENAMED: 'renamed' });
        await deps.emit('updated', 'ari.png');
        expect(api.eventSource.emit).toHaveBeenCalledWith('updated', 'ari.png');
    });
});

describe('inert persona editor adapter hooks', () => {
    test('visibility uses the legacy drawer by default and returns to it when the adapter is cleared', () => {
        const panel = { classList: { contains: jest.fn(() => true) }, getClientRects: () => [1] };
        const document = { getElementById: jest.fn(() => panel) };
        const { api } = createApi({ document }, ['isPersonaPanelOpen']);
        expect(api.isPersonaPanelOpen()).toBe(true);
        const adapter = { isOpen: jest.fn(() => 0), refresh: jest.fn() };
        api.setPersonaEditorAdapter(adapter);
        expect(api.isPersonaPanelOpen()).toBe(false);
        expect(document.getElementById).toHaveBeenCalledTimes(1);
        api.setPersonaEditorAdapter(null);
        expect(api.isPersonaPanelOpen()).toBe(true);
        expect(document.getElementById).toHaveBeenCalledTimes(2);
    });

    test('a mounted adapter suppresses legacy layout and redirects state refreshes before navigation or DOM work', () => {
        const { api } = createApi({}, ['updatePersonaUIStates', 'switchPersonaGridView']);
        const adapter = { isOpen: () => true, refresh: jest.fn() };
        api.setPersonaEditorAdapter(adapter);
        api.updatePersonaUIStates({ navigateToCurrent: true });
        api.switchPersonaGridView();
        expect(adapter.refresh).toHaveBeenCalledWith('states');
        expect(api.$).not.toHaveBeenCalled();
    });

    test('avatar fetching still normalizes missing personas but skips the legacy render pipeline', async () => {
        const { api } = createApi({
            fetch: jest.fn(async () => ({ ok: true, json: async () => ['ari.png', 'other.png'] })),
            getRequestHeaders: jest.fn(() => ({})),
        }, ['getUserAvatars']);
        const adapter = { isOpen: () => true, refresh: jest.fn() };
        api.setPersonaEditorAdapter(adapter);
        await expect(api.getUserAvatars()).resolves.toEqual(['ari.png', 'other.png']);
        expect(api.addMissingPersonas).toHaveBeenCalledWith(['ari.png', 'other.png']);
        expect(adapter.refresh).toHaveBeenCalledWith('list');
        expect(api.$).not.toHaveBeenCalled();
        adapter.refresh.mockClear();
        api.addMissingPersonas.mockClear();
        await expect(api.getUserAvatars(false)).resolves.toEqual(['ari.png', 'other.png']);
        expect(adapter.refresh).not.toHaveBeenCalled();
        expect(api.addMissingPersonas).not.toHaveBeenCalled();
    });

    test('the pre-existing non-OK avatar response still returns undefined', async () => {
        const { api } = createApi({
            fetch: jest.fn(async () => ({ ok: false })), getRequestHeaders: jest.fn(() => ({})),
        }, ['getUserAvatars']);
        await expect(api.getUserAvatars()).resolves.toBeUndefined();
    });

    test('persona events notify the adapter for inactive records while keeping active data sync', () => {
        const callbacks = new Map();
        const context = {
            personaEditorAdapter: { refresh: jest.fn() },
            event_types: { PERSONA_UPDATED: 'updated' },
            eventSource: { on: (event, callback) => callbacks.set(event, callback) },
            user_avatar: 'active.png',
            syncPersonaDescriptionFromDescriptor: jest.fn(),
        };
        const listener = personaSource.match(/[ ]{4}eventSource\.on\(event_types\.PERSONA_UPDATED, \(avatarId\) => \{[\s\S]*?^[ ]{4}\}\);/m)[0];
        runInNewContext(listener, context);
        callbacks.get('updated')('ari.png');
        expect(context.personaEditorAdapter.refresh).toHaveBeenCalledWith('persona', 'ari.png');
        expect(context.syncPersonaDescriptionFromDescriptor).not.toHaveBeenCalled();
        callbacks.get('updated')('active.png');
        expect(context.syncPersonaDescriptionFromDescriptor).toHaveBeenCalledTimes(1);
        context.personaEditorAdapter = null;
        callbacks.get('updated')('active.png');
        expect(context.syncPersonaDescriptionFromDescriptor).toHaveBeenCalledTimes(2);
    });
});
