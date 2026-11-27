/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Parameterised Jest/jsdom tests. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as model from '../../public/scripts/sillybunny-persona-model.js';
import { importPersonasModule } from '../util/personas-module-harness.js';

const indexSource = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

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

async function setupPersonas(overrides = {}) {
    document.body.innerHTML = `
        <div id="PersonaManagement" class="openDrawer"></div>
        <div id="user_avatar_block"></div>
        <button id="persona_lore_button"></button>
        <button id="persona_grid_toggle"></button>
        <input id="avatar_upload_overwrite" />
        <input id="avatar_upload_file" type="file" />
        <input id="persona_description" />
    `;
    const panel = document.getElementById('PersonaManagement');
    panel.getClientRects = () => [{}];

    const { state } = fixture();
    const power_user = {
        ...state,
        default_persona: '',
        persona_allow_multi_connections: false,
        persona_show_notifications: false,
        persona_sort_order: 'asc',
        ...(overrides.power_user ?? {}),
    };
    const serverAvatars = ['ari.png'];
    const fetchMock = overrides.fetch ?? jest.fn(async (url, init) => {
        if (url === '/api/avatars/get') {
            return { ok: true, json: async () => [...serverAvatars] };
        }
        if (url === '/api/avatars/upload') {
            return { ok: true, json: async () => ({ path: 'copy.png' }) };
        }
        if (url === '/api/avatars/delete') {
            const payload = JSON.parse(init?.body || '{}');
            const idx = serverAvatars.indexOf(payload.avatar);
            if (idx >= 0) serverAvatars.splice(idx, 1);
            return { ok: true, json: async () => ({ ok: true }) };
        }
        return {
            ok: true,
            blob: async () => new Blob(['img'], { type: 'image/png' }),
            json: async () => ({ ok: true }),
        };
    });

    const loaded = await importPersonasModule({
        power_user,
        characters: overrides.characters ?? [{ avatar: 'friend.png', name: 'Friend' }],
        this_chid: overrides.this_chid ?? 0,
        selected_group: overrides.selected_group ?? null,
        name2: overrides.name2 ?? 'Friend',
        default_user_avatar: overrides.default_user_avatar ?? 'default.png',
        chat_metadata: overrides.chat_metadata ?? {},
        fetch: fetchMock,
        script: overrides.script,
        popup: overrides.popup,
        deleteConfirm: overrides.deleteConfirm,
        accountStorage: overrides.accountStorage,
    });
    loaded.personas.initUserAvatar(overrides.user_avatar ?? 'active.png');
    return loaded;
}

afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

describe('persona schema parity', () => {
    test('positions match the legacy enum and role/depth defaults stay fixed', async () => {
        const { personas } = await setupPersonas();
        expect(model.PERSONA_POSITION).toEqual(personas.persona_description_positions);
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

    test.each(['Hello, World!', '---', 'é日本語', 'a'.repeat(70), ' An_Appendix '])(
        'appendix id slug matches legacy normalizer for %p', async name => {
            const clock = jest.spyOn(Date, 'now').mockReturnValue(123);
            try {
                const { personas, state } = await setupPersonas();
                state.power_user.persona_descriptions['ari.png'].appendices = [{ name }];
                const normalized = personas.getPersonaRecord('ari.png').descriptor.appendices;
                expect(`${model.createAppendixId(name, 123)}-0`).toBe(normalized[0].id);
            } finally {
                clock.mockRestore();
            }
        },
    );

    test.each(['', undefined])('appendix id falls back to "appendix" for blank %p', name => {
        expect(model.createAppendixId(name, 123)).toBe('appendix-123');
    });
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
    test('note receipts canonicalize previous and written notes exactly like the legacy normalizer', async () => {
        const clock = jest.spyOn(Date, 'now').mockReturnValue(123);
        try {
            const { personas, state: legacyState } = await setupPersonas();
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

            legacyState.power_user.persona_descriptions['ari.png'].appendices = structuredClone(notes);
            const expectedPrevious = structuredClone(personas.getPersonaRecord('ari.png').descriptor.appendices);
            legacyState.power_user.persona_descriptions['ari.png'].appendices = structuredClone(draft.appendices);
            const expectedWritten = structuredClone(personas.getPersonaRecord('ari.png').descriptor.appendices);

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
        const { personas, state } = await setupPersonas({ user_avatar: 'ari.png' });
        const descriptor = state.power_user.persona_descriptions['ari.png'];
        const baseline = model.personaToDraft({ name: 'Ari', descriptor });
        const draft = structuredClone(baseline);
        const previous = structuredClone(descriptor);
        const projected = [];
        draft.appendices = [
            { id: 'first', name: ' Renamed ', description: 'Changed' },
            { id: 'first', name: ' Added ', description: 7 },
        ];
        const deps = depsFor(state.power_user, {
            isActive: jest.fn(() => true),
            project: jest.fn(() => {
                const before = structuredClone(descriptor.appendices);
                personas.projectActivePersona();
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
        const { personas, state } = await setupPersonas({ user_avatar: 'ari.png' });
        const descriptor = state.power_user.persona_descriptions['ari.png'];
        const baseline = model.personaToDraft({ name: 'Ari', descriptor });
        const draft = structuredClone(baseline);
        const later = [{ id: 'later', name: 'Later', description: 'External edit' }];
        draft.appendices[0].name = ' My edit ';
        const deps = depsFor(state.power_user, {
            isActive: jest.fn(() => true),
            project: jest.fn(() => personas.projectActivePersona()),
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

describe('targetable persona API', () => {
    test('record reads normalize live notes but never create absent descriptors or personas', async () => {
        const { personas, state } = await setupPersonas();
        state.power_user.persona_descriptions['ari.png'].appendices = [
            { id: 'same', name: ' First ', description: 1 },
            { id: 'same', name: 'Second' },
        ];
        const record = personas.getPersonaRecord('ari.png');
        expect(record).toEqual({ avatarId: 'ari.png', name: 'Ari', descriptor: state.power_user.persona_descriptions['ari.png'] });
        expect(record.descriptor).toBe(state.power_user.persona_descriptions['ari.png']);
        expect(record.descriptor.appendices).toEqual([
            { id: 'same', name: 'First', description: '1' },
            { id: 'same-1', name: 'Second', description: '' },
        ]);
        expect(record.descriptor.activeAppendices.__default__).toEqual([]);
        expect(personas.getPersonaRecord('absent.png')).toBeNull();
        delete state.power_user.persona_descriptions['ari.png'];
        expect(personas.getPersonaRecord('ari.png').descriptor).toBeUndefined();
        expect(state.power_user.persona_descriptions).toEqual({});
    });

    test('listing fetches without rendering and applies missing-persona initialization', async () => {
        const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ['ari.png', 'missing.png'] }));
        const { personas, state } = await setupPersonas({ fetch: fetchMock });
        await expect(personas.listPersonaAvatars()).resolves.toEqual(['ari.png', 'missing.png']);
        expect(fetchMock).toHaveBeenCalledWith('/api/avatars/get', expect.objectContaining({ method: 'POST' }));
        expect(state.power_user.personas['missing.png']).toBe('[Unnamed Persona]');
    });

    test('listing accepts a genuinely empty library', async () => {
        const { personas } = await setupPersonas({
            fetch: jest.fn(async () => ({ ok: true, json: async () => [] })),
        });
        await expect(personas.listPersonaAvatars()).resolves.toEqual([]);
    });

    test.each([undefined, null, {}])('listing rejects a failed response %p instead of caching an empty library', async value => {
        const { personas, state } = await setupPersonas({
            fetch: jest.fn(async () => (value === undefined ? { ok: false } : { ok: true, json: async () => value })),
        });
        const before = { ...state.power_user.personas };
        await expect(personas.listPersonaAvatars()).rejects.toThrow();
        expect(state.power_user.personas).toEqual(before);
    });

    test('listing handles fetch rejection', async () => {
        const error = new Error('Offline');
        const { personas } = await setupPersonas({
            fetch: jest.fn().mockRejectedValue(error),
        });
        await expect(personas.listPersonaAvatars()).rejects.toBe(error);
    });

    test('states wrap the legacy state and add in-use without exposing another schema', async () => {
        const { personas, state } = await setupPersonas({ user_avatar: 'active.png' });
        state.power_user.default_persona = 'ari.png';
        expect(personas.getPersonaEditorStates('ari.png')).toEqual({
            inUse: false, default: true, locked: { chat: false, character: true },
        });
        expect(personas.getPersonaEditorStates('active.png').inUse).toBe(true);
    });

    test.each([
        [null, [{ avatar: 'friend.png' }], 0, { key: 'friend.png', kind: 'character' }],
        ['group-1', [{ avatar: 'friend.png' }], 0, { key: 'group-1', kind: 'group' }],
        [null, [], undefined, { key: '__default__', kind: 'default' }],
    ])('scope uses the existing roleplay scope for group %p and characters %p', async (selected_group, characters, this_chid, expected) => {
        const { personas } = await setupPersonas({ selected_group, characters, this_chid });
        expect(personas.getPersonaAppendixScope()).toEqual(expected);
    });

    test('projection reads only the active descriptor without saving, renaming, or locking', async () => {
        const { personas, state, mocks, eventSource } = await setupPersonas({ user_avatar: 'ari.png' });
        const emitSpy = jest.spyOn(eventSource, 'emit');
        state.power_user.persona_descriptions['ari.png'].position = 4;
        state.power_user.persona_descriptions['ari.png'].depth = 8;
        state.power_user.persona_descriptions['ari.png'].role = 2;
        personas.projectActivePersona();
        expect(state.power_user).toMatchObject({
            persona_description_position: 4,
            persona_description_depth: 8,
            persona_description_role: 2,
            persona_description_lorebook: 'Lore',
            persona_description: 'Base description\n\n(Second)\nSecond note',
        });
        expect(document.getElementById('persona_lore_button').classList.contains('world_set')).toBe(true);
        expect(mocks.script.saveSettingsDebounced).not.toHaveBeenCalled();
        expect(mocks.script.setUserName).not.toHaveBeenCalled();
        expect(emitSpy).not.toHaveBeenCalled();
    });

    test('projection migrates the deprecated after-character position on the global only', async () => {
        const { personas, state } = await setupPersonas({ user_avatar: 'ari.png' });
        state.power_user.persona_descriptions['ari.png'].position = 1;
        personas.projectActivePersona();
        expect(state.power_user.persona_description_position).toBe(0);
        expect(state.power_user.persona_descriptions['ari.png'].position).toBe(1);
    });

    test('projection uses defaults without creating an active descriptor', async () => {
        const { personas, state } = await setupPersonas({ user_avatar: 'active.png' });
        personas.projectActivePersona();
        expect(state.power_user).toMatchObject({
            persona_description_position: 0,
            persona_description_depth: 2,
            persona_description_role: 0,
            persona_description_lorebook: '',
        });
        expect(state.power_user.persona_descriptions).not.toHaveProperty('active.png');
        expect(document.getElementById('persona_lore_button').classList.contains('world_set')).toBe(false);
    });

    test('the model and API recompose active prompt text from the base and scoped notes on save', async () => {
        const { personas, state, mocks } = await setupPersonas({ user_avatar: 'ari.png' });
        const record = personas.getPersonaRecord('ari.png');
        const baseline = model.personaToDraft(record);
        const draft = { ...baseline, description: 'Updated base' };
        await expect(model.commit(personas.getPersonaModelDeps(), 'ari.png', baseline, draft)).resolves.toMatchObject({ ok: true });
        expect(state.power_user.persona_description).toBe('Updated base\n\n(Second)\nSecond note');
        expect(state.power_user.persona_descriptions['ari.png'].description).toBe('Updated base');
        expect(mocks.script.saveSettings).toHaveBeenCalledWith(0, { returnResult: true });
    });

    test.each([true, false, undefined])('immediate save returns the acknowledged result for %p', async result => {
        const { personas, mocks } = await setupPersonas({
            script: { saveSettings: jest.fn(async () => result) },
        });
        await expect(personas.savePersonaSettingsNow()).resolves.toBe(Boolean(result));
        expect(mocks.script.saveSettings).toHaveBeenCalledWith(0, { returnResult: true });
    });

    test('immediate save catches errors', async () => {
        const { personas } = await setupPersonas({
            script: { saveSettings: jest.fn().mockRejectedValue(new Error('Offline')) },
        });
        await expect(personas.savePersonaSettingsNow()).resolves.toBe(false);
    });

    test('use and lock APIs delegate without changing their target', async () => {
        const { personas, state } = await setupPersonas({ user_avatar: 'active.png' });
        await expect(personas.setPersonaChatLock('ari.png', true)).resolves.toBe(false);
        expect(state.chat_metadata.persona).toBeUndefined();

        await expect(personas.setPersonaChatLock('active.png', true)).resolves.toBe(true);
        expect(state.chat_metadata.persona).toBe('active.png');

        await expect(personas.setPersonaChatLock('active.png', false)).resolves.toBe(true);
        expect(state.chat_metadata.persona).toBeUndefined();

        await personas.usePersona('ari.png');
        expect(personas.user_avatar).toBe('ari.png');
    });

    test('default is an idempotent setter using the legacy quiet path', async () => {
        const { personas, state, mocks } = await setupPersonas();
        await personas.setPersonaDefault('ari.png', false);
        expect(mocks.script.saveSettingsDebounced).not.toHaveBeenCalled();

        await personas.setPersonaDefault('ari.png', true);
        expect(state.power_user.default_persona).toBe('ari.png');
        expect(mocks.toastr.success).not.toHaveBeenCalled();

        mocks.script.saveSettingsDebounced.mockClear();
        await personas.setPersonaDefault('ari.png', true);
        expect(mocks.script.saveSettingsDebounced).not.toHaveBeenCalled();

        await personas.setPersonaDefault('ari.png', false);
        expect(state.power_user.default_persona).toBeFalsy();
        expect(mocks.toastr.info).not.toHaveBeenCalled();
    });

    test('connections target an inactive persona, return unlinked ids, and preserve other connections', async () => {
        const { personas, state, mocks, eventSource } = await setupPersonas();
        const emitSpy = jest.spyOn(eventSource, 'emit');
        state.power_user.personas['other.png'] = 'Other';
        state.power_user.persona_descriptions['other.png'] = {
            connections: [{ type: 'character', id: 'friend.png' }, { type: 'group', id: 'friend.png' }],
        };
        state.power_user.persona_descriptions['ari.png'].connections = [{ type: 'character', id: 'else.png' }];
        await expect(personas.setPersonaCharacterConnection('ari.png', true)).resolves.toEqual({ ok: true, unlinked: ['other.png'] });
        expect(state.power_user.persona_descriptions['ari.png'].connections).toEqual([
            { type: 'character', id: 'else.png' }, { type: 'character', id: 'friend.png' },
        ]);
        expect(state.power_user.persona_descriptions['other.png'].connections).toEqual([{ type: 'group', id: 'friend.png' }]);
        expect(mocks.script.saveSettingsDebounced).toHaveBeenCalledTimes(1);
        expect(emitSpy).not.toHaveBeenCalled();
        await expect(personas.setPersonaCharacterConnection('ari.png', false)).resolves.toEqual({ ok: true, unlinked: [] });
        expect(state.power_user.persona_descriptions['ari.png'].connections).toEqual([{ type: 'character', id: 'else.png' }]);
    });

    test('multiple-connection mode preserves links on other personas', async () => {
        const { personas, state } = await setupPersonas({ power_user: { persona_allow_multi_connections: true } });
        state.power_user.personas['other.png'] = 'Other';
        state.power_user.persona_descriptions['other.png'] = { connections: [{ type: 'character', id: 'friend.png' }] };
        await expect(personas.setPersonaCharacterConnection('ari.png', true)).resolves.toEqual({ ok: true, unlinked: [] });
        expect(state.power_user.persona_descriptions['other.png'].connections).toHaveLength(1);
    });

    test('connections require an existing persona and a current character or group', async () => {
        const { personas, mocks } = await setupPersonas();
        await expect(personas.setPersonaCharacterConnection('absent.png', true)).resolves.toEqual({ ok: false, unlinked: [] });
        expect(mocks.script.saveSettingsDebounced).not.toHaveBeenCalled();

        const { personas: noContextPersonas, mocks: noContextMocks } = await setupPersonas({ characters: [], this_chid: undefined });
        await expect(noContextPersonas.setPersonaCharacterConnection('ari.png', true)).resolves.toEqual({ ok: false, unlinked: [] });
        expect(noContextMocks.script.saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('one connection can be removed without affecting another type with the same id', async () => {
        const { personas, state, mocks, eventSource } = await setupPersonas();
        const emitSpy = jest.spyOn(eventSource, 'emit');
        state.power_user.persona_descriptions['ari.png'].connections.push({ type: 'group', id: 'friend.png' });
        await expect(personas.removePersonaConnection('ari.png', { type: 'character', id: 'friend.png' })).resolves.toBe(true);
        expect(state.power_user.persona_descriptions['ari.png'].connections).toEqual([{ type: 'group', id: 'friend.png' }]);
        expect(mocks.script.saveSettingsDebounced).toHaveBeenCalledTimes(1);
        expect(emitSpy).not.toHaveBeenCalled();
    });

    test('lorebook changes create a descriptor only for existing personas and leave inactive globals alone', async () => {
        const { personas, state, eventSource } = await setupPersonas({ user_avatar: 'active.png' });
        const emitSpy = jest.spyOn(eventSource, 'emit');
        delete state.power_user.persona_descriptions['ari.png'];
        await expect(personas.setPersonaLorebook('absent.png', 'New lore')).resolves.toBe(false);
        await expect(personas.setPersonaLorebook('ari.png', 'New lore')).resolves.toBe(true);
        expect(state.power_user.persona_descriptions['ari.png'].lorebook).toBe('New lore');
        expect(state.power_user.persona_description_lorebook).toBeUndefined();
        expect(document.getElementById('persona_lore_button').classList.contains('world_set')).toBe(false);
        expect(emitSpy).toHaveBeenCalledWith('persona_updated', 'ari.png');

        personas.initUserAvatar('ari.png');
        await personas.setPersonaLorebook('ari.png', '');
        expect(state.power_user.persona_description_lorebook).toBe('');
        expect(document.getElementById('persona_lore_button').classList.contains('world_set')).toBe(false);
    });

    test('activation, duplication, deletion and image change delegate to legacy data paths', async () => {
        const avatars = ['ari.png'];
        const { personas, state, mocks } = await setupPersonas({
            fetch: jest.fn(async (url, init) => {
                if (url === '/api/avatars/upload') {
                    avatars.push('copy.png');
                    return { ok: true, json: async () => ({ path: 'copy.png' }) };
                }
                if (url === '/api/avatars/get') return { ok: true, json: async () => [...avatars] };
                if (url === '/api/avatars/delete') {
                    const payload = JSON.parse(init?.body || '{}');
                    const idx = avatars.indexOf(payload.avatar);
                    if (idx >= 0) avatars.splice(idx, 1);
                    return { ok: true, json: async () => ({ ok: true }) };
                }
                return { ok: true, blob: async () => new Blob(['img'], { type: 'image/png' }), json: async () => ({ ok: true }) };
            }),
        });

        await personas.setPersonaAppendicesActive('ari.png', ['first']);
        expect(state.power_user.persona_descriptions['ari.png'].activeAppendices['friend.png']).toEqual(['first']);

        const duplicatedId = await personas.duplicatePersonaRecord('ari.png');
        expect(duplicatedId).toBeTruthy();
        expect(mocks.toastr.success).not.toHaveBeenCalled();

        const fileClicks = jest.fn();
        document.getElementById('avatar_upload_file').addEventListener('click', fileClicks);
        personas.changePersonaImage('ari.png');
        expect(document.getElementById('avatar_upload_overwrite').value).toBe('ari.png');
        expect(fileClicks).toHaveBeenCalledTimes(1);

        await expect(personas.deletePersonaRecord('ari.png')).resolves.toBe(true);
        expect(mocks.Popup.show.confirm).toHaveBeenCalled();
        expect(state.power_user.personas['ari.png']).toBeUndefined();
    });

    test('provisional cleanup can delete silently through the legacy API', async () => {
        const { personas, state, mocks } = await setupPersonas();
        await expect(personas.deletePersonaRecord('ari.png', { silent: true })).resolves.toBe(true);
        expect(mocks.Popup.show.confirm).not.toHaveBeenCalled();
        expect(mocks.toastr.info).not.toHaveBeenCalled();
        expect(state.power_user.personas['ari.png']).toBeUndefined();
    });

    test('creation uses the legacy id scheme and default avatar, without activation', async () => {
        const clock = jest.spyOn(Date, 'now').mockReturnValue(123);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const fetchMock = jest.fn(async (url) => {
                if (url === '/api/avatars/upload') return { ok: true, json: async () => ({ path: '123-Ari.png' }) };
                if (url === '/api/avatars/get') return { ok: true, json: async () => ['ari.png', '123-Ari.png'] };
                return { ok: true, blob: async () => new Blob(['img'], { type: 'image/png' }), json: async () => ({}) };
            });
            const { personas, state } = await setupPersonas({ fetch: fetchMock, user_avatar: 'active.png' });

            await expect(personas.createPersonaRecord({ name: ' Ari! ', title: 'Title', description: 'Text' })).resolves.toBe('123-Ari.png');
            expect(state.power_user.personas['123-Ari.png']).toBe('Ari!');
            expect(state.power_user.persona_descriptions['123-Ari.png']).toMatchObject({ title: 'Title', description: 'Text' });
            expect(fetchMock).toHaveBeenCalledWith('default.png');
            expect(personas.user_avatar).toBe('active.png');

            await expect(personas.createPersonaRecord({ name: ' ' })).resolves.toBe('');

            fetchMock.mockRejectedValueOnce(new Error('Offline'));
            await expect(personas.createPersonaRecord({ name: 'Ari' })).resolves.toBe('');
        } finally {
            warn.mockRestore();
            clock.mockRestore();
        }
    });

    test('dependency adapter supplies active projection, acknowledged saves, and the existing event bus', async () => {
        const { personas, state, mocks, eventSource, event_types } = await setupPersonas({ user_avatar: 'active.png' });
        const emitSpy = jest.spyOn(eventSource, 'emit');
        const deps = personas.getPersonaModelDeps();
        expect(deps.state).toBe(state.power_user);
        expect(deps.isActive('ari.png')).toBe(false);
        expect(deps.isActive('active.png')).toBe(true);
        expect(deps.project).toBe(personas.projectActivePersona);
        expect(deps.setUserName).toBe(mocks.script.setUserName);
        expect(deps.save).toBe(personas.savePersonaSettingsNow);
        expect(deps.events).toEqual({
            PERSONA_UPDATED: event_types.PERSONA_UPDATED,
            PERSONA_RENAMED: event_types.PERSONA_RENAMED,
        });
        await deps.emit(event_types.PERSONA_UPDATED, 'ari.png');
        expect(emitSpy).toHaveBeenCalledWith(event_types.PERSONA_UPDATED, 'ari.png');
    });
});

describe('inert persona editor adapter hooks', () => {
    test('visibility uses the legacy drawer by default and returns to it when the adapter is cleared', async () => {
        const { personas } = await setupPersonas();
        expect(personas.isPersonaPanelOpen()).toBe(true);
        const adapter = { isOpen: jest.fn(() => 0), refresh: jest.fn() };
        personas.setPersonaEditorAdapter(adapter);
        expect(personas.isPersonaPanelOpen()).toBe(false);
        expect(adapter.isOpen).toHaveBeenCalledTimes(1);
        personas.setPersonaEditorAdapter(null);
        expect(personas.isPersonaPanelOpen()).toBe(true);
    });

    test('a mounted adapter suppresses legacy layout and redirects state refreshes before navigation or DOM work', async () => {
        const { personas, eventSource, event_types, $ } = await setupPersonas({
            accountStorage: { PersonaGridView: 'true' },
        });
        await personas.initPersonas();
        document.getElementById('user_avatar_block').classList.remove('gridView');

        const adapter = { isOpen: () => true, refresh: jest.fn() };
        personas.setPersonaEditorAdapter(adapter);

        await eventSource.emit(event_types.CHAT_CHANGED, 'chat-2');
        expect(adapter.refresh).toHaveBeenCalledWith('states');

        $('#persona_grid_toggle').trigger('click');
        expect(document.getElementById('user_avatar_block').classList.contains('gridView')).toBe(false);
    });

    test('avatar fetching still normalizes missing personas but skips the legacy render pipeline', async () => {
        const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ['ari.png', 'other.png'] }));
        const { personas, state } = await setupPersonas({ fetch: fetchMock });
        const adapter = { isOpen: () => true, refresh: jest.fn() };
        personas.setPersonaEditorAdapter(adapter);

        await expect(personas.getUserAvatars()).resolves.toEqual(['ari.png', 'other.png']);
        expect(state.power_user.personas['other.png']).toBe('[Unnamed Persona]');
        expect(adapter.refresh).toHaveBeenCalledWith('list');
        expect(document.getElementById('user_avatar_block').children).toHaveLength(0);

        adapter.refresh.mockClear();
        delete state.power_user.personas['other.png'];
        await expect(personas.getUserAvatars(false)).resolves.toEqual(['ari.png', 'other.png']);
        expect(adapter.refresh).not.toHaveBeenCalled();
        expect(state.power_user.personas['other.png']).toBeUndefined();
    });

    test('the pre-existing non-OK avatar response still returns undefined', async () => {
        const { personas } = await setupPersonas({
            fetch: jest.fn(async () => ({ ok: false })),
        });
        await expect(personas.getUserAvatars()).resolves.toBeUndefined();
    });

    test('persona events notify the adapter for inactive records while keeping active data sync', async () => {
        const { personas, state, eventSource, event_types } = await setupPersonas({ user_avatar: 'active.png' });
        state.power_user.personas['active.png'] = 'Active';
        state.power_user.persona_descriptions['active.png'] = {
            description: 'Initial active description',
            appendices: [],
            activeAppendices: {},
        };
        await personas.initPersonas();
        const adapter = { isOpen: () => true, refresh: jest.fn() };
        personas.setPersonaEditorAdapter(adapter);

        state.power_user.persona_description = 'Stale prompt';
        await eventSource.emit(event_types.PERSONA_UPDATED, 'ari.png');
        expect(adapter.refresh).toHaveBeenCalledWith('persona', 'ari.png');
        expect(state.power_user.persona_description).toBe('Stale prompt');

        state.power_user.persona_descriptions['active.png'].description = 'Fresh active description';
        await eventSource.emit(event_types.PERSONA_UPDATED, 'active.png');
        expect(adapter.refresh).toHaveBeenLastCalledWith('persona', 'active.png');
        expect(state.power_user.persona_description).toBe('Fresh active description');

        personas.setPersonaEditorAdapter(null);
        state.power_user.persona_descriptions['active.png'].description = 'After unmount description';
        await eventSource.emit(event_types.PERSONA_UPDATED, 'active.png');
        expect(state.power_user.persona_description).toBe('After unmount description');
    });
});
