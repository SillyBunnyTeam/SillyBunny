/* eslint-disable playwright/no-standalone-expect -- Parameterized Jest tests, not Playwright. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../public/scripts/world-info.js', import.meta.url), 'utf8');
const importSource = source.match(/^export (async function importWorldInfo\([\s\S]*?^})/m)[1];

function harness() {
    const release = jest.fn();
    const deps = {
        FormData, Map, parseJsonFile: async file => JSON.parse(await file.text()),
        getCanonicalWorldInfoName: async () => 'Canonical name', findMatchingLorebookName: () => undefined,
        world_names: [], checkOverwriteExistingData: jest.fn(async () => true),
        blockWorldInfoSaves: () => release, settleWorldInfoSave: async () => {}, getRequestHeaders: () => ({}),
        fetch: jest.fn(async () => new Response('{"name":"Server canonical name"}')),
        cloneWorldInfoData: structuredClone, worldInfoCommittedEntryInstances: new Map(), worldInfoEntryInstances: new WeakMap(),
        invalidateWorldInfoCache: jest.fn(), worldInfoCache: new Map(), worldInfoCacheVersions: new Map(), worldInfoEditor: null,
        updateWorldInfoList: jest.fn(), eventSource: { emit: jest.fn() }, event_types: { WORLDINFO_UPDATED: 'updated' },
        toastr: { error: jest.fn(), success: jest.fn() }, console: { error() {}, log() {} },
        t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    };
    const importWorldInfo = new Function(...Object.keys(deps), `${importSource}\nreturn importWorldInfo;`)(...Object.values(deps));
    return { ...deps, release, importWorldInfo };
}
const book = () => new File(['{"entries":{}}'], 'unsafe? name.json');

describe('opt-in World Info import results', () => {
    test('returns its server canonical name, emits the normal event and releases its save block', async () => {
        const app = harness();
        expect(await app.importWorldInfo(book(), { returnResult: true })).toEqual({ ok: true, name: 'Server canonical name', error: null });
        expect(app.eventSource.emit).toHaveBeenCalledWith('updated', 'Server canonical name', { entries: {} }, { replaced: true });
        expect(app.release).toHaveBeenCalledTimes(1);
    });
    test.each([
        ['plain server detail', 'Rejected book'],
        ['JSON server detail', '{"error":"Rejected book"}'],
    ])('%s is returned without changing legacy failure returns', async (_label, body) => {
        const app = harness();
        app.fetch.mockImplementation(async () => new Response(body, { status: 400, statusText: 'Bad request' }));
        expect(await app.importWorldInfo(book(), { returnResult: true })).toEqual({ ok: false, name: null, error: 'Rejected book' });
        expect(await app.importWorldInfo(book())).toBeUndefined();
        expect(app.eventSource.emit).not.toHaveBeenCalled();
        expect(app.release).toHaveBeenCalledTimes(2);
    });
    test('JSON error envelopes do not report success', async () => {
        const app = harness();
        app.fetch.mockResolvedValue(new Response('{"error":"Cannot persist book"}'));
        expect(await app.importWorldInfo(book(), { returnResult: true })).toEqual({ ok: false, name: null, error: 'Cannot persist book' });
    });
    test('default successful return remains undefined', async () => {
        expect(await harness().importWorldInfo(book())).toBeUndefined();
    });
    test('parse errors and missing files produce results only when requested', async () => {
        const app = harness();
        expect(await app.importWorldInfo(undefined)).toBeUndefined();
        expect(await app.importWorldInfo(undefined, { returnResult: true })).toMatchObject({ ok: false, name: null });
        expect(await app.importWorldInfo(new File(['{}'], 'book.json'), { returnResult: true })).toMatchObject({ ok: false, error: 'Unsupported World Info format' });
        expect(await app.importWorldInfo(new File(['{}'], 'book.json'))).toBeUndefined();
    });
    test('cancelled overwrite preserves false for old callers and returns failure for opt-in callers', async () => {
        const app = harness();
        app.checkOverwriteExistingData.mockResolvedValue(false);
        expect(await app.importWorldInfo(book())).toBe(false);
        expect(await app.importWorldInfo(book(), { returnResult: true })).toMatchObject({ ok: false, name: null });
        expect(app.fetch).not.toHaveBeenCalled();
    });
});
