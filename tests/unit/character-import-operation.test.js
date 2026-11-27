/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from '../util/script-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

function makeResponse(body, { status = 200, statusText = '', headers = {} } = {}) {
    const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const textBody = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        headers: { get: key => headerMap.get(String(key).toLowerCase()) ?? null },
        text: async () => textBody,
        json: async () => JSON.parse(textBody),
        blob: async () => new Blob([textBody], { type: headerMap.get('content-type') || 'application/json' }),
    };
}

const makeFile = (name, type = 'application/json') => new File(['{}'], name, { type });

async function setupImportHarness({
    generating = false,
    importHandler = null,
    urlHandler = null,
    importWorldInfoImpl = null,
    importFromExternalUrlImpl = null,
    popupConfirmResult = 1,
    popupInputResult = '',
    bootReady = false,
} = {}) {
    const serverCharacters = [];
    const importFormDatas = [];

    const fetchMock = jest.fn(async (url, init = {}) => {
        if (url === '/api/characters/import') {
            const fd = init.body;
            const avatarFile = fd.get('avatar');
            importFormDatas.push({
                name: avatarFile?.name,
                preserved_name: fd.get('preserved_name'),
                file_type: fd.get('file_type'),
                import_external_media: fd.get('import_external_media'),
            });
            if (importHandler) {
                return importHandler(avatarFile, fd);
            }
            const base = avatarFile.name.split('.')[0];
            if (avatarFile.name === 'bad.json') {
                return makeResponse({ error: 'Server says invalid card' }, { status: 400 });
            }
            const avatar = `${base}.png`;
            if (!serverCharacters.some(c => c.avatar === avatar)) {
                serverCharacters.push({ avatar, name: `Name ${avatar}`, chat: `${base}-chat`, first_mes: 'Hi', data: { extensions: {} } });
            }
            return makeResponse({ file_name: base });
        }
        if (url === '/api/characters/all') {
            return makeResponse(serverCharacters);
        }
        if (url === '/api/chats/get') {
            return makeResponse([{ chat_metadata: {} }, { name: 'Char', mes: 'Hello', extra: {} }]);
        }
        if (url === '/api/content/importURL' || url === '/api/content/importUUID') {
            if (urlHandler) {
                return urlHandler(url, JSON.parse(init.body));
            }
            return makeResponse('{}', {
                headers: {
                    'X-Custom-Content-Type': 'character',
                    'Content-Disposition': 'attachment; filename="url.json"',
                    'Content-Type': 'application/json',
                },
            });
        }
        return makeResponse({});
    });

    const importTags = jest.fn(async () => {});
    const importWorldInfo = jest.fn(async (file, opts) => {
        if (importWorldInfoImpl) return importWorldInfoImpl(file, opts, loaded.eventSource, loaded.script.event_types);
        loaded.eventSource.emit(loaded.script.event_types.WORLDINFO_UPDATED, 'Unrelated book', {}, { replaced: true });
        return { ok: true, name: 'Canonical book', error: null };
    });
    const importFromExternalUrl = jest.fn(async (...args) => {
        if (importFromExternalUrlImpl) return importFromExternalUrlImpl(...args);
    });

    loaded = await importScriptModule({
        fetch: fetchMock,
        mocks: {
            'scripts/group-chats.js': {
                is_group_generating: generating,
            },
            'scripts/tags.js': {
                importTags,
                tag_import_setting: { NONE: 0, ASK: 1, ALL: 2 },
            },
            'scripts/world-info.js': {
                importWorldInfo,
            },
            'scripts/utils.js': {
                isValidUrl: value => String(value).startsWith('https://'),
                importFromExternalUrl,
            },
            'scripts/popup.js': {
                POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, CUSTOM1: 201, CUSTOM2: 202 },
                Popup: {
                    show: {
                        confirm: jest.fn(async () => popupConfirmResult),
                        input: jest.fn(async () => popupInputResult),
                    },
                },
            },
        },
    });

    if (bootReady) {
        await loaded.runReady();
        fetchMock.mockClear();
    }

    return {
        ...loaded,
        fetchMock,
        importFormDatas,
        importTags,
        importWorldInfo,
        importFromExternalUrl,
        serverCharacters,
    };
}

describe('result-bearing character import operation in script.js', () => {
    test('keeps ordered partial results, imports tags once and selects only the last success', async () => {
        const app = await setupImportHarness();

        const results = await app.script.runCharacterImport({
            files: [makeFile('first.json'), makeFile('bad.json'), makeFile('last.json')],
        });

        expect(results.map(item => item.ok)).toEqual([true, false, true]);
        expect(results[1].error).toBe('Server says invalid card');
        expect(results[2].name).toBe('Name last.png');
        expect(app.importTags).toHaveBeenCalledTimes(2);
        expect(app.importTags.mock.calls.map(([char]) => char.avatar)).toEqual(['first.png', 'last.png']);
        expect(app.script.characters[app.script.this_chid]?.avatar).toBe('last.png');
    });

    test('stay never selects, including URL characters', async () => {
        const app = await setupImportHarness();

        const items = await app.script.runCharacterImport({
            urls: ['https://example.invalid/card'],
            policy: 'stay',
        });

        expect(items[0]).toMatchObject({ kind: 'character', id: 'url.png', ok: true });
        expect(app.script.this_chid).toBeUndefined();
        expect(app.fetchMock.mock.calls.some(([url]) => url === '/api/chats/get')).toBe(false);
    });

    test('URL lorebooks reuse upstream import and return its canonical committed name', async () => {
        const app = await setupImportHarness({
            urlHandler: () => makeResponse('{}', {
                headers: {
                    'X-Custom-Content-Type': 'lorebook',
                    'Content-Disposition': 'attachment; filename*=UTF-8\'\'Book%20name.json',
                },
            }),
        });

        const result = await app.script.runCharacterImport({ urls: ['lorebooks/example/book'], policy: 'stay' });

        expect(result).toEqual([
            { kind: 'lorebook', id: 'Canonical book', name: 'Canonical book', ok: true, error: null },
        ]);
        expect(app.fetchMock.mock.calls.some(([url]) => url === '/api/content/importUUID')).toBe(true);
        expect(app.importWorldInfo.mock.calls[0][0].name).toBe('Book name.json');
        expect(app.importWorldInfo.mock.calls[0][1]).toEqual({ returnResult: true });
    });

    test('external server errors survive and do not stop the next URL', async () => {
        let count = 0;
        const app = await setupImportHarness({
            urlHandler: () => (++count === 1
                ? makeResponse('Private card', { status: 403 })
                : makeResponse('Unavailable', { status: 404 })),
        });

        const items = await app.script.runCharacterImport({ urls: ['one', 'two'] });
        expect(items.map(item => item.error)).toEqual(['Private card', 'Unavailable']);
    });

    test('unrelated WI updates cannot turn a failed lorebook import into success', async () => {
        const app = await setupImportHarness({
            urlHandler: () => makeResponse('{}', {
                headers: {
                    'X-Custom-Content-Type': 'lorebook',
                    'Content-Disposition': 'attachment; filename="book.json"',
                },
            }),
            importWorldInfoImpl: async (_file, _opts, eventSource, eventTypes) => {
                eventSource.emit(eventTypes.WORLDINFO_UPDATED, 'Other book', {}, { replaced: true });
                return { ok: false, name: null, error: 'Lorebook rejected by server' };
            },
        });

        const items = await app.script.runCharacterImport({ urls: ['lorebooks/example/book'], policy: 'stay' });
        expect(items[0]).toMatchObject({ ok: false, id: null, error: 'Lorebook rejected by server' });
    });

    test('generation preconditions reject legacy imports but become a stay result row', async () => {
        const app = await setupImportHarness({ generating: true });

        await expect(app.script.processDroppedFiles([makeFile('card.json')])).rejects.toThrow('Cannot import character while generating');
        const stayRows = await app.script.runCharacterImport({ files: [makeFile('card.json')], policy: 'stay' });
        expect(stayRows[0]).toMatchObject({ ok: false, error: 'Cannot import character while generating' });
        expect(app.fetchMock.mock.calls.some(([url]) => url === '/api/characters/import')).toBe(false);
    });

    test('generation-active file replacement never runs postReplace after its rejected import', async () => {
        const readyApp = await setupImportHarness({
            generating: true,
            popupConfirmResult: 202, // POPUP_RESULT.CUSTOM2 -> POPUP_RESULT_FILE
        });
        let dropdown = document.getElementById('char-management-dropdown');
        if (!dropdown) {
            document.body.insertAdjacentHTML('beforeend', '<select id="char-management-dropdown"></select>');
            dropdown = document.getElementById('char-management-dropdown');
        }
        dropdown.innerHTML = '<option value="">--</option><option id="replace_update" value="replace_update">Replace</option>';
        if (!document.getElementById('character_replace_file')) {
            document.body.insertAdjacentHTML('beforeend', '<input id="character_replace_file" type="file" />');
        }
        await readyApp.runReady();
        readyApp.fetchMock.mockClear();
        readyApp.script.characters.push({ avatar: 'current.png', name: 'Current', chat: 'current-chat', data: { extensions: {} } });
        readyApp.script.setCharacterId(0);

        dropdown.value = 'replace_update';
        const changeEntry = readyApp.$._data(dropdown, 'events').change[0];
        await changeEntry.handler.call(dropdown, { target: dropdown });

        const replaceInput = document.getElementById('character_replace_file');
        const uploadEntry = readyApp.$._data(replaceInput, 'events').change[0];
        await uploadEntry.handler.call(replaceInput, { target: { files: [makeFile('card.json')] } });

        expect(readyApp.fetchMock.mock.calls.some(([url]) => url === '/api/chats/get')).toBe(false);
        expect(readyApp.toastr.error).toHaveBeenCalledWith('Failed to replace the character card.', 'Something went wrong');
    });

    test('generation-active URL replacement propagates the abort and never runs postReplace', async () => {
        const app = await setupImportHarness({
            generating: true,
            popupConfirmResult: 201, // POPUP_RESULT.CUSTOM1 -> POPUP_RESULT_URL
            popupInputResult: 'https://example.invalid/card',
            importFromExternalUrlImpl: async () => {
                throw new Error('Cannot import character while generating');
            },
        });
        let dropdown = document.getElementById('char-management-dropdown');
        if (!dropdown) {
            document.body.insertAdjacentHTML('beforeend', '<select id="char-management-dropdown"></select>');
            dropdown = document.getElementById('char-management-dropdown');
        }
        dropdown.innerHTML = '<option value="">--</option><option id="replace_update" value="replace_update">Replace</option>';
        await app.runReady();
        app.fetchMock.mockClear();
        app.script.characters.push({ avatar: 'current.png', name: 'Current', chat: 'current-chat', data: { extensions: {} } });
        app.script.setCharacterId(0);

        dropdown.value = 'replace_update';
        const changeEntry = app.$._data(dropdown, 'events').change[0];
        await expect(changeEntry.handler.call(dropdown, { target: dropdown })).rejects.toThrow('Cannot import character while generating');

        expect(app.importFromExternalUrl).toHaveBeenCalledWith('https://example.invalid/card', { preserveFileName: 'current.png' });
        expect(app.fetchMock.mock.calls.some(([url]) => url === '/api/chats/get')).toBe(false);
    });

    test('legacy drops preserve the MIME gate, filename map, void return and select-last', async () => {
        const app = await setupImportHarness();
        const card = makeFile('ok.json');
        const data = new Map([[card, 'replace.png']]);

        expect(await app.script.processDroppedFiles([makeFile('ignored.json', ''), card], data)).toBeUndefined();

        expect(app.importFormDatas).toHaveLength(1);
        expect(app.importFormDatas[0]).toMatchObject({ name: 'ok.json', preserved_name: 'replace.png' });
        expect(app.script.characters[app.script.this_chid]?.avatar).toBe('ok.png');
    });

    test('picker accepts a supported extension with no MIME; invalid policies fail before imports', async () => {
        const app = await setupImportHarness();

        expect((await app.script.runCharacterImport({ files: [makeFile('plain.json', '')], policy: 'stay' }))[0].ok).toBe(true);
        await expect(app.script.runCharacterImport({ policy: 'invalid' })).rejects.toThrow('Unknown import policy');
    });

    test('real character transport preserves JSON and plain text server errors', async () => {
        let count = 0;
        const app = await setupImportHarness({
            importHandler: () => (++count === 1
                ? makeResponse('{"error":"Rejected card"}', { status: 400 })
                : makeResponse('Bad PNG', { status: 422 })),
        });

        const items = await app.script.runCharacterImport({
            files: [makeFile('bad.json'), makeFile('bad.png', 'image/png')],
        });
        expect(items.map(item => item.error)).toEqual(['Rejected card', 'Bad PNG']);
    });

    test('hidden character picker (#character_import_file) retains select-last selection contract', async () => {
        const app = await setupImportHarness();
        document.body.insertAdjacentHTML('beforeend', '<input id="character_import_file" type="file" /><div id="rm_info_avatar"></div>');
        await app.runReady();
        app.fetchMock.mockClear();

        const picker = document.getElementById('character_import_file');
        const file = makeFile('picked.json');
        Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
        const changeEntry = app.$._data(picker, 'events').change[0];
        await changeEntry.handler.call(picker, { target: picker });

        expect(app.importFormDatas).toHaveLength(1);
        expect(app.importFormDatas[0].name).toBe('picked.json');
        expect(app.script.characters[app.script.this_chid]?.avatar).toBe('picked.png');
    });
});
