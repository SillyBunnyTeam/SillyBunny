/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- These are parameterised Jest tests against real world-info.js. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { TextEncoder } from 'node:util';
import v8 from 'node:v8';

import { event_types } from '../public/scripts/events.js';
import { importWorldInfoModule } from './util/world-info-module-harness.js';

if (typeof globalThis.structuredClone !== 'function') {
    globalThis.structuredClone = value => v8.deserialize(v8.serialize(value));
}
if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.Blob !== 'undefined' && typeof globalThis.Blob.prototype.text !== 'function') {
    globalThis.Blob.prototype.text = function () {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ''));
            reader.onerror = () => reject(reader.error);
            reader.readAsText(this);
        });
    };
}

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const entryEditTemplateHtml = new DOMParser().parseFromString(indexHtml, 'text/html')
    .querySelector('#entry_edit_template')?.outerHTML ?? '';

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

function mountWorldInfoDom() {
    document.body.innerHTML = `
        <div id="WorldInfo">
            <select id="world_info" multiple></select>
            <select id="world_editor_select"><option value="">None</option></select>
            <select id="world_info_sort_order">
                <option value="0" data-field="displayIndex" data-order="asc" data-rule="custom" selected>Custom</option>
            </select>
            <input id="world_info_search" value="" />
            <div id="world_popup">
                <button id="world_popup_new"></button>
                <button id="world_popup_name_button"></button>
                <button id="world_popup_export"></button>
                <button id="world_popup_delete"></button>
                <button id="world_duplicate"></button>
                <div id="world_info_pagination"></div>
                <div id="world_popup_entries_list"></div>
            </div>
        </div>
        ${entryEditTemplateHtml}
    `;
}

async function flushMicrotasks(turns = 15) {
    for (let index = 0; index < turns; index++) {
        await Promise.resolve();
    }
}

async function createHost(initialBook = book()) {
    mountWorldInfoDom();
    const books = new Map([['Lore', structuredClone(initialBook)]]);
    const holds = new Map();
    const renders = [];
    let editorData = null;
    let displayCalls = 0;

    const baseFetch = async (url, options = {}) => {
        const body = options.body instanceof FormData ? options.body : JSON.parse(options.body ?? '{}');
        const held = holds.get(url)?.shift();
        const readData = url === '/api/worldinfo/get' ? structuredClone(books.get(body.name)) : undefined;
        if (held) {
            held.started.resolve();
            const status = await held.result.promise;
            if (status !== 200) return { ok: false, status, statusText: 'Rejected' };
        }
        let result;
        switch (url) {
            case '/api/settings/get':
                return { ok: true, json: async () => ({ world_names: [...books.keys()] }) };
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
                result = { ok: true };
                break;
            case '/api/worldinfo/import': {
                const name = String(body.get('name'));
                const importedBook = JSON.parse(String(body.get('convertedData') ?? await body.get('avatar').text()));
                if (body.get('import_external_media') === 'true') {
                    for (const entry of Object.values(importedBook.entries ?? {})) {
                        if (typeof entry?.content === 'string') {
                            entry.content = entry.content.replaceAll('https://files.catbox.moe/scene.png', '/user/images/Lore/scene-12345678.png');
                        }
                    }
                    books.set(name, importedBook);
                    result = { name, data: importedBook };
                } else {
                    books.set(name, importedBook);
                    result = { name };
                }
                break;
            }
            default:
                throw new Error(`Unexpected request ${url}`);
        }
        return { ok: true, json: async () => result };
    };

    const fetchMock = jest.fn(baseFetch);
    const loaded = await importWorldInfoModule({
        fetch: fetchMock,
        characters: [],
    });
    const { worldInfo, mocks, state, $ } = loaded;

    // Adapter captures every rendered book without running legacy pagination.
    const adapter = {
        render: jest.fn(({ data }) => {
            if (data) {
                displayCalls++;
                editorData = data;
            }
        }),
    };
    worldInfo.setWorldInfoSettings({}, { world_names: [...books.keys()] });
    worldInfo.initWorldInfo();
    await worldInfo.setWorldInfoEditorAdapter(adapter);
    $('#world_editor_select').val('0');

    // Track async editor reloads triggered by #world_editor_select change events.
    $('#world_editor_select').on('change', () => {
        const selectedVal = String($('#world_editor_select').find(':selected').val() ?? '');
        if (selectedVal !== '') {
            renders.push(flushMicrotasks(25));
        }
    });

    displayCalls = 0;
    adapter.render.mockClear();
    mocks.eventSource.emit.mockClear();
    fetchMock.mockClear();

    return {
        worldInfo,
        mocks,
        state,
        $,
        books,
        fetchMock,
        baseFetch,
        adapter,
        get displayCalls() { return displayCalls; },
        get editorData() { return editorData; },
        async render() {
            await Promise.all(renders.splice(0));
            await flushMicrotasks(25);
        },
        hold(url = '/api/worldinfo/edit') {
            const held = { started: deferred(), result: deferred() };
            if (!holds.has(url)) holds.set(url, []);
            holds.get(url).push(held);
            return held;
        },
        async openAndFocusDepthInput() {
            // Backfill missing fields the same way the editor list does, then build the real entry header
            // via getWorldEntry so handleNumberInputHelper wires depth.
            worldInfo.getWorldInfoDisplayEntries(editorData);
            const entry = editorData.entries[0];
            const block = await worldInfo.getWorldEntry('Lore', editorData, entry);
            $('#world_popup_entries_list').empty().append(block);
            const depthEl = block.find('input[name="depth"]')[0];
            depthEl.disabled = false;
            depthEl.focus();
            return {
                element: depthEl,
                async edit(value) {
                    $(depthEl).val(String(value)).trigger('input');
                    await flushMicrotasks(10);
                },
                blur() {
                    depthEl.blur();
                },
            };
        },
        async replaceWithBook(targetName, nextBook) {
            // Use the real #world_duplicate action (which calls replaceWorldInfoData) via a temporary source book,
            // or importEmbeddedWorldInfoForCharacter / createNewWorldInfo depending on the caller.
            if (Object.keys(nextBook.entries ?? {}).length === 0 && !nextBook.extensions && !nextBook.originalData) {
                return worldInfo.createNewWorldInfo(targetName);
            }
            const sourceName = '__replace_source__';
            books.set(sourceName, structuredClone(nextBook));
            await worldInfo.updateWorldInfoList();
            const prevIndex = $('#world_editor_select').val();
            const sourceIndex = String([...books.keys()].indexOf(sourceName));
            $('#world_editor_select').val(sourceIndex);
            await worldInfo.showWorldEditor(sourceName);
            mocks.popup.Popup.show.input.mockResolvedValueOnce(targetName);
            $('#world_duplicate').trigger('click');
            await flushMicrotasks(30);
            books.delete(sourceName);
            await worldInfo.updateWorldInfoList();
            $('#world_editor_select').val(prevIndex);
            mocks.eventSource.emit.mockClear();
        },
        async triggerRename() {
            $('#world_popup_name_button').trigger('click');
            await flushMicrotasks(5);
        },
    };
}

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

describe('shared World Info saves', () => {
    test.each(['create', 'duplicate'])('stale native %s avoids card IDs reserved in the latest cache', async operation => {
        const host = await createHost();
        const { worldInfo } = host;
        const card = {
            entries: [
                { id: 74, content: 'First', foreign: 'kept' },
                { id: 0, content: 'Second' },
            ],
        };
        host.state.characters.push({ name: 'CardChar', data: { character_book: card } });
        await worldInfo.importEmbeddedWorldInfoForCharacter(0, { targetName: 'Lore' });

        const native = await worldInfo.loadWorldInfo('Lore');
        const external = await worldInfo.loadWorldInfo('Lore');
        const externalEntry = worldInfo.createWorldInfoEntry('Lore', external);
        externalEntry.content = 'External';
        worldInfo.syncWIOriginalDataEntry(external, externalEntry.uid);
        const held = host.hold();
        const externalSave = worldInfo.saveWorldInfo('Lore', external, true);
        await held.started.promise;

        const nativeEntry = operation === 'create'
            ? worldInfo.createWorldInfoEntry('Lore', native)
            : worldInfo.duplicateWorldInfoEntry(native, 0);
        nativeEntry.content = 'Native';
        worldInfo.syncWIOriginalDataEntry(native, nativeEntry.uid);
        const nativeSave = worldInfo.saveWorldInfo('Lore', native, true);
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
        const host = await createHost();
        const native = host.worldInfo.convertCharacterBook({ entries: [{ id: 74, content: 'Original', foreign: 'kept' }] });
        const duplicate = host.worldInfo.duplicateWorldInfoEntry(native, 0);
        host.worldInfo.syncWIOriginalDataEntry(native, duplicate.uid);
        expect(duplicate.uid).toBe(1);
        expect(native.originalData.entries.map(entry => entry.id)).toEqual([74, 0]);
        expect(native.originalData.entries[1]).toMatchObject({ id: 0, foreign: 'kept', content: 'Original' });
    });

    test('a stale native edit cannot resurrect a deleted entry', async () => {
        const host = await createHost();
        await host.worldInfo.showWorldEditor('Lore');
        await host.openAndFocusDepthInput();
        const native = host.editorData;
        const external = await host.worldInfo.loadWorldInfo('Lore');
        delete external.entries[0];
        await host.worldInfo.saveWorldInfo('Lore', external, true);

        native.entries[0].depth = 99;
        const result = await host.worldInfo.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').entries).not.toHaveProperty('0');
        expect(result).toBeNull();
    });

    test.each(['edit', 'delete'])('a stale native %s cannot target a replacement with the same UID and contents', async operation => {
        const host = await createHost();
        await host.worldInfo.showWorldEditor('Lore');
        await host.openAndFocusDepthInput();
        const native = host.editorData;
        const original = structuredClone(native.entries[0]);
        const external = await host.worldInfo.loadWorldInfo('Lore');
        delete external.entries[0];
        await host.worldInfo.saveWorldInfo('Lore', external, true);
        const replacement = await host.worldInfo.loadWorldInfo('Lore');
        const entry = host.worldInfo.createWorldInfoEntry('Lore', replacement);
        expect(entry.uid).toBe(0);
        Object.assign(entry, original);
        await host.worldInfo.saveWorldInfo('Lore', replacement, true);

        if (operation === 'edit') native.entries[0].depth = 99;
        else delete native.entries[0];
        const result = await host.worldInfo.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').entries[0]).toEqual(original);
        expect(result).toBeNull();
    });

    test('a failed immediate external save cannot lose the native delayed edit it superseded', async () => {
        jest.useFakeTimers();
        const host = await createHost();
        await host.worldInfo.showWorldEditor('Lore');
        const native = host.editorData;
        const input = await host.openAndFocusDepthInput();
        await input.edit(8);
        const external = await host.worldInfo.loadWorldInfo('Lore');
        external.entries[2].content = 'Fail this external write';

        host.fetchMock.mockImplementation((url, options) => {
            const data = url === '/api/worldinfo/edit' ? JSON.parse(options.body).data : null;
            return url === '/api/worldinfo/edit' && data.entries[2]?.content === 'Fail this external write'
                ? Promise.resolve({ ok: false, status: 500 })
                : host.baseFetch(url, options);
        });
        await expect(host.worldInfo.saveWorldInfo('Lore', external, true)).rejects.toThrow('World Info save failed');

        native.entries[1].content = 'Later native edit';
        await host.worldInfo.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(8);
        expect(host.books.get('Lore').entries[1].content).toBe('Later native edit');
        expect(host.books.get('Lore').entries[2].content).toBe('Update this');
    });

    test('unrelated native saves preserve a reused entry without adopting its instance', async () => {
        const host = await createHost();
        await host.worldInfo.showWorldEditor('Lore');
        await host.openAndFocusDepthInput();
        const native = host.editorData;
        const baselineEntry = structuredClone(native.entries[0]);
        const external = await host.worldInfo.loadWorldInfo('Lore');
        delete external.entries[0];
        await host.worldInfo.saveWorldInfo('Lore', external, true);
        const replacement = await host.worldInfo.loadWorldInfo('Lore');
        Object.assign(host.worldInfo.createWorldInfoEntry('Lore', replacement), baselineEntry);
        await host.worldInfo.saveWorldInfo('Lore', replacement, true);

        native.entries[1].content = 'Unrelated native edit';
        await expect(host.worldInfo.saveWorldInfo('Lore', native, true)).resolves.toBe('Lore');
        expect(host.books.get('Lore').entries[0]).toEqual(baselineEntry);

        const fresh = await host.worldInfo.loadWorldInfo('Lore');
        fresh.entries[0].depth = 6;
        await expect(host.worldInfo.saveWorldInfo('Lore', fresh, true)).resolves.toBe('Lore');

        delete native.entries[0];
        await expect(host.worldInfo.saveWorldInfo('Lore', native, true)).resolves.toBeNull();
        expect(host.books.get('Lore').entries[0].depth).toBe(6);
        expect(host.books.get('Lore').entries[1].content).toBe('Unrelated native edit');
        expect(Object.keys(host.books.get('Lore'))).toEqual(['entries', 'extensions']);
        expect(Object.getOwnPropertySymbols(fresh)).toEqual([]);
    });

    test('a failed deletion does not invalidate the committed entry instance', async () => {
        const host = await createHost();
        const native = await host.worldInfo.loadWorldInfo('Lore');
        const external = await host.worldInfo.loadWorldInfo('Lore');
        delete external.entries[0];
        const held = host.hold();
        const saving = host.worldInfo.saveWorldInfo('Lore', external, true);
        const rejected = saving.catch(error => error);
        await held.started.promise;
        native.entries[0].depth = 8;
        await expect(host.worldInfo.saveWorldInfo('Lore', native, true)).resolves.toBeNull();
        held.result.resolve(500);
        expect(await rejected).toHaveProperty('message', 'World Info save failed with status 500');
        await expect(host.worldInfo.saveWorldInfo('Lore', native, true)).resolves.toBe('Lore');
        expect(host.books.get('Lore').entries[0].depth).toBe(8);
    });

    test.each(['replace', 'import'])('a completed %s invalidates old entry instances even when the book is identical', async operation => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const host = await createHost();
        const native = await host.worldInfo.loadWorldInfo('Lore');
        try {
            if (operation === 'replace') {
                // Duplicate 'Lore' onto 'Lore' via #world_duplicate so replaceWorldInfoData installs identical data.
                await host.worldInfo.showWorldEditor('Lore');
                host.mocks.popup.Popup.show.input.mockResolvedValueOnce('Lore');
                host.$('#world_duplicate').trigger('click');
                await flushMicrotasks(30);
            } else {
                await host.worldInfo.importWorldInfo(new File([JSON.stringify(book())], 'Lore.json'));
            }
            delete native.entries[0];
            await expect(host.worldInfo.saveWorldInfo('Lore', native, true)).resolves.toBeNull();
            expect(host.books.get('Lore').entries[0].content).toBe('Original');
        } finally {
            logSpy.mockRestore();
        }
    });

    test('a rejected stale imported entry edit leaves both native and original entry records intact', async () => {
        const host = await createHost();
        const card = { entries: [{ id: 42, content: 'Original', extensions: { foreign: true } }] };
        host.state.characters.push({ name: 'CardChar', data: { character_book: card } });
        await host.worldInfo.importEmbeddedWorldInfoForCharacter(0, { targetName: 'Lore' });

        const native = await host.worldInfo.loadWorldInfo('Lore');
        const external = await host.worldInfo.loadWorldInfo('Lore');
        delete external.entries[0];
        host.worldInfo.deleteWIOriginalDataValue(external, 0);
        await host.worldInfo.saveWorldInfo('Lore', external, true);

        native.entries[0].content = 'Stale';
        host.worldInfo.setWIOriginalDataValue(native, 0, 'content', 'Stale');
        await expect(host.worldInfo.saveWorldInfo('Lore', native, true)).resolves.toBeNull();
        expect(host.books.get('Lore')).toMatchObject({ entries: {}, originalData: { entries: [] }, originalDataUidMap: {} });
    });

    test('a successful external edit is not reverted when the native writer saves again', async () => {
        jest.useFakeTimers();
        const host = await createHost();
        await host.worldInfo.showWorldEditor('Lore');
        const native = host.editorData;
        const input = await host.openAndFocusDepthInput();
        await input.edit(8);
        const external = await host.worldInfo.loadWorldInfo('Lore');
        external.entries[0].depth = 10;
        await host.worldInfo.saveWorldInfo('Lore', external, true);

        native.entries[1].content = 'Later native edit';
        await host.worldInfo.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(10);
        expect(host.books.get('Lore').entries[1].content).toBe('Later native edit');
    });

    test('newer native edits remain queued when the external save behind its flushed draft fails', async () => {
        jest.useFakeTimers();
        const host = await createHost();
        await host.worldInfo.showWorldEditor('Lore');
        const native = host.editorData;
        const input = await host.openAndFocusDepthInput();
        await input.edit(8);
        const external = await host.worldInfo.loadWorldInfo('Lore');
        external.entries[2].content = 'External';
        const nativeWrite = host.hold();
        const externalWrite = host.hold();
        const saving = host.worldInfo.saveWorldInfo('Lore', external, true);
        const rejected = saving.catch(error => error);
        await nativeWrite.started.promise;
        await input.edit(9);
        const latestSave = host.worldInfo.saveWorldInfo('Lore', native, true);
        nativeWrite.result.resolve(200);
        await externalWrite.started.promise;
        externalWrite.result.resolve(500);
        expect(await rejected).toHaveProperty('message', 'World Info save failed with status 500');
        await latestSave;
        expect(host.books.get('Lore').entries[0].depth).toBe(9);
        expect(host.worldInfo.worldInfoCache.get('Lore')).toEqual(host.books.get('Lore'));
    });

    test('reloading cannot restore an invalid stale draft into the native editor', async () => {
        const host = await createHost();
        await host.worldInfo.showWorldEditor('Lore');
        const native = host.editorData;
        const external = await host.worldInfo.loadWorldInfo('Lore');
        delete external.entries[0];
        const held = host.hold();
        const saving = host.worldInfo.saveWorldInfo('Lore', external, true);
        await held.started.promise;
        native.entries[0].depth = 99;
        held.result.resolve(200);
        await saving;
        await host.render();
        expect(host.editorData.entries).not.toHaveProperty('0');
    });

    test('background saves do not select a lorebook when the native editor has no selection', async () => {
        const host = await createHost();
        host.$('#world_editor_select').val('');
        await host.worldInfo.saveWorldInfo('Lore', book(), true);
        await host.render();
        expect(host.displayCalls).toBe(0);
        host.worldInfo.reloadEditor('Lore', true);
        await host.render();
        expect(host.displayCalls).toBeGreaterThan(0);
    });

    test('an open native editor preserves external creation, deletion, updates and book metadata', async () => {
        jest.useFakeTimers();
        const host = await createHost();
        const { worldInfo, books } = host;
        await worldInfo.showWorldEditor('Lore');
        const input = await host.openAndFocusDepthInput();
        const external = await worldInfo.loadWorldInfo('Lore');
        const created = worldInfo.createWorldInfoEntry('Lore', external);
        created.content = 'Created externally';
        delete external.entries[1];
        external.entries[2].content = 'External update';
        external.extensions.sillybunny_pathfinder = { version: 1, tree: { id: 'root', children: [] } };

        await expect(worldInfo.saveWorldInfo('Lore', external, true)).resolves.toBe('Lore');
        await input.edit(8);
        await jest.advanceTimersByTimeAsync(1100);
        await flushMicrotasks(20);

        expect(books.get('Lore')).toMatchObject({
            entries: { 0: { depth: 8, extensions: { foreign: 'entry metadata' } }, 2: { content: 'External update' }, 3: { content: 'Created externally' } },
            extensions: external.extensions,
        });
        expect(books.get('Lore').entries).not.toHaveProperty('1');
        input.blur();
        await jest.advanceTimersByTimeAsync(50);
        await host.render();
        expect(host.editorData.entries[0].depth).toBe(8);
        expect(host.editorData.entries[2].content).toBe('External update');
        expect(host.editorData.entries[3].content).toBe('Created externally');
        expect(host.editorData.entries).not.toHaveProperty('1');
    });

    test('native edits made during a pending external save survive its completion and editor reload', async () => {
        jest.useFakeTimers();
        const host = await createHost();
        const { worldInfo, books } = host;
        await worldInfo.showWorldEditor('Lore');
        const input = await host.openAndFocusDepthInput();
        const external = await worldInfo.loadWorldInfo('Lore');
        external.entries[0].content = 'External content';
        const held = host.hold();
        const saving = worldInfo.saveWorldInfo('Lore', external, true);
        await held.started.promise;

        await input.edit(9);
        held.result.resolve(200);
        await saving;
        expect(worldInfo.worldInfoCache.get('Lore').entries[0].depth).toBe(9);
        await input.edit(10);
        await jest.advanceTimersByTimeAsync(1100);
        await flushMicrotasks(20);
        expect(books.get('Lore').entries[0]).toMatchObject({ content: 'External content', depth: 10 });
        input.blur();
        await jest.advanceTimersByTimeAsync(50);
        await host.render();
        expect(host.editorData.entries[0]).toMatchObject({ content: 'External content', depth: 10 });
        const firstWrite = JSON.parse(host.fetchMock.mock.calls.find(([url]) => url === '/api/worldinfo/edit')[1].body);
        expect(firstWrite.data.entries[0].depth).toBe(4);
    });

    test('reload preserves native model changes not yet submitted to the shared saver', async () => {
        const host = await createHost();
        await host.worldInfo.showWorldEditor('Lore');
        const external = await host.worldInfo.loadWorldInfo('Lore');
        external.entries[2].content = 'External content';
        const held = host.hold();
        const saving = host.worldInfo.saveWorldInfo('Lore', external, true);
        await held.started.promise;
        host.editorData.entries[0].depth = 11;
        held.result.resolve(200);
        await saving;
        await host.render();
        expect(host.editorData.entries[0].depth).toBe(11);
        await host.worldInfo.saveWorldInfo('Lore', host.editorData, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(11);
        expect(host.books.get('Lore').entries[2].content).toBe('External content');
    });

    test('a copy loaded before a native save only changes its own fields', async () => {
        const host = await createHost();
        const native = await host.worldInfo.loadWorldInfo('Lore');
        const external = await host.worldInfo.loadWorldInfo('Lore');
        native.entries[0].depth = 12;
        await host.worldInfo.saveWorldInfo('Lore', native, true);
        external.entries[0].content = 'External content';
        await host.worldInfo.saveWorldInfo('Lore', external, true);
        native.entries[0].extensions.foreign = 'Updated metadata';
        await host.worldInfo.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').entries[0]).toMatchObject({ content: 'External content', depth: 12, extensions: { foreign: 'Updated metadata' } });
    });

    test('native saves preserve independently cloned external data and unchanged event identity', async () => {
        const host = await createHost();
        const native = await host.worldInfo.loadWorldInfo('Lore');
        const external = structuredClone(await host.worldInfo.loadWorldInfo('Lore'));
        external.entries[2].content = 'External content';
        await host.worldInfo.saveWorldInfo('Lore', external, true);
        expect(host.mocks.eventSource.emit.mock.calls[0][2]).toBe(external);
        native.entries[0].depth = 12;
        await host.worldInfo.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(12);
        expect(host.books.get('Lore').entries[2].content).toBe('External content');
    });

    test('native creation does not reuse a UID allocated by a pending external save', async () => {
        const host = await createHost();
        const native = await host.worldInfo.loadWorldInfo('Lore');
        const external = await host.worldInfo.loadWorldInfo('Lore');
        const externalEntry = host.worldInfo.createWorldInfoEntry('Lore', external);
        externalEntry.content = 'External';
        const held = host.hold();
        const saving = host.worldInfo.saveWorldInfo('Lore', external, true);
        await held.started.promise;
        const nativeEntry = host.worldInfo.createWorldInfoEntry('Lore', native);
        nativeEntry.content = 'Native';
        expect(nativeEntry.uid).not.toBe(externalEntry.uid);
        const nativeSave = host.worldInfo.saveWorldInfo('Lore', native, true);
        held.result.resolve(200);
        await saving;
        await nativeSave;
        expect(host.books.get('Lore').entries[externalEntry.uid].content).toBe('External');
        expect(host.books.get('Lore').entries[nativeEntry.uid].content).toBe('Native');
    });

    test('editor initialisation is not treated as an edit to native or imported fields', async () => {
        const initial = book();
        initial.entries[0].key = [];
        initial.entries[0].keysecondary = [];
        initial.originalData = { entries: [{ id: 0, content: 'Original', extensions: {} }] };
        const host = await createHost(initial);
        const native = await host.worldInfo.loadWorldInfo('Lore');
        native.entries[0].depth = 8;

        // Render the real entry and open its inline drawer so trackWorldInfoEntryRender absorbs field initialisation.
        const block = await host.worldInfo.getWorldEntry('Lore', native, native.entries[0]);
        block.find('.inline-drawer').trigger('inline-drawer-toggle');
        expect(native.entries[0].excludeRecursion).toBe(false);
        expect(native.originalData.entries[0].extensions.exclude_recursion).toBe(false);

        const external = await host.worldInfo.loadWorldInfo('Lore');
        external.entries[0].excludeRecursion = true;
        host.worldInfo.setWIOriginalDataValue(external, 0, 'extensions.exclude_recursion', true);
        await host.worldInfo.saveWorldInfo('Lore', external, true);
        await host.worldInfo.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').entries[0]).toMatchObject({ depth: 8, excludeRecursion: true });
        expect(host.books.get('Lore').originalData.entries[0].extensions.exclude_recursion).toBe(true);
    });

    test('rejected optimistic data is absent from a fresh load and can be retried without false duplicates', async () => {
        const host = await createHost();
        const external = await host.worldInfo.loadWorldInfo('Lore');
        host.worldInfo.createWorldInfoEntry('Lore', external).content = 'Created externally';
        const held = host.hold();
        const saving = host.worldInfo.saveWorldInfo('Lore', external, true);
        const rejection = saving.catch(error => error);
        await held.started.promise;
        held.result.resolve(500);
        expect(await rejection).toHaveProperty('message', 'World Info save failed with status 500');

        expect(host.worldInfo.worldInfoCache.has('Lore')).toBe(false);
        const retry = await host.worldInfo.loadWorldInfo('Lore');
        expect(retry.entries).not.toHaveProperty('3');
        host.worldInfo.createWorldInfoEntry('Lore', retry).content = 'Created externally';
        await expect(host.worldInfo.saveWorldInfo('Lore', retry, true)).resolves.toBe('Lore');
        expect(host.books.get('Lore').entries[3].content).toBe('Created externally');
    });

    test.each([false, true])('an older failure cannot invalidate a newer snapshot (identical data: %s)', async (identical) => {
        const host = await createHost();
        const first = await host.worldInfo.loadWorldInfo('Lore');
        const second = await host.worldInfo.loadWorldInfo('Lore');
        first.entries[0].content = 'First';
        if (identical) second.entries[0].content = 'First';
        else second.entries[2].content = 'Second';
        const held = host.hold();
        const firstSave = host.worldInfo.saveWorldInfo('Lore', first, true);
        const rejection = firstSave.catch(error => error);
        await held.started.promise;
        const secondSave = host.worldInfo.saveWorldInfo('Lore', second, true);
        const optimistic = host.worldInfo.worldInfoCache.get('Lore');
        held.result.resolve(500);
        expect(await rejection).toHaveProperty('message', 'World Info save failed with status 500');
        expect(host.worldInfo.worldInfoCache.get('Lore')).toEqual(optimistic);
        await secondSave;
        expect(host.worldInfo.worldInfoCache.get('Lore')).toEqual(host.books.get('Lore'));
    });

    test('overlapping failures on a reused object retain all changes on retry', async () => {
        const host = await createHost();
        const data = await host.worldInfo.loadWorldInfo('Lore');
        const first = host.hold();
        const second = host.hold();
        data.entries[0].depth = 20;
        const one = host.worldInfo.saveWorldInfo('Lore', data, true);
        const rejectedOne = one.catch(error => error);
        await first.started.promise;
        data.entries[2].content = 'Second';
        const two = host.worldInfo.saveWorldInfo('Lore', data, true);
        const rejectedTwo = two.catch(error => error);
        first.result.resolve(500);
        expect(await rejectedOne).toHaveProperty('message', 'World Info save failed with status 500');
        await second.started.promise;
        second.result.resolve(500);
        expect(await rejectedTwo).toHaveProperty('message', 'World Info save failed with status 500');
        expect(host.worldInfo.worldInfoCache.has('Lore')).toBe(false);
        await host.worldInfo.loadWorldInfo('Lore');
        await host.worldInfo.saveWorldInfo('Lore', data, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(20);
        expect(host.books.get('Lore').entries[2].content).toBe('Second');
    });

    test('debouncing snapshots input and reports a background rejection without poisoning the cache', async () => {
        jest.useFakeTimers();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const host = await createHost();
        const data = await host.worldInfo.loadWorldInfo('Lore');
        data.entries[0].depth = 6;
        await expect(host.worldInfo.saveWorldInfo('Lore', data)).resolves.toBeUndefined();
        data.entries[0].depth = 7;
        expect(host.worldInfo.worldInfoCache.get('Lore').entries[0].depth).toBe(6);
        const held = host.hold();
        held.result.resolve(500);
        const reported = deferred();
        host.mocks.toastr.error.mockImplementation(() => reported.resolve());
        jest.runOnlyPendingTimers();
        await reported.promise;
        expect(host.mocks.toastr.error).toHaveBeenCalled();
        expect(host.worldInfo.worldInfoCache.has('Lore')).toBe(false);
        await host.worldInfo.saveWorldInfo('Lore', data, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(7);
    });

    test('a later failed save restores a prior committed baseline, not a cancelled debounce', async () => {
        jest.useFakeTimers();
        const host = await createHost();
        const data = await host.worldInfo.loadWorldInfo('Lore');
        data.entries[0].depth = 5;
        await host.worldInfo.saveWorldInfo('Lore', data, true);
        data.entries[0].depth = 6;
        await host.worldInfo.saveWorldInfo('Lore', data);
        data.entries[2].content = 'Draft';
        const held = host.hold();
        const saving = host.worldInfo.saveWorldInfo('Lore', data, true);
        const rejection = saving.catch(error => error);
        await held.started.promise;
        held.result.reject(new Error('Offline'));
        expect(await rejection).toHaveProperty('message', 'Offline');
        await host.worldInfo.loadWorldInfo('Lore');
        await host.worldInfo.saveWorldInfo('Lore', data, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(6);
        expect(host.books.get('Lore').entries[2].content).toBe('Draft');
    });

    test('repeated debounced edits collapse cancelled baselines and still restore the committed baseline on failure', async () => {
        jest.useFakeTimers();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const host = await createHost();
        const data = await host.worldInfo.loadWorldInfo('Lore');
        data.entries[1].content = 'First keystroke edit';
        for (let depth = 1; depth <= 50; depth++) {
            data.entries[0].depth = depth;
            await host.worldInfo.saveWorldInfo('Lore', data);
        }
        // Fail the final debounced write, then merge an external write before retrying.
        const held = host.hold();
        held.result.resolve(500);
        const reported = deferred();
        host.mocks.toastr.error.mockImplementation(() => reported.resolve());
        jest.runOnlyPendingTimers();
        await reported.promise;

        const external = await host.worldInfo.loadWorldInfo('Lore');
        external.entries[2].content = 'External write';
        await host.worldInfo.saveWorldInfo('Lore', external, true);

        await host.worldInfo.saveWorldInfo('Lore', data, true);
        expect(host.books.get('Lore').entries[0].depth).toBe(50);
        expect(host.books.get('Lore').entries[1].content).toBe('First keystroke edit');
        expect(host.books.get('Lore').entries[2].content).toBe('External write');
    });

    test.each([['', {}], ['Lore', null], ['Lore', []], ['Lore', {}], ['Lore', { entries: [] }], ['Lore', { entries: { 0: null } }]])('invalid arguments resolve null (%s, %j)', async (name, data) => {
        const host = await createHost();
        await expect(host.worldInfo.saveWorldInfo(name, data, true)).resolves.toBeNull();
        expect(host.fetchMock).not.toHaveBeenCalled();
    });

    test('immediate saves return the actual canonical server name', async () => {
        const host = await createHost();
        await expect(host.worldInfo.saveWorldInfo('New/Book', { entries: {} }, true)).resolves.toBe('NewBook');
        expect(host.worldInfo.worldInfoCache.has('New/Book')).toBe(false);
        expect(host.worldInfo.worldInfoCache.get('NewBook')).toEqual({ entries: {} });
    });

    test('merges imported entry records by mapped UID while preserving card IDs and unknown metadata', async () => {
        const imported = book();
        imported.originalData = {
            extensions: { foreign: 'book metadata' },
            entries: [2, 0, 1].map(uid => ({ id: uid + 40, content: imported.entries[uid].content, extensions: { foreign: `original-${uid}` } })),
        };
        imported.originalDataUidMap = { 2: 0, 0: 1, 1: 2 };
        const host = await createHost(imported);
        const native = await host.worldInfo.loadWorldInfo('Lore');
        const external = await host.worldInfo.loadWorldInfo('Lore');
        delete external.entries[1];
        host.worldInfo.deleteWIOriginalDataValue(external, '1');
        external.entries[3] = { uid: 3, content: 'New', extensions: { sillybunny_pathfinder: { version: 1, nodeId: 'node' } } };
        external.originalData.entries.push({ id: 3, content: 'New', extensions: external.entries[3].extensions });
        external.originalDataUidMap[3] = 2;
        external.extensions.sillybunny_pathfinder = external.originalData.extensions.sillybunny_pathfinder = { version: 1, tree: { id: 'root' } };
        await host.worldInfo.saveWorldInfo('Lore', external, true);
        native.entries[0].content = 'Native draft';
        host.worldInfo.setWIOriginalDataValue(native, 0, 'content', 'Native draft');
        await host.worldInfo.saveWorldInfo('Lore', native, true);
        const saved = host.books.get('Lore');
        expect(saved.originalData.entries.map(entry => entry.id)).toEqual([42, 40, 3]);
        expect(saved.originalData.entries[1]).toMatchObject({ content: 'Native draft', extensions: { foreign: 'original-0' } });
        expect(saved.originalData.entries[2].extensions).toEqual(external.entries[3].extensions);
        expect(saved.originalData.extensions).toEqual(external.originalData.extensions);
        expect(saved.originalDataUidMap).toEqual({ 2: 0, 0: 1, 3: 2 });
        expect(saved.entries).not.toHaveProperty('1');
    });

    test('foreign metadata keys cannot modify object prototypes during a merge', async () => {
        const host = await createHost({ entries: {}, extensions: {} });
        const draft = await host.worldInfo.loadWorldInfo('Lore');
        const external = await host.worldInfo.loadWorldInfo('Lore');
        external.extensions.retained = true;
        await host.worldInfo.saveWorldInfo('Lore', external, true);

        draft.extensions = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
        await host.worldInfo.saveWorldInfo('Lore', draft, true);

        const merged = host.books.get('Lore');
        expect(merged.extensions).toHaveProperty('retained', true);
        expect(Object.hasOwn(merged.extensions, '__proto__')).toBe(true);
        expect({}.polluted).toBeUndefined();
    });

    test('independent additions to a previously absent extensions object preserve both namespaces', async () => {
        const host = await createHost({ entries: {} });
        const native = await host.worldInfo.loadWorldInfo('Lore');
        const external = await host.worldInfo.loadWorldInfo('Lore');
        external.extensions = { external: true };
        await host.worldInfo.saveWorldInfo('Lore', external, true);

        native.extensions = { native: true };
        await host.worldInfo.saveWorldInfo('Lore', native, true);
        expect(host.books.get('Lore').extensions).toEqual({ native: true, external: true });
    });
});

describe('World Info lifecycle coordination', () => {
    test('the native duplicate action copies current metadata and announces the installed replacement', async () => {
        const host = await createHost();
        const { worldInfo } = host;
        await worldInfo.showWorldEditor('Lore');
        const external = await worldInfo.loadWorldInfo('Lore');
        external.extensions.sillybunny_pathfinder = { version: 1, tree: { id: 'root' } };
        await worldInfo.saveWorldInfo('Lore', external, true);
        await host.render();
        host.editorData.entries[0].depth = 6;

        host.books.set('Copy', { entries: {}, extensions: { obsolete: true } });
        await worldInfo.updateWorldInfoList();
        await worldInfo.loadWorldInfo('Copy');
        host.mocks.popup.Popup.show.input.mockResolvedValueOnce('Co/py');

        host.$('#world_duplicate').trigger('click');
        await flushMicrotasks(30);

        const copied = host.books.get('Copy');
        expect(copied.extensions).toEqual(external.extensions);
        expect(copied.entries[0].depth).toBe(6);
        expect(copied).not.toHaveProperty('originalData');
        expect(worldInfo.worldInfoCache.get('Copy')).toEqual(copied);
        expect(host.mocks.eventSource.emit).toHaveBeenLastCalledWith(event_types.WORLDINFO_UPDATED, 'Copy', copied, { replaced: true });
    });

    test('converted card imports publish and cache the installed native data, not the old book', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const host = await createHost();
        await host.worldInfo.loadWorldInfo('Lore');
        const characterBook = {
            extensions: { foreign: true, sillybunny_pathfinder: { version: 1, tree: { id: 'root' } } },
            entries: [{ id: 42, content: 'Imported', extensions: { sillybunny_pathfinder: { version: 1, nodeId: 'root' } } }],
        };
        try {
            await host.worldInfo.importWorldInfo(new File([JSON.stringify({ spec: 'lorebook_v3', data: characterBook })], 'Lore.json'));
            const saved = host.books.get('Lore');
            expect(saved.entries[0]).toMatchObject({ uid: 0, content: 'Imported', extensions: characterBook.entries[0].extensions });
            expect(saved.extensions).toEqual(characterBook.extensions);
            expect(saved.originalData).toEqual(characterBook);
            expect(host.worldInfo.worldInfoCache.get('Lore')).toEqual(saved);
            expect(host.mocks.eventSource.emit).toHaveBeenLastCalledWith(event_types.WORLDINFO_UPDATED, 'Lore', saved, { replaced: true });
        } finally {
            logSpy.mockRestore();
        }
    });

    test('imports with import_external_media enabled cache and publish the server-rewritten media URLs', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const host = await createHost();
        host.state.power_user.import_external_media = true;
        const incoming = {
            entries: {
                0: { uid: 0, content: '![map](https://files.catbox.moe/scene.png)' },
            },
        };
        try {
            await host.worldInfo.importWorldInfo(new File([JSON.stringify(incoming)], 'Lore.json'));
            const saved = host.books.get('Lore');
            expect(saved.entries[0].content).toBe('![map](/user/images/Lore/scene-12345678.png)');
            expect(host.worldInfo.worldInfoCache.get('Lore')).toEqual(saved);
            expect(host.mocks.eventSource.emit).toHaveBeenLastCalledWith(event_types.WORLDINFO_UPDATED, 'Lore', saved, { replaced: true });
        } finally {
            logSpy.mockRestore();
        }
    });

    test('a save redirected by rename also honours a subsequent target deletion block', async () => {
        const host = await createHost();
        await host.worldInfo.showWorldEditor('Lore');
        const heldRename = host.hold('/api/worldinfo/rename');
        host.mocks.popup.Popup.show.input.mockResolvedValueOnce('Renamed');
        await host.triggerRename();
        await heldRename.started.promise;

        // While rename holds a block on 'Lore', make 'Renamed' deletable and hold its delete block too.
        host.books.set('Renamed', { entries: {} });
        await host.worldInfo.updateWorldInfoList();
        const heldDelete = host.hold('/api/worldinfo/delete');
        const deleting = host.worldInfo.deleteWorldInfo('Renamed');
        await heldDelete.started.promise;

        host.fetchMock.mockClear();
        const saving = host.worldInfo.saveWorldInfo('Lore', book(), true);
        heldRename.result.resolve(200);
        await flushMicrotasks(20);
        heldDelete.result.resolve(200);
        await deleting;
        await expect(saving).resolves.toBeNull();
        expect(host.fetchMock.mock.calls.filter(([url]) => url === '/api/worldinfo/edit')).toHaveLength(0);
    });

    test('replacement flushes a queued native edit before installing new data, with no later resurrection', async () => {
        jest.useFakeTimers();
        const host = await createHost();
        const data = await host.worldInfo.loadWorldInfo('Lore');
        data.entries[0].depth = 8;
        await host.worldInfo.saveWorldInfo('Lore', data);

        await host.worldInfo.createNewWorldInfo('Lore');
        jest.runOnlyPendingTimers();
        await flushMicrotasks(20);

        const replacement = { entries: {} };
        expect(host.books.get('Lore')).toEqual(replacement);
        expect(host.worldInfo.worldInfoCache.get('Lore')).toEqual(replacement);
        expect(host.fetchMock.mock.calls.filter(([url]) => url === '/api/worldinfo/edit')).toHaveLength(2);
        expect(host.mocks.eventSource.emit).toHaveBeenLastCalledWith(event_types.WORLDINFO_UPDATED, 'Lore', replacement, { replaced: true });
    });

    test('rename keeps newer external data and retargets a blocked save to its committed name', async () => {
        const host = await createHost();
        await host.worldInfo.showWorldEditor('Lore');
        const staleEditor = host.editorData;
        const external = await host.worldInfo.loadWorldInfo('Lore');
        external.extensions.sillybunny_pathfinder = { version: 1, tree: { id: 'root' } };
        await host.worldInfo.saveWorldInfo('Lore', external, true);

        const held = host.hold('/api/worldinfo/rename');
        host.mocks.popup.Popup.show.input.mockResolvedValueOnce('Renamed');
        await host.triggerRename();
        await held.started.promise;

        staleEditor.entries[0].depth = 9;
        const saving = host.worldInfo.saveWorldInfo('Lore', staleEditor, true);
        held.result.resolve(200);
        await flushMicrotasks(25);
        await expect(saving).resolves.toBe('Renamed');
        expect(host.books.has('Lore')).toBe(false);
        expect(host.worldInfo.worldInfoCache.has('Lore')).toBe(false);
        expect(host.books.get('Renamed')).toMatchObject({ entries: { 0: { depth: 9 } }, extensions: external.extensions });
        expect(host.mocks.eventSource.emit).toHaveBeenCalledWith(event_types.WORLDINFO_RENAMED, 'Lore', 'Renamed');
    });

    test.each(['delete', 'replace', 'import'])('%s discards blocked saves and publishes only installed data', async operation => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const host = await createHost();
        await host.worldInfo.showWorldEditor('Lore');
        const staleEditor = host.editorData;
        const replacement = operation === 'replace'
            ? { entries: {} }
            : { entries: { 9: { uid: 9, content: 'Replacement' } }, extensions: { new: true } };
        const held = host.hold(`/api/worldinfo/${operation === 'replace' ? 'edit' : operation}`);
        const observed = [];
        host.mocks.eventSource.emit.mockImplementation(async (event, name, data, details) => {
            if (event === event_types.WORLDINFO_DELETED) observed.push(host.worldInfo.worldInfoCache.has(name));
            if (details?.replaced) observed.push(await host.worldInfo.loadWorldInfo(name));
        });
        try {
            const changing = operation === 'delete'
                ? host.worldInfo.deleteWorldInfo('Lore')
                : operation === 'replace'
                    ? host.worldInfo.createNewWorldInfo('Lore')
                    : host.worldInfo.importWorldInfo(new File([JSON.stringify(replacement)], 'Lore.json'));
            await held.started.promise;
            staleEditor.entries[0].depth = 99;
            const saving = host.worldInfo.saveWorldInfo('Lore', staleEditor, true);
            held.result.resolve(200);
            await changing;
            await expect(saving).resolves.toBeNull();
            expect(host.books.get('Lore')).toEqual(operation === 'delete' ? undefined : replacement);
            expect(observed).toEqual(operation === 'delete' ? [false] : [replacement]);
            const calls = host.mocks.eventSource.emit.mock.calls;
            expect(calls).toEqual(operation === 'delete'
                ? [[event_types.WORLDINFO_DELETED, 'Lore']]
                : [[event_types.WORLDINFO_UPDATED, 'Lore', replacement, { replaced: true }]]);
        } finally {
            logSpy.mockRestore();
        }
    });

    test.each(['rename', 'delete', 'replace', 'import'])('failed %s does not announce success or discard waiting edits', async operation => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const host = await createHost();
        await host.worldInfo.showWorldEditor('Lore');
        const data = host.editorData;
        const held = host.hold(`/api/worldinfo/${operation === 'replace' ? 'edit' : operation}`);
        let changing;
        if (operation === 'rename') {
            host.mocks.popup.Popup.show.input.mockResolvedValueOnce('Renamed');
            changing = host.triggerRename();
        } else if (operation === 'delete') {
            changing = host.worldInfo.deleteWorldInfo('Lore');
        } else if (operation === 'replace') {
            changing = host.worldInfo.createNewWorldInfo('Lore');
        } else {
            changing = host.worldInfo.importWorldInfo(new File(['{"entries":{}}'], 'Lore.json'));
        }
        const settled = changing.catch(error => error);
        await held.started.promise;
        data.entries[0].depth = 17;
        const saving = host.worldInfo.saveWorldInfo('Lore', data, true);
        held.result.resolve(500);
        expect((await settled)?.message).toBe(operation === 'replace' ? 'World Info save failed with status 500' : undefined);
        await expect(saving).resolves.toBe('Lore');
        expect(host.books.get('Lore').entries[0].depth).toBe(17);
        expect(host.mocks.eventSource.emit.mock.calls.every(([event, , , details]) => event === event_types.WORLDINFO_UPDATED && !details?.replaced)).toBe(true);
    });

    test.each(['delete', 'replace'])('a delayed read cannot resurrect data after %s', async operation => {
        const host = await createHost();
        const held = host.hold('/api/worldinfo/get');
        const reading = host.worldInfo.loadWorldInfo('Lore');
        await held.started.promise;
        const replacement = { entries: {} };
        if (operation === 'delete') await host.worldInfo.deleteWorldInfo('Lore');
        else await host.worldInfo.createNewWorldInfo('Lore');
        held.result.resolve(200);
        await expect(reading).resolves.toEqual(operation === 'delete' ? null : replacement);
        expect(host.worldInfo.worldInfoCache.get('Lore')).toEqual(operation === 'delete' ? undefined : replacement);
    });
});
