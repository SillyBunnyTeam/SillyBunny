import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    acceptCandidate,
    buildCharacterPatch,
    createDraft,
    getDraftTarget,
    normalizeCardFields,
    projectCardFields,
    reconcileSavedFields,
    setDraftTarget,
} from '../public/scripts/sillybunny-character-creator/model.js';

let userHandle = 'alice';
const records = new Map();
const database = {
    getItem: jest.fn(async key => records.has(key) ? structuredClone(records.get(key)) : null),
    setItem: jest.fn(async (key, value) => { records.set(key, structuredClone(value)); }),
    removeItem: jest.fn(async key => { records.delete(key); }),
};
await jest.unstable_mockModule('../public/lib.js', () => ({ localforage: { createInstance: () => database } }));
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => userHandle }));
const { loadDraft, saveDraft, discardDraft, flushDraftSaves } = await import('../public/scripts/sillybunny-character-creator/storage.js');

function stage(draft, target, value) {
    const candidate = { target, value, before: getDraftTarget(draft, target), inputRevision: draft.revision, runId: 1 };
    draft.candidates.push(candidate);
    return candidate;
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

describe('Creator draft projections and review', () => {
    test('prefers present nested values, including empty values, without importing metadata', () => {
        const fields = normalizeCardFields({
            name: 'Legacy', description: 'Legacy description', scenario: 'Root scenario', alternate_greetings: ['Legacy'],
            extensions: { private: 'secret' },
            data: { name: '', description: '', alternate_greetings: [], character_book: { private: 'secret' } },
        });
        expect(fields).toEqual({ name: '', description: '', personality: '', scenario: 'Root scenario', first_mes: '', mes_example: '', alternate_greetings: [] });
    });

    test('preserves an opaque imported description through recipe selection and unrelated acceptance', () => {
        const description = '\r\n[Info: a; b]\n<div>{{user}}</div>\n<START>\n{{char}}: Hello.  ';
        const draft = createDraft({ sourceAvatar: 'mara.png', fields: { name: 'Mara', description } });
        draft.recipeId = 'json';
        acceptCandidate(draft, stage(draft, 'scenario', 'A repair shop.'));
        const result = buildCharacterPatch(draft, ['description', 'scenario'], draft.baseline);
        expect(projectCardFields(draft).description).toBe(description);
        expect(draft.working.description).toEqual({ mode: 'opaque', text: description });
        expect(result.patch).toEqual({ avatar: 'mara.png', scenario: 'A repair shop.', data: { scenario: 'A repair shop.' } });
    });

    test('accepts a profile without deleting the disabled voice or first greeting', () => {
        const draft = createDraft();
        setDraftTarget(draft, 'voice', 'Interviewer: Why?\n{{char}}: Someone has to.');
        setDraftTarget(draft, 'first_mes', 'The bell rings.');
        draft.generationTargets = ['profile'];
        acceptCandidate(draft, stage(draft, 'profile', '[Name: Mara; Work: repairs]'));
        expect(projectCardFields(draft)).toMatchObject({
            description: '[Name: Mara; Work: repairs]\n\nInterviewer: Why?\n{{char}}: Someone has to.',
            first_mes: 'The bell rings.',
        });
    });

    test('converts description atomically and captures independent before-value snapshots', () => {
        const draft = createDraft({ fields: { description: 'Original prose.' } });
        const conversion = stage(draft, 'description', { mode: 'parts', recipeId: 'plist', profile: '[Name: Mara]', voice: '' });
        expect(projectCardFields(draft).description).toBe('Original prose.');
        acceptCandidate(draft, conversion);
        const captured = getDraftTarget(draft, 'description');
        setDraftTarget(draft, 'profile', '[Name: Another]');
        expect(captured.profile).toBe('[Name: Mara]');
        setDraftTarget(draft, 'description', 'Raw replacement {{char}}.');
        expect(draft.working.description).toEqual({ mode: 'opaque', text: 'Raw replacement {{char}}.' });
        expect(() => setDraftTarget(draft, 'voice', 'Do not append.')).toThrow();
        expect(projectCardFields(draft).description).toBe('Raw replacement {{char}}.');
    });

    test('refuses target-stale proposals without mutating either proposal or manual edit', () => {
        const draft = createDraft();
        const candidate = stage(draft, 'profile', '[Name: Model]');
        setDraftTarget(draft, 'profile', '[Name: Manual]');
        const revision = draft.revision;
        expect(() => acceptCandidate(draft, candidate)).toThrow(/changed/);
        expect(getDraftTarget(draft, 'profile')).toBe('[Name: Manual]');
        expect(draft.candidates).toEqual([candidate]);
        expect(candidate.value).toBe('[Name: Model]');
        expect(draft.revision).toBe(revision);
    });

    test('retains completed staged proposals but refuses discarded or unstaged completions', () => {
        const draft = createDraft();
        const completed = stage(draft, 'profile', '[Name: Mara]');
        const discarded = stage(draft, 'first_mes', 'An unwanted greeting.');
        draft.candidates.splice(draft.candidates.indexOf(discarded), 1);
        expect(() => acceptCandidate(draft, discarded)).toThrow();
        const late = { ...discarded, value: 'Late response.' };
        expect(() => acceptCandidate(draft, late)).toThrow();
        acceptCandidate(draft, completed);
        expect(projectCardFields(draft)).toMatchObject({ description: '[Name: Mara]', first_mes: '' });
    });

    test('allows stale context when the specific target remains unchanged', () => {
        const draft = createDraft();
        const candidate = stage(draft, 'profile', '[Work: repairs]');
        setDraftTarget(draft, 'name', 'Mara');
        expect(candidate.inputRevision).toBeLessThan(draft.revision);
        acceptCandidate(draft, candidate);
        expect(projectCardFields(draft)).toMatchObject({ name: 'Mara', description: '[Work: repairs]' });
    });

    test('rejects malformed values and metadata targets without partial mutation', () => {
        const draft = createDraft();
        const invalid = stage(draft, 'name', { name: 'Mara', extensions: { injected: true } });
        expect(() => acceptCandidate(draft, invalid)).toThrow();
        expect(() => setDraftTarget(draft, '__proto__', 'injected')).toThrow();
        expect(() => buildCharacterPatch(draft, ['extensions'], {})).toThrow();
        expect(draft.revision).toBe(0);
        expect(projectCardFields(draft).name).toBe('');
    });

    test('distinguishes explicit clears, unselected edits, and omitted fields in mirrored deltas', () => {
        const draft = createDraft({ sourceAvatar: 'mara.png', fields: { name: 'Mara', description: 'Old', scenario: 'Old scenario', first_mes: 'Hi' } });
        setDraftTarget(draft, 'description', '');
        setDraftTarget(draft, 'scenario', 'Unsaved scenario');
        const { patch, changedFields } = buildCharacterPatch(draft, ['description', 'name'], draft.baseline);
        expect(patch).toEqual({ avatar: 'mara.png', description: '', data: { description: '' } });
        expect(changedFields).toEqual(['description']);
        expect(projectCardFields(draft).scenario).toBe('Unsaved scenario');
    });

    test('preserves greeting identity across reorder and strips IDs from a complete array delta', () => {
        const draft = createDraft({ sourceAvatar: 'mara.png', fields: { alternate_greetings: ['First', 'Second', 'Third'] } });
        const secondId = draft.working.alternate_greetings[1].id;
        const candidate = stage(draft, `greeting:${secondId}`, 'Second revised');
        draft.working.alternate_greetings.reverse();
        draft.working.alternate_greetings.pop();
        acceptCandidate(draft, candidate);
        const addedId = draft.nextGreetingId++;
        draft.working.alternate_greetings.push({ id: addedId, text: 'New slot' });
        expect(addedId).toBeGreaterThan(secondId);
        expect(projectCardFields(draft).alternate_greetings).toEqual(['Third', 'Second revised', 'New slot']);
        expect(buildCharacterPatch(draft, ['alternate_greetings'], draft.baseline).patch).toEqual({
            avatar: 'mara.png', data: { alternate_greetings: ['Third', 'Second revised', 'New slot'] },
        });
        const removedSlotCandidate = stage(draft, `greeting:${secondId}`, 'Do not recreate a removed slot');
        draft.working.alternate_greetings = [];
        expect(() => acceptCandidate(draft, removedSlotCandidate)).toThrow();
        expect(buildCharacterPatch(draft, ['alternate_greetings'], draft.baseline).patch.data.alternate_greetings).toEqual([]);
        expect(() => getDraftTarget(draft, `greeting:${secondId}`)).toThrow();
    });

    test('conflicts only selected changed fields and recognizes values saved elsewhere', () => {
        const draft = createDraft({ sourceAvatar: 'mara.png', fields: { description: 'Original', scenario: 'Original context' } });
        setDraftTarget(draft, 'description', 'Proposed');
        setDraftTarget(draft, 'scenario', 'Proposed context');
        const latest = { description: 'Other editor', scenario: 'Other context' };
        const conflict = buildCharacterPatch(draft, ['description'], latest);
        expect(conflict.conflicts).toEqual([{ field: 'description', baseline: 'Original', current: 'Other editor', proposed: 'Proposed' }]);
        expect(conflict.changedFields).toEqual([]);
        const alreadySaved = buildCharacterPatch(draft, ['description'], { ...latest, description: 'Proposed' });
        expect(alreadySaved.alreadySavedFields).toEqual(['description']);
        expect(alreadySaved.conflicts).toEqual([]);
        expect(alreadySaved.patch).toEqual({ avatar: 'mara.png', data: {} });
    });

    test('partial save preserves a dirty unselected field and its original conflict baseline', () => {
        const draft = createDraft({ sourceAvatar: 'mara.png', fields: { description: 'Original description', scenario: 'Original scenario', personality: 'Quiet' } });
        setDraftTarget(draft, 'description', 'New description');
        setDraftTarget(draft, 'scenario', 'Local scenario');
        const latest = { ...draft.baseline, scenario: 'External scenario', personality: 'Talkative' };
        const result = buildCharacterPatch(draft, ['description'], latest);
        expect(result.conflicts).toEqual([]);
        expect(result.patch).toEqual({ avatar: 'mara.png', description: 'New description', data: { description: 'New description' } });
        const saved = { description: 'New description' };
        reconcileSavedFields(draft, saved, { ...latest, ...saved });
        expect(draft.baseline.scenario).toBe('Original scenario');
        expect(projectCardFields(draft).scenario).toBe('Local scenario');
        expect(draft.baseline.personality).toBe('Talkative');
        expect(projectCardFields(draft).personality).toBe('Talkative');
        expect(buildCharacterPatch(draft, ['scenario'], { ...latest, ...saved }).conflicts).toEqual([
            { field: 'scenario', baseline: 'Original scenario', current: 'External scenario', proposed: 'Local scenario' },
        ]);
    });

    test('save acknowledgement preserves newer local edits and managed description blocks', () => {
        const draft = createDraft();
        setDraftTarget(draft, 'profile', '[Name: Mara]');
        const submitted = { description: projectCardFields(draft).description };
        setDraftTarget(draft, 'voice', '{{char}}: Not finished yet.');
        reconcileSavedFields(draft, submitted, { ...draft.baseline, ...submitted });
        expect(draft.baseline.description).toBe('[Name: Mara]');
        expect(draft.working.description).toMatchObject({ mode: 'parts', profile: '[Name: Mara]', voice: '{{char}}: Not finished yet.' });
        expect(buildCharacterPatch(draft, ['description'], draft.baseline).changedFields).toEqual(['description']);
    });

    test('server refresh reuses moved greeting IDs and makes externally changed descriptions opaque', () => {
        const draft = createDraft({ fields: { description: 'Old', alternate_greetings: ['One', 'Two'] } });
        const [first, second] = draft.working.alternate_greetings;
        reconcileSavedFields(draft, {}, { ...draft.baseline, description: 'External prose', alternate_greetings: ['Two', 'One', 'Three'] });
        expect(draft.working.alternate_greetings).toEqual([{ id: second.id, text: 'Two' }, { id: first.id, text: 'One' }, { id: 3, text: 'Three' }]);
        expect(draft.nextGreetingId).toBe(4);
        expect(draft.working.description).toEqual({ mode: 'opaque', text: 'External prose' });
    });

    test('treats macro and HTML-looking proposal content as literal data', () => {
        const draft = createDraft();
        const text = '{{user}} <script>alert(1)</script> {{char}} /send secret';
        acceptCandidate(draft, stage(draft, 'first_mes', text));
        expect(projectCardFields(draft).first_mes).toBe(text);
        expect(buildCharacterPatch(draft, ['first_mes'], draft.baseline).patch).toEqual({ avatar: null, first_mes: text, data: { first_mes: text } });
    });
});

describe('Creator account-scoped draft persistence', () => {
    beforeEach(async () => {
        await flushDraftSaves().catch(() => {});
        records.clear();
        userHandle = 'alice';
        database.getItem.mockClear();
        database.setItem.mockClear();
        database.removeItem.mockClear();
    });

    test('isolates accounts and saved-card identities from the new-card slot', async () => {
        const draft = createDraft();
        setDraftTarget(draft, 'name', 'Alice new');
        await saveDraft(draft);
        await saveDraft(createDraft({ sourceAvatar: 'mara.png', fields: { name: 'Alice polish' } }));
        userHandle = 'bob';
        expect(await loadDraft(null)).toBeNull();
        expect(await loadDraft('mara.png')).toBeNull();
        await saveDraft(createDraft({ fields: { name: 'Bob new' } }));
        userHandle = 'alice';
        expect((await loadDraft(null)).working.name).toBe('Alice new');
        expect((await loadDraft('mara.png')).working.name).toBe('Alice polish');
        await discardDraft(null);
        expect(await loadDraft(null)).toBeNull();
        expect((await loadDraft('mara.png')).working.name).toBe('Alice polish');
        userHandle = 'bob';
        expect((await loadDraft(null)).working.name).toBe('Bob new');
    });

    test('serializes slow writes with immutable snapshots and captures the account at invocation', async () => {
        const entered = deferred();
        const release = deferred();
        database.setItem.mockImplementationOnce(async (key, value) => {
            entered.resolve();
            await release.promise;
            records.set(key, structuredClone(value));
        });
        const draft = createDraft();
        setDraftTarget(draft, 'name', 'Earlier');
        const first = saveDraft(draft);
        await entered.promise;
        setDraftTarget(draft, 'name', 'Latest saved');
        const second = saveDraft(draft);
        setDraftTarget(draft, 'name', 'Unsaved typing');
        userHandle = 'bob';
        release.resolve();
        await Promise.all([first, second]);
        expect(await loadDraft(null)).toBeNull();
        userHandle = 'alice';
        expect((await loadDraft(null)).working.name).toBe('Latest saved');
    });

    test('a failed write leaves local work intact and does not poison subsequent saves', async () => {
        const draft = createDraft();
        setDraftTarget(draft, 'name', 'Saved');
        await saveDraft(draft);
        setDraftTarget(draft, 'name', 'Recoverable edit');
        database.setItem.mockRejectedValueOnce(new Error('Quota exceeded'));
        await expect(saveDraft(draft)).rejects.toThrow('Quota exceeded');
        await expect(flushDraftSaves()).rejects.toThrow('Quota exceeded');
        expect(draft.working.name).toBe('Recoverable edit');
        expect((await loadDraft(null)).working.name).toBe('Saved');
        await saveDraft(draft);
        expect((await loadDraft(null)).working.name).toBe('Recoverable edit');
    });

    test.each([
        { version: 99, unrecoverable: 'Keep raw' },
        { ...createDraft(), working: { name: 'Missing fields' } },
        { ...createDraft(), nextGreetingId: 1, working: { ...createDraft().working, alternate_greetings: [{ id: 1, text: 'Invalid next ID' }] } },
    ])('preserves malformed records until explicit discard', async raw => {
        const key = JSON.stringify(['alice', null]);
        records.set(key, structuredClone(raw));
        await expect(loadDraft(null)).rejects.toMatchObject({ rawDraft: raw });
        await expect(saveDraft(createDraft())).rejects.toMatchObject({ rawDraft: raw });
        expect(records.get(key)).toEqual(raw);
        await discardDraft(null);
        const replacement = createDraft({ fields: { name: 'Explicit replacement' } });
        await saveDraft(replacement);
        expect((await loadDraft(null)).working.name).toBe('Explicit replacement');
    });

    test('restores interrupted work to idle with completed candidates and answers intact', async () => {
        const draft = createDraft();
        draft.answers = 'The shop is on a moon.';
        draft.profileId = 'selected-profile';
        draft.generationTargets = ['profile', 'voice'];
        stage(draft, 'profile', '[Work: repairs]');
        draft.generationRunning = true;
        draft.controller = new AbortController();
        draft.pending = Promise.resolve('runtime only');
        await saveDraft(draft);
        const restored = await loadDraft(null);
        expect(restored.generationRunning).toBe(false);
        expect(restored.generationInterrupted).toBe(true);
        expect(restored.answers).toBe('The shop is on a moon.');
        expect(restored.profileId).toBe('selected-profile');
        expect(restored.controller).toBeUndefined();
        expect(restored.pending).toBeUndefined();
        acceptCandidate(restored, restored.candidates[0]);
        expect(projectCardFields(restored).description).toBe('[Work: repairs]');
    });

    test('discard waits for pending writes instead of allowing a draft to reappear', async () => {
        const entered = deferred();
        const release = deferred();
        database.setItem.mockImplementationOnce(async (key, value) => {
            entered.resolve();
            await release.promise;
            records.set(key, structuredClone(value));
        });
        const saving = saveDraft(createDraft());
        await entered.promise;
        const discarding = discardDraft(null);
        release.resolve();
        await Promise.all([saving, discarding]);
        expect(await loadDraft(null)).toBeNull();
    });
});
