/* eslint-disable playwright/no-standalone-expect -- These are parameterised Jest tests. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import lodash from 'lodash';

import { event_types } from '../public/scripts/events.js';
import { StructuredCloneMap } from '../public/scripts/util/StructuredCloneMap.js';
import { escapeCharacterBookRegex, getFreeCharacterBookEntryId, normalizeCharacterBookPosition, serializeWorldInfoEntry } from '../public/scripts/world-info-character-book.js';

const source = readFileSync(new URL('../public/scripts/world-info.js', import.meta.url), 'utf8');

function functionSource(name) {
    const match = source.match(new RegExp(`^(?:export )?((?:async )?function ${name}\\([\\s\\S]*?^})`, 'm'));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[1];
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function book() {
    return {
        entries: {
            0: { uid: 0, content: 'Original', depth: 4, extensions: { foreign: 'entry metadata' } },
            1: { uid: 1, content: 'Delete this' },
            2: { uid: 2, content: 'Update this' },
        },
        extensions: { foreign: { retained: true } },
    };
}

function createHost(initialBook = book()) {
    const books = new Map([['Lore', structuredClone(initialBook)]]);
    const holds = new Map();
    const renders = [];
    const elements = new Map();
    let editorData;
    const context = vm.createContext({
        lodash, structuredClone, Map, WeakMap, Set, TextEncoder, FormData, console,
        escapeCharacterBookRegex, getFreeCharacterBookEntryId, normalizeCharacterBookPosition, serializeWorldInfoEntry,
        setTimeout, clearTimeout, event_types,
        worldInfoCache: new StructuredCloneMap({ cloneOnGet: true, cloneOnSet: false }),
        worldInfoEditorLoadId: 0,
        world_names: ['Lore'], selected_world_info: [], world_info: {},
        power_user: {}, chat_metadata: {}, characters: [],
        debounce_timeout: { relaxed: 1000 }, MAX_WORLD_INFO_NAME_BYTES: 234,
        navigation_option: { none: -2000 }, desktopSelectedWorldInfoUid: null,
        newWorldInfoEntryTemplate: { content: '', depth: 4 },
        world_info_position: { before: 0, after: 1 }, world_info_logic: { AND_ANY: 0 },
        extension_prompt_roles: { SYSTEM: 0 }, DEFAULT_DEPTH: 4, DEFAULT_WEIGHT: 100,
        getRequestHeaders: () => ({}), getSanitizedFilename: async name => name.replace(/[/?]/g, ''),
        equalsIgnoreCaseAndAccents: (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) === 0,
        findMatchingLorebookName: (names, name) => names.find(item => item === name),
        checkOverwriteExistingData: async () => true,
        parseJsonFile: async file => JSON.parse(await file.text()),
        setValueByPath: lodash.set,
        t: (strings, ...values) => String.raw({ raw: strings }, ...values),
        toastr: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
        Popup: { show: { input: jest.fn(async () => 'Renamed') } },
        saveSettingsDebounced: jest.fn(), updateWorldInfoLinks: jest.fn(async () => {}),
        clearWorldInfoDesktopEditor: jest.fn(),
        document: { activeElement: null },
        eventSource: { emit: jest.fn(async () => {}) },
        displayWorldEntries: jest.fn(async (_name, data) => { editorData = data; }),
    });
    context.$ = value => {
        if (typeof value !== 'string') return value;
        if (!elements.has(value)) {
            const element = {
                value: value === '#world_editor_select' ? '0' : '',
                val(next) { if (arguments.length) { this.value = String(next); return this; } return this.value; },
                find() { return this; },
                prop() { return this; },
                trigger() {
                    if (value === '#world_editor_select') renders.push(context.showWorldEditor(context.world_names[Number(this.value)]));
                    return this;
                },
            };
            elements.set(value, element);
        }
        return elements.get(value);
    };
    context.updateWorldInfoList = jest.fn(async () => { context.world_names = [...books.keys()]; });
    context.fetch = jest.fn(async (url, options) => {
        const body = options.body instanceof FormData ? options.body : JSON.parse(options.body);
        const held = holds.get(url)?.shift();
        const readData = url === '/api/worldinfo/get' ? structuredClone(books.get(body.name)) : undefined;
        if (held) {
            held.started.resolve();
            const status = await held.result.promise;
            if (status !== 200) return { ok: false, status, statusText: 'Rejected' };
        }
        let result;
        switch (url) {
            case '/api/worldinfo/get':
                return { ok: Boolean(readData), json: async () => readData };
            case '/api/worldinfo/edit': {
                const name = body.name.replace(/[/?]/g, '');
                books.set(name, structuredClone(body.data));
                result = { ok: true, name };
                break;
            }
            case '/api/worldinfo/rename':
                books.delete(body.oldName);
                books.set(body.newName, structuredClone(body.data));
                result = { ok: true, name: body.newName };
                break;
            case '/api/worldinfo/delete':
                books.delete(body.name);
                break;
            case '/api/worldinfo/import': {
                const name = String(body.get('name'));
                books.set(name, JSON.parse(String(body.get('convertedData') ?? await body.get('avatar').text())));
                result = { name };
                break;
            }
            default: throw new Error(`Unexpected request ${url}`);
        }
        return { ok: true, json: async () => result };
    });
    vm.runInContext(source.slice(source.indexOf('const pendingWorldInfoSaves'), source.indexOf('const saveSettingsDebounced')), context);
    const functions = [
        'reloadEditor', 'showWorldEditor', 'hideWorldEditor', 'loadWorldInfo',
        'cloneWorldInfoData', 'getWorldInfoCachedData', 'mergeWorldInfoData', 'mergeWorldInfoChanges', 'trackWorldInfoEntryRender', 'invalidateWorldInfoCache', '_save', 'cancelPendingWorldInfoSave',
        'settleWorldInfoSave', 'blockWorldInfoSaves', 'getCanonicalWorldInfoName', 'saveWorldInfo',
        'replaceWorldInfoData', 'renameWorldInfo', 'deleteWorldInfo', 'importWorldInfo',
        'getWIOriginalDataIndex', 'setWIOriginalDataValue', 'deleteWIOriginalDataValue', 'syncWIOriginalDataEntry', 'duplicateWorldInfoEntry',
        'getFreeWorldEntryUid', 'createWorldInfoEntry', 'appendWIOriginalDataEntry', 'handleNumberInputHelper',
        'convertCharacterBook', 'parseRegexFromString',
    ];
    vm.runInContext(functions.map(functionSource).join('\n'), context);
    return {
        context, books,
        get editorData() { return editorData; },
        async render() { await Promise.all(renders.splice(0)); },
        hold(url = '/api/worldinfo/edit') {
            const held = { started: deferred(), result: deferred() };
            if (!holds.has(url)) holds.set(url, []);
            holds.get(url).push(held);
            return held;
        },
        nativeDepthInput() {
            const handlers = new Map();
            const metadata = new Map();
            const input = {
                value: '',
                data(key, value) { if (arguments.length > 1) { metadata.set(key, value); return this; } return metadata.get(key); },
                val(value) { if (arguments.length) { this.value = value; return this; } return this.value; },
                on(event, handler) { handlers.set(event, handler); return this; },
                off(event) { handlers.delete(event); return this; },
                one(event, handler) { handlers.set(event, handler); return this; },
                matches: () => true, closest: () => true,
                async edit(value) { this.value = value; await handlers.get('input').call(this); },
                blur() {
                    context.document.activeElement = null;
                    handlers.get('blur.worldInfoReload')?.();
                },
            };
            context.handleNumberInputHelper({ inputElem: input, entry: editorData.entries[0], entryKey: 'depth', data: editorData, name: 'Lore', min: 0, max: 100 });
            context.document.activeElement = input;
            return input;
        },
    };
}

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe('shared World Info saves', () => {
    test.each(['create', 'duplicate'])('stale native %s avoids card IDs reserved in the latest cache', async operation => {
        const host = createHost();
        const { context } = host;
        const imported = context.convertCharacterBook({ entries: [
            { id: 74, content: 'First', foreign: 'kept' },
            { id: 0, content: 'Second' },
        ] });
        await context.replaceWorldInfoData('Lore', imported);
        const native = await context.loadWorldInfo('Lore');
        const external = await context.loadWorldInfo('Lore');
        const externalEntry = context.createWorldInfoEntry('Lore', external);
        externalEntry.content = 'External';
        context.syncWIOriginalDataEntry(external, externalEntry.uid);
        const held = host.hold();
        const externalSave = context.saveWorldInfo('Lore', external, true);
        await held.started.promise;

        const nativeEntry = operation === 'create'
            ? context.createWorldInfoEntry('Lore', native) : context.duplicateWorldInfoEntry(native, 0);
        nativeEntry.content = 'Native';
        context.syncWIOriginalDataEntry(native, nativeEntry.uid);
        const nativeSave = context.saveWorldInfo('Lore', native, true);
        held.result.resolve(200);
        await externalSave;
        await nativeSave;

        const saved = host.books.get('Lore');
        expect([externalEntry.uid, nativeEntry.uid]).toEqual([2, 3]);
        expect(saved.originalData.entries.map(entry => entry.id)).toEqual([74, 0, 1, 2]);
        expect(saved.originalData.entries[saved.originalDataUidMap[externalEntry.uid]]).toMatchObject({ id: 1, content: 'External' });
        expect(saved.originalData.entries[saved.originalDataUidMap[nativeEntry.uid]]).toMatchObject({ id: 2, content: 'Native' });
        expect(saved.originalData.entries[0]).toMatchObject({ id: 74, content: 'First', foreign: 'kept' });
    });

    test('a duplicate retains allocated card ID zero rather than its source card ID', async () => {
        const host = createHost();
        const native = host.context.convertCharacterBook({ entries: [{ id: 74, content: 'Original', foreign: 'kept' }] });
        const duplicate = host.context.duplicateWorldInfoEntry(native, 0);
        host.context.syncWIOriginalDataEntry(native, duplicate.uid);
        expect(duplicate.uid).toBe(1);
        expect(native.originalData.entries.map(entry => entry.id)).toEqual([74, 0]);
        expect(native.originalData.entries[1]).toMatchObject({ id: 0, foreign: 'kept', content: 'Original' });
    });

    test('a stale native edit cannot resurrect a deleted entry', async () => {
        const host = createHost();
        await host.context.showWorldEditor('Lore');
        host.nativeDepthInput();
        const native = host.editorData;
        const external = await host.context.loadWorldInfo('Lore');
        delete external.entries[0];
        await host.context.saveWorldInfo('Lore', external, true);

        native.entries[0].depth = 99;
        const result = await host.context.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').entries).not.toHaveProperty('0');
        expect(result).toBeNull();
    });

    test.each(['edit', 'delete'])('a stale native %s cannot target a replacement with the same UID and contents', async operation => {
        const host = createHost();
        await host.context.showWorldEditor('Lore');
        host.nativeDepthInput();
        const native = host.editorData;
        const original = structuredClone(native.entries[0]);
        const external = await host.context.loadWorldInfo('Lore');
        delete external.entries[0];
        await host.context.saveWorldInfo('Lore', external, true);
        const replacement = await host.context.loadWorldInfo('Lore');
        const entry = host.context.createWorldInfoEntry('Lore', replacement);
        expect(entry.uid).toBe(0);
        Object.assign(entry, original);
        await host.context.saveWorldInfo('Lore', replacement, true);

        if (operation === 'edit') native.entries[0].depth = 99;
        else delete native.entries[0];
        const result = await host.context.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').entries[0]).toEqual(original);
        expect(result).toBeNull();
    });

    test('a failed immediate external save cannot lose the native delayed edit it superseded', async () => {
        jest.useFakeTimers();
        const host = createHost();
        await host.context.showWorldEditor('Lore');
        const native = host.editorData;
        await host.nativeDepthInput().edit(8);
        const external = await host.context.loadWorldInfo('Lore');
        external.entries[2].content = 'Fail this external write';
        const fetch = host.context.fetch;
        host.context.fetch = jest.fn((url, options) => {
            const data = JSON.parse(options.body).data;
            return url === '/api/worldinfo/edit' && data.entries[2]?.content === 'Fail this external write'
                ? Promise.resolve({ ok: false, status: 500 }) : fetch(url, options);
        });
        await expect(host.context.saveWorldInfo('Lore', external, true)).rejects.toThrow('World Info save failed');

        native.entries[1].content = 'Later native edit';
        await host.context.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(8);
        expect(host.books.get('Lore').entries[1].content).toBe('Later native edit');
        expect(host.books.get('Lore').entries[2].content).toBe('Update this');
    });

    test('unrelated native saves preserve a reused entry without adopting its instance', async () => {
        const host = createHost();
        await host.context.showWorldEditor('Lore');
        host.nativeDepthInput();
        const native = host.editorData;
        const external = await host.context.loadWorldInfo('Lore');
        delete external.entries[0];
        await host.context.saveWorldInfo('Lore', external, true);
        const replacement = await host.context.loadWorldInfo('Lore');
        Object.assign(host.context.createWorldInfoEntry('Lore', replacement), book().entries[0]);
        await host.context.saveWorldInfo('Lore', replacement, true);

        native.entries[1].content = 'Unrelated native edit';
        await expect(host.context.saveWorldInfo('Lore', native, true)).resolves.toBe('Lore');
        expect(host.books.get('Lore').entries[0]).toEqual(book().entries[0]);
        const fresh = await host.context.loadWorldInfo('Lore');
        fresh.entries[0].depth = 6;
        await expect(host.context.saveWorldInfo('Lore', fresh, true)).resolves.toBe('Lore');
        delete native.entries[0];
        await expect(host.context.saveWorldInfo('Lore', native, true)).resolves.toBeNull();
        expect(host.books.get('Lore').entries[0].depth).toBe(6);
        expect(host.books.get('Lore').entries[1].content).toBe('Unrelated native edit');
        expect(Object.keys(host.books.get('Lore'))).toEqual(['entries', 'extensions']);
        expect(Object.getOwnPropertySymbols(fresh)).toEqual([]);
    });

    test('a failed deletion does not invalidate the committed entry instance', async () => {
        const host = createHost();
        const native = await host.context.loadWorldInfo('Lore');
        const external = await host.context.loadWorldInfo('Lore');
        delete external.entries[0];
        const held = host.hold();
        const saving = host.context.saveWorldInfo('Lore', external, true);
        const rejected = saving.catch(error => error);
        await held.started.promise;
        native.entries[0].depth = 8;
        await expect(host.context.saveWorldInfo('Lore', native, true)).resolves.toBeNull();
        held.result.resolve(500);
        expect(await rejected).toHaveProperty('message', 'World Info save failed with status 500');
        await expect(host.context.saveWorldInfo('Lore', native, true)).resolves.toBe('Lore');
        expect(host.books.get('Lore').entries[0].depth).toBe(8);
    });

    test.each(['replace', 'import'])('a completed %s invalidates old entry instances even when the book is identical', async operation => {
        const host = createHost();
        const native = await host.context.loadWorldInfo('Lore');
        if (operation === 'replace') await host.context.replaceWorldInfoData('Lore', book());
        else await host.context.importWorldInfo(new File([JSON.stringify(book())], 'Lore.json'));
        delete native.entries[0];
        await expect(host.context.saveWorldInfo('Lore', native, true)).resolves.toBeNull();
        expect(host.books.get('Lore')).toEqual(book());
    });

    test('a rejected stale imported entry edit leaves both native and original entry records intact', async () => {
        const host = createHost();
        const card = { entries: [{ id: 42, content: 'Original', extensions: { foreign: true } }] };
        await host.context.replaceWorldInfoData('Lore', host.context.convertCharacterBook(card));
        const native = await host.context.loadWorldInfo('Lore');
        const external = await host.context.loadWorldInfo('Lore');
        delete external.entries[0];
        host.context.deleteWIOriginalDataValue(external, 0);
        await host.context.saveWorldInfo('Lore', external, true);
        native.entries[0].content = 'Stale';
        host.context.setWIOriginalDataValue(native, 0, 'content', 'Stale');
        await expect(host.context.saveWorldInfo('Lore', native, true)).resolves.toBeNull();
        expect(host.books.get('Lore')).toMatchObject({ entries: {}, originalData: { entries: [] }, originalDataUidMap: {} });
    });

    test('a successful external edit is not reverted when the native writer saves again', async () => {
        jest.useFakeTimers();
        const host = createHost();
        await host.context.showWorldEditor('Lore');
        const native = host.editorData;
        await host.nativeDepthInput().edit(8);
        const external = await host.context.loadWorldInfo('Lore');
        external.entries[0].depth = 10;
        await host.context.saveWorldInfo('Lore', external, true);
        native.entries[1].content = 'Later native edit';
        await host.context.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(10);
        expect(host.books.get('Lore').entries[1].content).toBe('Later native edit');
    });

    test('newer native edits remain queued when the external save behind its flushed draft fails', async () => {
        jest.useFakeTimers();
        const host = createHost();
        await host.context.showWorldEditor('Lore');
        const native = host.editorData;
        const input = host.nativeDepthInput();
        await input.edit(8);
        const external = await host.context.loadWorldInfo('Lore');
        external.entries[2].content = 'External';
        const nativeWrite = host.hold();
        const externalWrite = host.hold();
        const saving = host.context.saveWorldInfo('Lore', external, true);
        const rejected = saving.catch(error => error);
        await nativeWrite.started.promise;
        await input.edit(9);
        const latestSave = host.context.saveWorldInfo('Lore', native, true);
        nativeWrite.result.resolve(200);
        await externalWrite.started.promise;
        externalWrite.result.resolve(500);
        expect(await rejected).toHaveProperty('message', 'World Info save failed with status 500');
        await latestSave;
        expect(host.books.get('Lore').entries[0].depth).toBe(9);
        expect(host.context.worldInfoCache.get('Lore')).toEqual(host.books.get('Lore'));
    });

    test('reloading cannot restore an invalid stale draft into the native editor', async () => {
        const host = createHost();
        await host.context.showWorldEditor('Lore');
        const native = host.editorData;
        const external = await host.context.loadWorldInfo('Lore');
        delete external.entries[0];
        const held = host.hold();
        const saving = host.context.saveWorldInfo('Lore', external, true);
        await held.started.promise;
        native.entries[0].depth = 99;
        held.result.resolve(200);
        await saving;
        await host.render();
        expect(host.editorData.entries).not.toHaveProperty('0');
    });

    test('background saves do not select a lorebook when the native editor has no selection', async () => {
        const host = createHost();
        host.context.$('#world_editor_select').val('');
        await host.context.saveWorldInfo('Lore', book(), true);
        await host.render();
        expect(host.context.displayWorldEntries).not.toHaveBeenCalled();
        host.context.reloadEditor('Lore', true);
        await host.render();
        expect(host.context.displayWorldEntries).toHaveBeenCalled();
    });

    test('an open native editor preserves external creation, deletion, updates and book metadata', async () => {
        jest.useFakeTimers();
        const host = createHost();
        const { context, books } = host;
        await context.showWorldEditor('Lore');
        const input = host.nativeDepthInput();
        const external = await context.loadWorldInfo('Lore');
        const created = context.createWorldInfoEntry('Lore', external);
        created.content = 'Created externally';
        delete external.entries[1];
        external.entries[2].content = 'External update';
        external.extensions.sillybunny_pathfinder = { version: 1, tree: { id: 'root', children: [] } };

        await expect(context.saveWorldInfo('Lore', external, true)).resolves.toBe('Lore');
        await input.edit(8);
        await context.settleWorldInfoSave('Lore');

        expect(books.get('Lore')).toMatchObject({
            entries: { 0: { depth: 8, extensions: { foreign: 'entry metadata' } }, 2: { content: 'External update' }, 3: { content: 'Created externally' } },
            extensions: external.extensions,
        });
        expect(books.get('Lore').entries).not.toHaveProperty('1');
        input.blur();
        jest.runOnlyPendingTimers();
        await host.render();
        expect(host.editorData).toEqual(books.get('Lore'));
    });

    test('native edits made during a pending external save survive its completion and editor reload', async () => {
        jest.useFakeTimers();
        const host = createHost();
        const { context, books } = host;
        await context.showWorldEditor('Lore');
        const input = host.nativeDepthInput();
        const external = await context.loadWorldInfo('Lore');
        external.entries[0].content = 'External content';
        const held = host.hold();
        const saving = context.saveWorldInfo('Lore', external, true);
        await held.started.promise;

        await input.edit(9);
        held.result.resolve(200);
        await saving;
        expect(context.worldInfoCache.get('Lore').entries[0].depth).toBe(9);
        await input.edit(10);
        await context.settleWorldInfoSave('Lore');
        expect(books.get('Lore').entries[0]).toMatchObject({ content: 'External content', depth: 10 });
        input.blur();
        jest.runOnlyPendingTimers();
        await host.render();
        expect(host.editorData.entries[0]).toMatchObject({ content: 'External content', depth: 10 });
        const firstWrite = JSON.parse(context.fetch.mock.calls.find(([url]) => url === '/api/worldinfo/edit')[1].body);
        expect(firstWrite.data.entries[0].depth).toBe(4);
    });

    test('reload preserves native model changes not yet submitted to the shared saver', async () => {
        const host = createHost();
        await host.context.showWorldEditor('Lore');
        const external = await host.context.loadWorldInfo('Lore');
        external.entries[2].content = 'External content';
        const held = host.hold();
        const saving = host.context.saveWorldInfo('Lore', external, true);
        await held.started.promise;
        host.editorData.entries[0].depth = 11;
        held.result.resolve(200);
        await saving;
        await host.render();
        expect(host.editorData.entries[0].depth).toBe(11);
        await host.context.saveWorldInfo('Lore', host.editorData, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(11);
        expect(host.books.get('Lore').entries[2].content).toBe('External content');
    });

    test('a copy loaded before a native save only changes its own fields', async () => {
        const host = createHost();
        const native = await host.context.loadWorldInfo('Lore');
        const external = await host.context.loadWorldInfo('Lore');
        native.entries[0].depth = 12;
        await host.context.saveWorldInfo('Lore', native, true);
        external.entries[0].content = 'External content';
        await host.context.saveWorldInfo('Lore', external, true);
        native.entries[0].extensions.foreign = 'Updated metadata';
        await host.context.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').entries[0]).toMatchObject({ content: 'External content', depth: 12, extensions: { foreign: 'Updated metadata' } });
    });

    test('native saves preserve independently cloned external data and unchanged event identity', async () => {
        const host = createHost();
        const native = await host.context.loadWorldInfo('Lore');
        const external = structuredClone(await host.context.loadWorldInfo('Lore'));
        external.entries[2].content = 'External content';
        await host.context.saveWorldInfo('Lore', external, true);
        expect(host.context.eventSource.emit.mock.calls[0][2]).toBe(external);
        native.entries[0].depth = 12;
        await host.context.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(12);
        expect(host.books.get('Lore').entries[2].content).toBe('External content');
    });

    test('native creation does not reuse a UID allocated by a pending external save', async () => {
        const host = createHost();
        const native = await host.context.loadWorldInfo('Lore');
        const external = await host.context.loadWorldInfo('Lore');
        const externalEntry = host.context.createWorldInfoEntry('Lore', external);
        externalEntry.content = 'External';
        const held = host.hold();
        const saving = host.context.saveWorldInfo('Lore', external, true);
        await held.started.promise;
        const nativeEntry = host.context.createWorldInfoEntry('Lore', native);
        nativeEntry.content = 'Native';
        expect(nativeEntry.uid).not.toBe(externalEntry.uid);
        const nativeSave = host.context.saveWorldInfo('Lore', native, true);
        held.result.resolve(200);
        await saving;
        await nativeSave;
        expect(host.books.get('Lore').entries[externalEntry.uid].content).toBe('External');
        expect(host.books.get('Lore').entries[nativeEntry.uid].content).toBe('Native');
    });

    test('editor initialisation is not treated as an edit to native or imported fields', async () => {
        const initial = book();
        initial.originalData = { entries: [{ id: 0, content: 'Original', extensions: {} }] };
        const host = createHost(initial);
        const native = await host.context.loadWorldInfo('Lore');
        native.entries[0].depth = 8;
        const finishRender = host.context.trackWorldInfoEntryRender(native, 0);
        native.entries[0].excludeRecursion = false;
        host.context.setWIOriginalDataValue(native, 0, 'extensions.exclude_recursion', false);
        finishRender();
        const external = await host.context.loadWorldInfo('Lore');
        external.entries[0].excludeRecursion = true;
        host.context.setWIOriginalDataValue(external, 0, 'extensions.exclude_recursion', true);
        await host.context.saveWorldInfo('Lore', external, true);
        await host.context.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').entries[0]).toMatchObject({ depth: 8, excludeRecursion: true });
        expect(host.books.get('Lore').originalData.entries[0].extensions.exclude_recursion).toBe(true);
    });

    test('rejected optimistic data is absent from a fresh load and can be retried without false duplicates', async () => {
        const host = createHost();
        const external = await host.context.loadWorldInfo('Lore');
        contextCreate(external);
        const held = host.hold();
        const saving = host.context.saveWorldInfo('Lore', external, true);
        const rejection = saving.catch(error => error);
        await held.started.promise;
        held.result.resolve(500);
        expect(await rejection).toHaveProperty('message', 'World Info save failed with status 500');

        expect(host.context.worldInfoCache.has('Lore')).toBe(false);
        const retry = await host.context.loadWorldInfo('Lore');
        expect(retry.entries).not.toHaveProperty('3');
        contextCreate(retry);
        await expect(host.context.saveWorldInfo('Lore', retry, true)).resolves.toBe('Lore');
        expect(host.books.get('Lore').entries[3].content).toBe('Created externally');

        function contextCreate(data) {
            host.context.createWorldInfoEntry('Lore', data).content = 'Created externally';
        }
    });

    test.each([false, true])('an older failure cannot invalidate a newer snapshot (identical data: %s)', async (identical) => {
        const host = createHost();
        const first = await host.context.loadWorldInfo('Lore');
        const second = await host.context.loadWorldInfo('Lore');
        first.entries[0].content = 'First';
        if (identical) second.entries[0].content = 'First';
        else second.entries[2].content = 'Second';
        const held = host.hold();
        const firstSave = host.context.saveWorldInfo('Lore', first, true);
        const rejection = firstSave.catch(error => error);
        await held.started.promise;
        const secondSave = host.context.saveWorldInfo('Lore', second, true);
        const optimistic = host.context.worldInfoCache.get('Lore');
        held.result.resolve(500);
        expect(await rejection).toHaveProperty('message', 'World Info save failed with status 500');
        expect(host.context.worldInfoCache.get('Lore')).toEqual(optimistic);
        await secondSave;
        expect(host.context.worldInfoCache.get('Lore')).toEqual(host.books.get('Lore'));
    });

    test('overlapping failures on a reused object retain all changes on retry', async () => {
        const host = createHost();
        const data = await host.context.loadWorldInfo('Lore');
        const first = host.hold();
        const second = host.hold();
        data.entries[0].depth = 20;
        const one = host.context.saveWorldInfo('Lore', data, true);
        const rejectedOne = one.catch(error => error);
        await first.started.promise;
        data.entries[2].content = 'Second';
        const two = host.context.saveWorldInfo('Lore', data, true);
        const rejectedTwo = two.catch(error => error);
        first.result.resolve(500);
        expect(await rejectedOne).toHaveProperty('message', 'World Info save failed with status 500');
        await second.started.promise;
        second.result.resolve(500);
        expect(await rejectedTwo).toHaveProperty('message', 'World Info save failed with status 500');
        expect(host.context.worldInfoCache.has('Lore')).toBe(false);
        await host.context.loadWorldInfo('Lore');
        await host.context.saveWorldInfo('Lore', data, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(20);
        expect(host.books.get('Lore').entries[2].content).toBe('Second');
    });

    test('debouncing snapshots input and reports a background rejection without poisoning the cache', async () => {
        jest.useFakeTimers();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const host = createHost();
        const data = await host.context.loadWorldInfo('Lore');
        data.entries[0].depth = 6;
        await expect(host.context.saveWorldInfo('Lore', data)).resolves.toBeUndefined();
        data.entries[0].depth = 7;
        expect(host.context.worldInfoCache.get('Lore').entries[0].depth).toBe(6);
        const held = host.hold();
        held.result.resolve(500);
        const reported = deferred();
        host.context.toastr.error.mockImplementation(() => reported.resolve());
        jest.runOnlyPendingTimers();
        await reported.promise;
        expect(host.context.toastr.error).toHaveBeenCalled();
        expect(host.context.worldInfoCache.has('Lore')).toBe(false);
        await host.context.saveWorldInfo('Lore', data, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(7);
    });

    test('a later failed save restores a prior committed baseline, not a cancelled debounce', async () => {
        jest.useFakeTimers();
        const host = createHost();
        const data = await host.context.loadWorldInfo('Lore');
        data.entries[0].depth = 5;
        await host.context.saveWorldInfo('Lore', data, true);
        data.entries[0].depth = 6;
        await host.context.saveWorldInfo('Lore', data);
        data.entries[2].content = 'Draft';
        const held = host.hold();
        const saving = host.context.saveWorldInfo('Lore', data, true);
        const rejection = saving.catch(error => error);
        await held.started.promise;
        held.result.reject(new Error('Offline'));
        expect(await rejection).toHaveProperty('message', 'Offline');
        await host.context.loadWorldInfo('Lore');
        await host.context.saveWorldInfo('Lore', data, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(6);
        expect(host.books.get('Lore').entries[2].content).toBe('Draft');
    });

    test('repeated debounced edits do not retain a book-sized snapshot for every keystroke', async () => {
        jest.useFakeTimers();
        const host = createHost();
        const data = await host.context.loadWorldInfo('Lore');
        for (let depth = 1; depth <= 50; depth++) {
            data.entries[0].depth = depth;
            await host.context.saveWorldInfo('Lore', data);
        }
        const baselineDepth = vm.runInContext('(data) => { let count = 0; for (let record = worldInfoDataSnapshots.get(data); record; record = record.previous) count++; return count; }', host.context);
        expect(baselineDepth(data)).toBe(2);
        await host.context.settleWorldInfoSave('Lore');
        expect(host.books.get('Lore').entries[0].depth).toBe(50);
    });

    test.each([['', {}], ['Lore', null], ['Lore', []], ['Lore', {}], ['Lore', { entries: [] }], ['Lore', { entries: { 0: null } }]])('invalid arguments resolve null (%s, %j)', async (name, data) => {
        const host = createHost();
        await expect(host.context.saveWorldInfo(name, data, true)).resolves.toBeNull();
        expect(host.context.fetch).not.toHaveBeenCalled();
    });

    test('immediate saves return the actual canonical server name', async () => {
        const host = createHost();
        await expect(host.context.saveWorldInfo('New/Book', { entries: {} }, true)).resolves.toBe('NewBook');
        expect(host.context.worldInfoCache.has('New/Book')).toBe(false);
        expect(host.context.worldInfoCache.get('NewBook')).toEqual({ entries: {} });
    });

    test('merges imported entry records by mapped UID while preserving card IDs and unknown metadata', async () => {
        const imported = book();
        imported.originalData = {
            extensions: { foreign: 'book metadata' },
            entries: [2, 0, 1].map(uid => ({ id: uid + 40, content: imported.entries[uid].content, extensions: { foreign: `original-${uid}` } })),
        };
        imported.originalDataUidMap = { 2: 0, 0: 1, 1: 2 };
        const host = createHost(imported);
        const native = await host.context.loadWorldInfo('Lore');
        const external = await host.context.loadWorldInfo('Lore');
        delete external.entries[1];
        host.context.deleteWIOriginalDataValue(external, '1');
        external.entries[3] = { uid: 3, content: 'New', extensions: { sillybunny_pathfinder: { version: 1, nodeId: 'node' } } };
        external.originalData.entries.push({ id: 3, content: 'New', extensions: external.entries[3].extensions });
        external.originalDataUidMap[3] = 2;
        external.extensions.sillybunny_pathfinder = external.originalData.extensions.sillybunny_pathfinder = { version: 1, tree: { id: 'root' } };
        await host.context.saveWorldInfo('Lore', external, true);
        native.entries[0].content = 'Native draft';
        host.context.setWIOriginalDataValue(native, 0, 'content', 'Native draft');
        await host.context.saveWorldInfo('Lore', native, true);
        const saved = host.books.get('Lore');
        expect(saved.originalData.entries.map(entry => entry.id)).toEqual([42, 40, 3]);
        expect(saved.originalData.entries[1]).toMatchObject({ content: 'Native draft', extensions: { foreign: 'original-0' } });
        expect(saved.originalData.entries[2].extensions).toEqual(external.entries[3].extensions);
        expect(saved.originalData.extensions).toEqual(external.originalData.extensions);
        expect(saved.originalDataUidMap).toEqual({ 2: 0, 0: 1, 3: 2 });
        expect(saved.entries).not.toHaveProperty('1');
    });

    test('foreign metadata keys cannot modify object prototypes during a merge', () => {
        const host = createHost();
        const draft = JSON.parse('{"entries":{},"extensions":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}');
        const merged = host.context.mergeWorldInfoData({ entries: {}, extensions: {} }, draft, { entries: {}, extensions: { retained: true } });
        expect(merged.extensions).toHaveProperty('retained', true);
        expect(Object.hasOwn(merged.extensions, '__proto__')).toBe(true);
        expect({}.polluted).toBeUndefined();
    });

    test('independent additions to a previously absent extensions object preserve both namespaces', () => {
        const host = createHost();
        const merged = host.context.mergeWorldInfoData({ entries: {} }, { entries: {}, extensions: { native: true } }, { entries: {}, extensions: { external: true } });
        expect(merged.extensions).toEqual({ native: true, external: true });
    });
});

describe('World Info lifecycle coordination', () => {
    test('the native duplicate action copies current metadata and announces the installed replacement', async () => {
        const host = createHost();
        const { context } = host;
        context.name = 'Lore';
        context.data = await context.loadWorldInfo('Lore');
        const external = await context.loadWorldInfo('Lore');
        external.extensions.sillybunny_pathfinder = { version: 1, tree: { id: 'root' } };
        await context.saveWorldInfo('Lore', external, true);
        context.data.entries[0].depth = 6;
        host.books.set('Copy', { entries: {}, extensions: { obsolete: true } });
        context.world_names.push('Copy');
        await context.loadWorldInfo('Copy');
        context.Popup.show.input.mockResolvedValue('Co/py');
        context.getFreeWorldName = () => 'Lore (1)';
        const start = source.indexOf('$(\'#world_duplicate\').off(\'click\').on(\'click\', async () => {');
        const end = source.indexOf('\n    });', start);
        const duplicate = vm.runInContext(`(${source.slice(source.indexOf('async () => {', start), end)}\n})`, context);
        await duplicate();
        const copied = host.books.get('Copy');
        expect(copied.extensions).toEqual(external.extensions);
        expect(copied.entries[0].depth).toBe(6);
        expect(copied).not.toHaveProperty('originalData');
        expect(context.worldInfoCache.get('Copy')).toEqual(copied);
        expect(context.eventSource.emit).toHaveBeenLastCalledWith(event_types.WORLDINFO_UPDATED, 'Copy', copied, { replaced: true });
    });

    test('converted card imports publish and cache the installed native data, not the old book', async () => {
        const host = createHost();
        await host.context.loadWorldInfo('Lore');
        const characterBook = {
            extensions: { foreign: true, sillybunny_pathfinder: { version: 1, tree: { id: 'root' } } },
            entries: [{ id: 42, content: 'Imported', extensions: { sillybunny_pathfinder: { version: 1, nodeId: 'root' } } }],
        };
        await host.context.importWorldInfo(new File([JSON.stringify({ spec: 'lorebook_v3', data: characterBook })], 'Lore.json'));
        const saved = host.books.get('Lore');
        expect(saved.entries[0]).toMatchObject({ uid: 0, content: 'Imported', extensions: characterBook.entries[0].extensions });
        expect(saved.extensions).toEqual(characterBook.extensions);
        expect(saved.originalData).toEqual(characterBook);
        expect(host.context.worldInfoCache.get('Lore')).toEqual(saved);
        expect(host.context.eventSource.emit).toHaveBeenLastCalledWith(event_types.WORLDINFO_UPDATED, 'Lore', saved, { replaced: true });
    });

    test('a save redirected by rename also honours a subsequent target deletion block', async () => {
        const host = createHost();
        const releaseRename = host.context.blockWorldInfoSaves('Lore');
        const releaseDelete = host.context.blockWorldInfoSaves('Renamed');
        const saving = host.context.saveWorldInfo('Lore', book(), true);
        releaseRename('Renamed');
        await Promise.resolve();
        releaseDelete(null);
        await expect(saving).resolves.toBeNull();
        expect(host.context.fetch).not.toHaveBeenCalled();
    });

    test('replacement flushes a queued native edit before installing new data, with no later resurrection', async () => {
        jest.useFakeTimers();
        const host = createHost();
        const data = await host.context.loadWorldInfo('Lore');
        data.entries[0].depth = 8;
        await host.context.saveWorldInfo('Lore', data);
        const replacement = { entries: { 7: { uid: 7, content: 'Replacement' } } };
        await host.context.replaceWorldInfoData('Lore', replacement);
        jest.runOnlyPendingTimers();
        expect(host.books.get('Lore')).toEqual(replacement);
        expect(host.context.worldInfoCache.get('Lore')).toEqual(replacement);
        expect(host.context.fetch.mock.calls.filter(([url]) => url === '/api/worldinfo/edit')).toHaveLength(2);
        expect(host.context.eventSource.emit).toHaveBeenLastCalledWith(event_types.WORLDINFO_UPDATED, 'Lore', replacement, { replaced: true });
    });

    test('rename keeps newer external data and retargets a blocked save to its committed name', async () => {
        const host = createHost();
        const staleEditor = await host.context.loadWorldInfo('Lore');
        const external = await host.context.loadWorldInfo('Lore');
        external.extensions.sillybunny_pathfinder = { version: 1, tree: { id: 'root' } };
        await host.context.saveWorldInfo('Lore', external, true);
        const held = host.hold('/api/worldinfo/rename');
        const renaming = host.context.renameWorldInfo('Lore', staleEditor);
        await held.started.promise;
        staleEditor.entries[0].depth = 9;
        const saving = host.context.saveWorldInfo('Lore', staleEditor, true);
        held.result.resolve(200);
        await renaming;
        await expect(saving).resolves.toBe('Renamed');
        expect(host.books.has('Lore')).toBe(false);
        expect(host.context.worldInfoCache.has('Lore')).toBe(false);
        expect(host.books.get('Renamed')).toMatchObject({ entries: { 0: { depth: 9 } }, extensions: external.extensions });
        expect(host.context.eventSource.emit).toHaveBeenCalledWith(event_types.WORLDINFO_RENAMED, 'Lore', 'Renamed');
    });

    test.each(['delete', 'replace', 'import'])('%s discards blocked saves and publishes only installed data', async operation => {
        const host = createHost();
        await host.context.showWorldEditor('Lore');
        const staleEditor = host.editorData;
        const replacement = { entries: { 9: { uid: 9, content: 'Replacement' } }, extensions: { new: true } };
        const held = host.hold(`/api/worldinfo/${operation === 'replace' ? 'edit' : operation}`);
        const observed = [];
        host.context.eventSource.emit.mockImplementation(async (event, name, data, details) => {
            if (event === event_types.WORLDINFO_DELETED) observed.push(host.context.worldInfoCache.has(name));
            if (details?.replaced) observed.push(await host.context.loadWorldInfo(name));
        });
        const changing = operation === 'delete' ? host.context.deleteWorldInfo('Lore')
            : operation === 'replace' ? host.context.replaceWorldInfoData('Lore', replacement)
                : host.context.importWorldInfo(new File([JSON.stringify(replacement)], 'Lore.json'));
        await held.started.promise;
        staleEditor.entries[0].depth = 99;
        const saving = host.context.saveWorldInfo('Lore', staleEditor, true);
        held.result.resolve(200);
        await changing;
        await expect(saving).resolves.toBeNull();
        expect(host.books.get('Lore')).toEqual(operation === 'delete' ? undefined : replacement);
        expect(observed).toEqual(operation === 'delete' ? [false] : [replacement]);
        const calls = host.context.eventSource.emit.mock.calls;
        expect(calls).toEqual(operation === 'delete'
            ? [[event_types.WORLDINFO_DELETED, 'Lore']]
            : [[event_types.WORLDINFO_UPDATED, 'Lore', replacement, { replaced: true }]]);
    });

    test.each(['rename', 'delete', 'replace', 'import'])('failed %s does not announce success or discard waiting edits', async operation => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const host = createHost();
        const data = await host.context.loadWorldInfo('Lore');
        const held = host.hold(`/api/worldinfo/${operation === 'replace' ? 'edit' : operation}`);
        const changing = operation === 'rename' ? host.context.renameWorldInfo('Lore', data)
            : operation === 'delete' ? host.context.deleteWorldInfo('Lore')
                : operation === 'replace' ? host.context.replaceWorldInfoData('Lore', { entries: {} })
                    : host.context.importWorldInfo(new File(['{"entries":{}}'], 'Lore.json'));
        const settled = changing.catch(error => error);
        await held.started.promise;
        data.entries[0].depth = 17;
        const saving = host.context.saveWorldInfo('Lore', data, true);
        held.result.resolve(500);
        expect((await settled)?.message).toBe(operation === 'replace' ? 'World Info save failed with status 500' : undefined);
        await expect(saving).resolves.toBe('Lore');
        expect(host.books.get('Lore').entries[0].depth).toBe(17);
        expect(host.context.eventSource.emit.mock.calls.every(([event, , , details]) => event === event_types.WORLDINFO_UPDATED && !details?.replaced)).toBe(true);
    });

    test.each(['delete', 'replace'])('a delayed read cannot resurrect data after %s', async operation => {
        const host = createHost();
        const held = host.hold('/api/worldinfo/get');
        const reading = host.context.loadWorldInfo('Lore');
        await held.started.promise;
        const replacement = { entries: {} };
        if (operation === 'delete') await host.context.deleteWorldInfo('Lore');
        else await host.context.replaceWorldInfoData('Lore', replacement);
        held.result.resolve(200);
        await expect(reading).resolves.toEqual(operation === 'delete' ? null : replacement);
        expect(host.context.worldInfoCache.get('Lore')).toEqual(operation === 'delete' ? undefined : replacement);
    });
});
