import { describe, expect, test } from '@jest/globals';
import { createEditorDraftStore } from '/scripts/sillybunny-editor/drafts.js';
import { createEditorSession } from '/scripts/sillybunny-editor/session.js';

function createDelayedSave() {
    let snapshot = { name: 'Saved' };
    let finish;
    let receipt;
    const request = new Promise(resolve => { finish = resolve; });
    const storage = new Map();
    const session = createEditorSession({
        captureSnapshot: () => structuredClone(snapshot),
        restoreSnapshot: value => { snapshot = structuredClone(value); },
        persist: async submitted => {
            receipt = submitted;
            const result = await request;
            if (result !== false) submitted.markSaved(result?.context, result?.snapshot);
        },
        drafts: {
            read: () => null,
            write: (id, value) => storage.set(id, structuredClone(value)),
            remove: id => storage.delete(id),
        },
        timers: { setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {} },
    });
    return {
        session,
        storage,
        finish,
        get receipt() { return receipt; },
        get snapshot() { return snapshot; },
        set snapshot(value) { snapshot = value; },
    };
}

describe('editor drafts storage', () => {
    test('writes v1 envelope with snapshot and timestamp', () => {
        const storage = new Map();
        const now = () => 123456789;
        const drafts = createEditorDraftStore({
            keyFor: (id) => `test-${id}`,
            storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
            now,
        });

        drafts.write('alice', { name: 'Test' });

        expect(storage.has('test-alice')).toBe(true);
        const envelope = JSON.parse(storage.get('test-alice'));
        expect(envelope.v).toBe(1);
        expect(envelope.ts).toBe(123456789);
        expect(envelope.snapshot).toEqual({ name: 'Test' });
    });

    test('read returns null for missing or malformed drafts', () => {
        const drafts = createEditorDraftStore({
            keyFor: (id) => id,
            storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        });
        expect(drafts.read('missing')).toBeNull();

        const badStorage = new Map([['bad', '{broken']]);
        const badDrafts = createEditorDraftStore({
            keyFor: (id) => id,
            storage: { getItem: (k) => badStorage.get(k) ?? null, setItem: (k, v) => badStorage.set(k, v), removeItem: (k) => badStorage.delete(k) },
        });
        expect(badDrafts.read('bad')).toBeNull();
    });

    test('read rejects primitive or array snapshots', () => {
        const storage = new Map([
            ['string', JSON.stringify({ v: 1, ts: 1, snapshot: 'text' })],
            ['array', JSON.stringify({ v: 1, ts: 1, snapshot: [] })],
            ['null', JSON.stringify({ v: 1, ts: 1, snapshot: null })],
        ]);
        const drafts = createEditorDraftStore({
            keyFor: (id) => id,
            storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
        });
        expect(drafts.read('string')).toBeNull();
        expect(drafts.read('array')).toBeNull();
        expect(drafts.read('null')).toBeNull();
    });

    test('read accepts valid v1 draft with object snapshot', () => {
        const valid = { v: 1, ts: 123, snapshot: { name: 'Alice' } };
        const storage = new Map([['ok', JSON.stringify(valid)]]);
        const drafts = createEditorDraftStore({
            keyFor: (id) => id,
            storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
        });
        const draft = drafts.read('ok');
        expect(draft.v).toBe(1);
        expect(draft.ts).toBe(123);
        expect(draft.snapshot).toEqual({ name: 'Alice' });
    });

    test('remove deletes the storage entry', () => {
        const storage = new Map([['entity', 'draft']]);
        const drafts = createEditorDraftStore({
            keyFor: (id) => id,
            storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
        });
        drafts.remove('entity');
        expect(storage.has('entity')).toBe(false);
    });
});

describe('editor session dirty tracking and draft backup', () => {
    test('a delayed save baselines the submitted snapshot and backs up later edits', async () => {
        const harness = createDelayedSave();
        harness.session.open({ mode: 'edit', entityId: 'group-1' });
        harness.snapshot.name = 'Submitted';
        const saving = harness.session.save();
        harness.snapshot.name = 'Still unsaved';
        await Promise.resolve();
        expect(harness.receipt.snapshot).toEqual({ name: 'Submitted' });

        harness.finish();
        expect(await saving).toBe(false);
        expect(harness.session.readBaseline()).toEqual({ name: 'Submitted' });
        expect(harness.storage.get('group-1')).toEqual({ name: 'Still unsaved' });
        harness.session.discard();
        expect(harness.snapshot.name).toBe('Submitted');
    });

    for (const entityId of ['group-1', 'group-2']) {
        test(`a delayed receipt cannot clean a reopened ${entityId} session or its backup`, async () => {
            const harness = createDelayedSave();
            harness.session.open({ mode: 'edit', entityId: 'group-1' });
            harness.snapshot.name = 'Submitted';
            const saving = harness.session.save();
            await Promise.resolve();
            harness.session.suspend();
            harness.snapshot = { name: 'Other saved state' };
            harness.session.open({ mode: 'edit', entityId });
            harness.snapshot.name = 'Other pending edit';
            harness.session.flushDraft();

            harness.finish();
            expect(await saving).toBe(false);
            expect(harness.session.readBaseline()).toEqual({ name: 'Other saved state' });
            expect(harness.storage.get(entityId)).toEqual({ name: 'Other pending edit' });
            expect(harness.receipt.isCurrent()).toBe(false);
        });
    }

    test('create receipts re-key remaining edits without retaining the create backup', async () => {
        const harness = createDelayedSave();
        harness.session.open({ mode: 'create', entityId: 'new-group' });
        harness.snapshot = { name: 'Submitted', id: null };
        harness.session.flushDraft();
        const saving = harness.session.save();
        await Promise.resolve();
        harness.snapshot = { name: 'Later edit', id: 'created' };
        harness.finish({ context: { mode: 'edit', entityId: 'created' }, snapshot: { name: 'Submitted', id: 'created' } });

        expect(await saving).toBe(false);
        expect(harness.session.context).toEqual({ mode: 'edit', entityId: 'created' });
        expect(harness.storage.has('new-group')).toBe(false);
        expect(harness.storage.get('created')).toEqual({ name: 'Later edit', id: 'created' });
        expect(harness.session.readBaseline()).toEqual({ name: 'Submitted', id: 'created' });
    });

    test('unsuccessful persistence keeps the baseline and backup', async () => {
        const harness = createDelayedSave();
        harness.session.open({ mode: 'edit', entityId: 'group-1' });
        harness.snapshot.name = 'Unsaved';
        harness.session.flushDraft();
        const saving = harness.session.save();
        harness.finish(false);

        expect(await saving).toBe(false);
        expect(harness.session.readBaseline()).toEqual({ name: 'Saved' });
        expect(harness.storage.get('group-1')).toEqual({ name: 'Unsaved' });
    });

    test('isDirty compares snapshot against baseline', () => {
        let state = { name: 'A' };
        const session = createEditorSession({
            captureSnapshot: () => ({ ...state }),
            restoreSnapshot: (snap) => { state = snap; },
            persist: () => Promise.resolve(),
            drafts: { read: () => null, write: () => {}, remove: () => {} },
        });

        session.open({ mode: 'edit', entityId: 'test' });
        expect(session.isDirty()).toBe(false);
        state.name = 'B';
        expect(session.isDirty()).toBe(true);
        session.close();
    });

    test('discard reverts to baseline and removes draft', () => {
        let state = { name: 'A' };
        const removed = [];
        const session = createEditorSession({
            captureSnapshot: () => ({ ...state }),
            restoreSnapshot: (snap) => { state = { ...snap }; },
            persist: () => Promise.resolve(),
            drafts: { read: () => null, write: () => {}, remove: (id) => removed.push(id) },
        });

        session.open({ mode: 'edit', entityId: 'test' });
        state.name = 'B';
        session.discard();
        expect(state.name).toBe('A');
        expect(removed).toEqual(['test']);
        session.close();
    });

    test('session ignores stale recovery-toast restore after entityId changed', () => {
        let state = { name: 'A' };
        let offered = null;
        const session = createEditorSession({
            captureSnapshot: () => ({ ...state }),
            restoreSnapshot: (snap) => { state = { ...snap }; },
            persist: () => Promise.resolve(),
            drafts: {
                read: (id) => (id === 'entity1' ? { v: 1, ts: 1, snapshot: { name: 'Draft1' } } : null),
                write: () => {},
                remove: () => {},
            },
            offerDraft: (draft, actions) => { offered = actions; },
        });

        session.open({ mode: 'edit', entityId: 'entity1' });
        session.markSaved({ entityId: 'entity2', mode: 'edit' });
        offered.restore();
        expect(state.name).toBe('A');
        session.close();
    });

    test('periodic draft writes snapshot to storage', async () => {
        let state = { name: 'A' };
        const storage = new Map();
        const timers = [];
        let fakeNow = 0;
        const session = createEditorSession({
            captureSnapshot: () => ({ ...state }),
            restoreSnapshot: (snap) => { state = { ...snap }; },
            persist: () => Promise.resolve(),
            drafts: {
                read: () => null,
                write: (id, snap) => storage.set(id, { v: 1, ts: fakeNow, snapshot: snap }),
                remove: (id) => storage.delete(id),
            },
            timers: {
                setTimeout: (...args) => ({ args }),
                clearTimeout: () => {},
                setInterval: (fn, ms) => {
                    const id = timers.length;
                    timers.push({ fn, ms });
                    return id;
                },
                clearInterval: () => {},
            },
        });

        session.open({ mode: 'edit', entityId: 'test' });
        state.name = 'B';
        fakeNow = 1000;
        timers[0].fn();
        const draft = storage.get('test');
        expect(draft.snapshot.name).toBe('B');
        expect(draft.ts).toBe(1000);
    });

    test('an offered recovery action reads a subsequently patched favorite without cleaning other edits', () => {
        let state = { name: 'Saved', _fav: false };
        let backup = { v: 1, ts: 1, snapshot: { name: 'Pending', _fav: false } };
        let recovery;
        const session = createEditorSession({
            captureSnapshot: () => ({ ...state }),
            restoreSnapshot: snapshot => { state = { ...snapshot }; },
            persist: async () => {},
            drafts: { read: () => backup, write: () => {}, remove: () => { backup = null; } },
            offerDraft: (_draft, actions) => { recovery = actions; },
        });
        session.open({ mode: 'edit', entityId: 'alice.png' });
        backup = { ...backup, snapshot: { ...backup.snapshot, _fav: true } };
        state._fav = true;
        session.rebase({ ...session.readBaseline(), _fav: true });
        recovery.restore();
        expect(state).toEqual({ name: 'Pending', _fav: true });
        expect(session.readBaseline()).toEqual({ name: 'Saved', _fav: true });
        expect(session.isDirty()).toBe(true);
        session.close();
    });

    test('an offered recovery action cannot resurrect a deleted stored backup', () => {
        let state = { name: 'Saved' };
        let backup = { v: 1, ts: 1, snapshot: { name: 'Pending' } };
        let recovery;
        const session = createEditorSession({
            captureSnapshot: () => ({ ...state }),
            restoreSnapshot: snapshot => { state = { ...snapshot }; },
            persist: async () => {},
            drafts: { read: () => backup, write: () => {}, remove: () => { backup = null; } },
            offerDraft: (_draft, actions) => { recovery = actions; },
        });
        session.open({ mode: 'edit', entityId: 'alice.png' });
        backup = null;
        recovery.restore();
        expect(state).toEqual({ name: 'Saved' });
        expect(session.isDirty()).toBe(false);
        session.close();
    });
});

describe('character-editor draft key contract', () => {
    test('user-avatar key matches original format', () => {
        const keyFor = (entityId) => {
            const user = 'test-user';
            return `sb-editor-draft-${user}-${entityId}`;
        };
        expect(keyFor('alice.png')).toBe('sb-editor-draft-test-user-alice.png');
        expect(keyFor('new-character')).toBe('sb-editor-draft-test-user-new-character');
    });
});
