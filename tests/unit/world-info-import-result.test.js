/* eslint-disable playwright/no-standalone-expect -- Parameterized Jest tests, not Playwright. */
import { describe, expect, jest, test } from '@jest/globals';

import { event_types } from '../../public/scripts/events.js';
import { importWorldInfoModule } from '../util/world-info-module-harness.js';

async function setupImportHarness(fetchImpl) {
    const fetchMock = jest.fn(fetchImpl ?? (async (url) => {
        if (url === '/api/settings/get') {
            return new Response(JSON.stringify({ world_names: ['Server canonical name'] }));
        }
        return new Response('{"name":"Server canonical name"}');
    }));

    const { worldInfo, mocks } = await importWorldInfoModule({ fetch: fetchMock });
    worldInfo.setWorldInfoSettings({}, { world_names: [] });
    mocks.eventSource.emit.mockClear();
    return { worldInfo, mocks, fetch: fetchMock };
}

const book = () => new File(['{"entries":{}}'], 'unsafe? name.json');

describe('opt-in World Info import results', () => {
    test('returns its server canonical name, emits the normal event and releases its save block', async () => {
        const app = await setupImportHarness();
        expect(await app.worldInfo.importWorldInfo(book(), { returnResult: true })).toEqual({
            ok: true,
            name: 'Server canonical name',
            error: null,
        });
        expect(app.mocks.eventSource.emit).toHaveBeenCalledWith(
            event_types.WORLDINFO_UPDATED,
            'Server canonical name',
            { entries: {} },
            { replaced: true },
        );

        // Save block must be released so a subsequent save for the canonical name succeeds.
        app.fetch.mockResolvedValueOnce(new Response('{"name":"Server canonical name"}'));
        await expect(app.worldInfo.saveWorldInfo('Server canonical name', { entries: {} }, true)).resolves.toBe('Server canonical name');
    });

    test.each([
        ['plain server detail', 'Rejected book'],
        ['JSON server detail', '{"error":"Rejected book"}'],
    ])('%s is returned without changing legacy failure returns', async (_label, body) => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const app = await setupImportHarness(async (url) => {
            if (url === '/api/settings/get') {
                return new Response(JSON.stringify({ world_names: [] }));
            }
            return new Response(body, { status: 400, statusText: 'Bad request' });
        });

        try {
            expect(await app.worldInfo.importWorldInfo(book(), { returnResult: true })).toEqual({
                ok: false,
                name: null,
                error: 'Rejected book',
            });
            expect(await app.worldInfo.importWorldInfo(book())).toBeUndefined();
            expect(app.mocks.eventSource.emit).not.toHaveBeenCalled();

            // Failed imports must release their save block cleanly.
            app.fetch.mockResolvedValueOnce(new Response('{"name":"unsafe name"}'));
            await expect(app.worldInfo.saveWorldInfo('unsafe name', { entries: {} }, true)).resolves.toBe('unsafe name');
        } finally {
            errorSpy.mockRestore();
        }
    });

    test('JSON error envelopes do not report success', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const app = await setupImportHarness(async () => new Response('{"error":"Cannot persist book"}'));
        try {
            expect(await app.worldInfo.importWorldInfo(book(), { returnResult: true })).toEqual({
                ok: false,
                name: null,
                error: 'Cannot persist book',
            });
        } finally {
            errorSpy.mockRestore();
        }
    });

    test('default successful return remains undefined', async () => {
        const app = await setupImportHarness();
        expect(await app.worldInfo.importWorldInfo(book())).toBeUndefined();
    });

    test('parse errors and missing files produce results only when requested', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const app = await setupImportHarness();
        try {
            expect(await app.worldInfo.importWorldInfo(undefined)).toBeUndefined();
            expect(await app.worldInfo.importWorldInfo(undefined, { returnResult: true })).toMatchObject({ ok: false, name: null });
            expect(await app.worldInfo.importWorldInfo(new File(['{}'], 'book.json'), { returnResult: true })).toMatchObject({
                ok: false,
                error: 'Unsupported World Info format',
            });
            expect(await app.worldInfo.importWorldInfo(new File(['{}'], 'book.json'))).toBeUndefined();
        } finally {
            errorSpy.mockRestore();
        }
    });

    test('cancelled overwrite preserves false for old callers and returns failure for opt-in callers', async () => {
        const app = await setupImportHarness();
        app.mocks.utils.checkOverwriteExistingData.mockResolvedValue(false);
        expect(await app.worldInfo.importWorldInfo(book())).toBe(false);
        expect(await app.worldInfo.importWorldInfo(book(), { returnResult: true })).toMatchObject({ ok: false, name: null });
        expect(app.fetch).not.toHaveBeenCalled();
    });
});
