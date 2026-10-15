import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const editorSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-character-editor.js'), 'utf8').replace(/\r\n/g, '\n');

function getFunctionSource(name) {
    const pattern = new RegExp(`^(async )?function ${name}\\(`,'m');
    const match = editorSource.match(pattern);
    if (!match) throw new Error(`Function ${name} not found`);

    const start = match.index;
    const bodyStart = editorSource.indexOf('{', editorSource.indexOf(')', start));
    let depth = 0;
    for (let index = bodyStart; index < editorSource.length; index++) {
        if (editorSource[index] === '{') depth++;
        if (editorSource[index] === '}' && --depth === 0) {
            return editorSource.slice(start, index + 1);
        }
    }
    throw new Error(`Unterminated function ${name}`);
}

function createDraftHarness() {
    const storage = new Map();
    const toastShown = [];
    const context = {
        localStorage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: (key) => storage.delete(key),
        },
        getCurrentUserHandle: () => 'test-user',
        console: { warn: () => {} },
        currentSession: null,
        draftAlt: [],
        draftGrp: [],
        _showDraftRestoreToast: (draft) => toastShown.push(draft),
        _restoreSnapshot: () => {},
        Date: Date,
        JSON: JSON,
    };

    const constants = editorSource.match(/const DRAFT_KEY_PREFIX = '([^']+)'/);
    if (constants) context.DRAFT_KEY_PREFIX = constants[1];

    vm.runInNewContext([
        'const DRAFT_KEY_PREFIX = globalThis.DRAFT_KEY_PREFIX;',
        'let currentSession = globalThis.currentSession;',
        'let draftAlt = globalThis.draftAlt;',
        'let draftGrp = globalThis.draftGrp;',
        'function _captureSnapshot() { return currentSession.baseline; }',
        getFunctionSource('_draftKey'),
        getFunctionSource('_saveDraftNow'),
        getFunctionSource('_removeDraft'),
        getFunctionSource('_checkDraftRestore'),
        'globalThis.api = { _draftKey, _saveDraftNow, _removeDraft, _checkDraftRestore };',
        'globalThis.setSession = (s) => { currentSession = s; globalThis.currentSession = s; };',
    ].join('\n'), context);

    return { context, storage, toastShown };
}

describe('character editor draft persistence', () => {
    test('draft key includes user handle and avatar', () => {
        const { context } = createDraftHarness();
        const key = context.api._draftKey('alice.png');
        expect(key).toBe('sb-editor-draft-test-user-alice.png');
    });

    test('saving a draft writes v1 structure with snapshot and timestamp', () => {
        const { context, storage } = createDraftHarness();
        const snapshot = { character_name_pole: 'Test', _alt: [], _grp: [] };
        context.setSession({ avatar: 'bob.png', baseline: {}, baselineJson: '{}' });
        context.currentSession.baseline = snapshot;

        context.api._saveDraftNow();

        const key = 'sb-editor-draft-test-user-bob.png';
        expect(storage.has(key)).toBe(true);
        const draft = JSON.parse(storage.get(key));
        expect(draft.v).toBe(1);
        expect(draft.snapshot).toEqual(snapshot);
        expect(draft.ts).toBeGreaterThan(Date.now() - 1000);
    });

    test('removing a draft deletes the localStorage entry', () => {
        const { context, storage } = createDraftHarness();
        storage.set('sb-editor-draft-test-user-charlie.png', '{"v":1}');
        context.api._removeDraft('charlie.png');
        expect(storage.has('sb-editor-draft-test-user-charlie.png')).toBe(false);
    });

    test('checkDraftRestore ignores missing drafts', () => {
        const { context, toastShown } = createDraftHarness();
        context.setSession({ avatar: 'empty.png', baseline: {}, baselineJson: '{}' });
        context.api._checkDraftRestore();
        expect(toastShown).toHaveLength(0);
    });

    test('checkDraftRestore ignores malformed JSON', () => {
        const { context, storage, toastShown } = createDraftHarness();
        storage.set('sb-editor-draft-test-user-bad.png', '{broken');
        context.setSession({ avatar: 'bad.png', baseline: {}, baselineJson: '{}' });
        context.api._checkDraftRestore();
        expect(toastShown).toHaveLength(0);
    });

    test('checkDraftRestore ignores drafts missing version or snapshot', () => {
        const { context, storage, toastShown } = createDraftHarness();
        storage.set('sb-editor-draft-test-user-v0.png', JSON.stringify({ ts: Date.now() }));
        context.setSession({ avatar: 'v0.png', baseline: {}, baselineJson: '{}' });
        context.api._checkDraftRestore();
        expect(toastShown).toHaveLength(0);
    });

    test('checkDraftRestore removes draft identical to baseline', () => {
        const { context, storage, toastShown } = createDraftHarness();
        const snapshot = { character_name_pole: 'Unchanged' };
        const draft = { v: 1, ts: Date.now(), snapshot };
        storage.set('sb-editor-draft-test-user-same.png', JSON.stringify(draft));
        context.setSession({ avatar: 'same.png', baseline: snapshot, baselineJson: JSON.stringify(snapshot) });
        context.api._checkDraftRestore();
        expect(toastShown).toHaveLength(0);
        expect(storage.has('sb-editor-draft-test-user-same.png')).toBe(false);
    });

    test('checkDraftRestore offers toast when draft differs from baseline', () => {
        const { context, storage, toastShown } = createDraftHarness();
        const draft = { v: 1, ts: Date.now(), snapshot: { character_name_pole: 'Changed' } };
        storage.set('sb-editor-draft-test-user-diff.png', JSON.stringify(draft));
        context.setSession({ avatar: 'diff.png', baseline: {}, baselineJson: '{}' });
        context.api._checkDraftRestore();
        expect(toastShown).toHaveLength(1);
        expect(toastShown[0].snapshot.character_name_pole).toBe('Changed');
    });
});
