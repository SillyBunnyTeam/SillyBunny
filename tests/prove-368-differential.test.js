/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest loop tests are not Playwright tests. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function setupReloadRuntime({ group = false, active = false, holdAbort = false } = {}) {
    const original = [
        { name: 'User', is_user: true, is_system: false, mes: 'User turn', extra: {} },
        { name: 'Bot', is_user: false, is_system: false, mes: 'Partial assistant output', original_avatar: 'bot.png', extra: {} },
    ];
    let disk = [structuredClone(original[0])];
    const delayMock = jest.fn(async () => {});

    let fetchHandler = async (url, init) => {
        if (url === '/api/chats/save') {
            const body = JSON.parse(init.body);
            disk = structuredClone(body.chat.slice(1));
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (url === '/api/chats/group/save') {
            const body = JSON.parse(init.body);
            disk = structuredClone(body.chat.slice(1));
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (url === '/api/chats/get' || url === '/api/chats/group/get') {
            return {
                ok: true,
                status: 200,
                json: async () => [{ chat_metadata: { integrity: 'disk' } }, ...structuredClone(disk)],
            };
        }
        if (url === '/api/groups/edit') {
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (url === '/api/groups/all' || url === '/api/characters/all') {
            return { ok: true, status: 200, json: async () => [] };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    };

    const fetchMock = jest.fn((url, init) => fetchHandler(url, init));

    let generationStartedResolve;
    const generationStarted = new Promise(resolve => { generationStartedResolve = resolve; });
    let releaseHeldGeneration;
    const heldGenerationGate = new Promise(resolve => { releaseHeldGeneration = resolve; });
    let requestSignalAborted = false;

    loaded = await importScriptModule({
        keepReal: ['scripts/chat-reload-guard.js', 'scripts/group-chats.js'],
        fetch: fetchMock,
        mocks: {
            'scripts/utils.js': {
                delay: delayMock,
            },
            'scripts/csrf-token-refresh.js': {
                fetchWithCsrfRetry: jest.fn(async (url, initOrFn) => fetchMock(url, typeof initOrFn === 'function' ? await initOrFn() : initOrFn)),
            },
            'scripts/sillybunny-group-editor.js': {
                beginGroupEditorLoad: jest.fn(() => 'loaded'),
                openGroupEditorSession: jest.fn(),
                openGroupEditorCreateSession: jest.fn(),
                captureGroupEditorSave: jest.fn(() => null),
                readGroupEditorBaseline: jest.fn(() => null),
                isGroupEditorOwner: jest.fn(() => false),
                notifyGroupEditorChanged: jest.fn(),
                rebaseGroupEditor: jest.fn(),
                initGroupEditor: jest.fn(),
                discardGroupEditorForEntity: jest.fn(),
                attachGroupTagFilterMenus: jest.fn(),
                prepareGroupEditorReveal: jest.fn(async () => true),
                setGroupEditorFolderValue: jest.fn(),
            },
            'scripts/sillybunny-editor/list-pagination.js': {
                createListPagination: jest.fn(() => ({ setItems: jest.fn(), render: jest.fn() })),
            },
            'scripts/sillybunny-editor/list-search.js': {
                createListSearch: jest.fn(() => ({ setItems: jest.fn(), filter: jest.fn(() => []) })),
            },
            'scripts/sillybunny-action-menu.js': {
                openActionMenu: jest.fn(),
            },
            'scripts/sillybunny-editor/object-navigation.js': {
                objectNavigation: { navigate: jest.fn(async () => ({ ok: true })) },
            },
            'scripts/openai.js': {
                sendOpenAIRequest: async (_type, _messages, signal) => {
                    generationStartedResolve();
                    if (holdAbort) {
                        await heldGenerationGate;
                    } else {
                        await new Promise((_resolve, reject) => {
                            if (signal?.aborted) {
                                requestSignalAborted = true;
                                reject(signal.reason ?? new Error('Aborted'));
                                return;
                            }
                            signal?.addEventListener('abort', () => {
                                requestSignalAborted = true;
                                reject(signal.reason ?? new Error('Aborted'));
                            }, { once: true });
                        });
                    }
                    return { choices: [{ message: { content: '' } }] };
                },
            },
        },
    });

    await loaded.runReady();
    loaded.$('#main_api').val('openai').trigger('change');

    const groupChats = await import('../public/scripts/group-chats.js');
    loaded.script.characters.push({ name: 'Bot', avatar: 'bot.png', chat: 'character-chat', data: { extensions: {} } });
    groupChats.groups.push({ id: 'group-1', name: 'Group 1', chat_id: 'branch-2', chats: ['branch-1', 'branch-2'], members: ['bot.png'], disabled_members: [] });

    if (group) {
        await groupChats.openGroupById('group-1', { switchMenu: false });
    } else {
        loaded.script.setCharacterId(0);
        loaded.script.setCharacterName('Bot');
    }
    loaded.script.setOnlineStatus('connected');

    loaded.script.chat.splice(0, loaded.script.chat.length, ...structuredClone(original));
    loaded.script.updateChatMetadata({ integrity: 'live' }, true);
    await loaded.script.printMessages();

    let activeGenPromise = null;
    if (active) {
        activeGenPromise = loaded.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true }).catch(() => {});
        await generationStarted;
        if (group) {
            // Keep this_chid at the group's idle undefined value so generateGroupWrapper's finally reset does not look like character navigation.
            loaded.script.setCharacterId(undefined);
        }
    }

    fetchMock.mockClear();
    delayMock.mockClear();
    loaded.toastr.error.mockClear();
    loaded.toastr.warning.mockClear();

    const chatChangedEvents = [];
    loaded.eventSource.on(loaded.script.event_types.CHAT_CHANGED, (id) => chatChangedEvents.push(id));

    const stoppedEvents = [];
    loaded.eventSource.on(loaded.script.event_types.GENERATION_STOPPED, () => stoppedEvents.push(true));

    const renderedTexts = () => Array.from(document.querySelectorAll('#chat > .mes .mes_text')).map(el => el.textContent.trim());

    return {
        ...loaded,
        groupChats,
        original,
        fetchMock,
        delayMock,
        chatChangedEvents,
        stoppedEvents,
        renderedTexts,
        activeGenPromise,
        releaseHeldGeneration,
        wasAborted: () => requestSignalAborted,
        disk: () => disk,
        setFetchHandler: fn => { fetchHandler = fn; },
        defaultFetchHandler: fetchHandler,
    };
}

function expectPreserved(runtime) {
    expect(runtime.script.chat.map(m => m.mes)).toEqual(runtime.original.map(m => m.mes));
    expect(runtime.script.chat_metadata).toMatchObject({ integrity: 'live' });
    expect(runtime.renderedTexts()).toEqual(runtime.original.map(m => m.mes));
    expect(runtime.chatChangedEvents).toEqual([]);
}

describe('reloadCurrentChatUnsafe data preservation', () => {
    test('loads the active group branch file rather than the group metadata ID', async () => {
        const runtime = await setupReloadRuntime({ group: true });
        runtime.setFetchHandler(async (url, options) => {
            if (url === '/api/chats/group/get') {
                const { id } = JSON.parse(options.body);
                return {
                    ok: id === 'branch-2',
                    status: id === 'branch-2' ? 200 : 404,
                    json: async () => [{ name: 'Bot', is_user: false, is_system: false, mes: 'Active branch turn', extra: {} }],
                };
            }
            return runtime.defaultFetchHandler(url, options);
        });

        await runtime.script.reloadCurrentChatUnsafe();

        expect(runtime.fetchMock).toHaveBeenCalledWith('/api/chats/group/get', expect.any(Object));
        expect(runtime.script.chat.map(m => m.mes)).toEqual(['Active branch turn']);
        expect(runtime.renderedTexts()).toEqual(['Active branch turn']);
        expect(runtime.chatChangedEvents).toEqual(['branch-2']);
    });

    for (const group of [false, true]) {
        const kind = group ? 'group' : 'character';
        const saveUrl = group ? '/api/chats/group/save' : '/api/chats/save';
        const getUrl = group ? '/api/chats/group/get' : '/api/chats/get';

        for (const failure of ['false', 'rejection']) {
            test(`preserves partial ${kind} output when its save returns ${failure}`, async () => {
                const runtime = await setupReloadRuntime({ group, active: true });
                runtime.setFetchHandler(async (url) => {
                    if (url === saveUrl) {
                        if (failure === 'false') {
                            return { ok: false, status: 500, statusText: 'Save failed', json: async () => ({}) };
                        }
                        throw new Error('save failed');
                    }
                    throw new Error(`Unexpected fetch: ${url}`);
                });

                await runtime.script.reloadCurrentChatUnsafe();
                await runtime.activeGenPromise;

                expect(runtime.fetchMock.mock.calls.filter(([url]) => url === saveUrl)).toHaveLength(1);
                expect(runtime.fetchMock.mock.calls.some(([url]) => url === getUrl)).toBe(false);
                expectPreserved(runtime);
                expect(runtime.toastr.error).toHaveBeenCalled();
            });
        }

        test(`waits for partial ${kind} output to save before fetching it back`, async () => {
            const runtime = await setupReloadRuntime({ group, active: true });
            const saving = deferred();
            const release = deferred();

            runtime.setFetchHandler(async (url, init) => {
                if (url === saveUrl) {
                    saving.resolve();
                    await release.promise;
                }
                return runtime.defaultFetchHandler(url, init);
            });

            const reloading = runtime.script.reloadCurrentChatUnsafe();
            await saving.promise;

            expect(runtime.fetchMock.mock.calls.some(([url]) => url === getUrl)).toBe(false);
            expectPreserved(runtime);
            release.resolve();
            await reloading;
            await runtime.activeGenPromise;

            expect(runtime.wasAborted()).toBe(true);
            expect(runtime.disk().map(m => m.mes)).toEqual(runtime.original.map(m => m.mes));
            expect(runtime.fetchMock.mock.calls.filter(([url]) => url === getUrl)).toHaveLength(1);
            expect(runtime.script.chat.map(m => m.mes)).toEqual(runtime.original.map(m => m.mes));
            expect(runtime.renderedTexts()).toEqual(runtime.original.map(m => m.mes));
            expect(runtime.script.chat_metadata).toEqual({ integrity: 'disk' });
            expect(runtime.chatChangedEvents).toEqual([group ? 'branch-2' : 'character-chat']);
        });
    }

    test('keeps live messages and rendered chat intact while a fetch is pending and after it fails', async () => {
        const runtime = await setupReloadRuntime();
        const fetching = deferred();
        const response = deferred();
        runtime.setFetchHandler((url, init) => {
            if (url === '/api/chats/get') {
                fetching.resolve();
                return response.promise;
            }
            return runtime.defaultFetchHandler(url, init);
        });

        const reloading = runtime.script.reloadCurrentChatUnsafe();
        await fetching.promise;

        expectPreserved(runtime);
        await runtime.script.saveChatConditional();
        expect(runtime.disk().map(m => m.mes)).toEqual(runtime.original.map(m => m.mes));

        response.resolve({ ok: false, status: 500 });
        await reloading;

        expectPreserved(runtime);
        expect(runtime.toastr.error).toHaveBeenCalled();
    });

    test('discards a completed fetch after navigation even when the next group uses the same filename', async () => {
        const runtime = await setupReloadRuntime({ group: true });
        const fetching = deferred();
        const response = deferred();
        runtime.setFetchHandler((url, init) => {
            if (url === '/api/chats/group/get' && JSON.parse(init.body).id === 'branch-2' && !fetching.done) {
                fetching.done = true;
                fetching.resolve();
                return response.promise;
            }
            if (url === '/api/chats/group/get') {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => [
                        { chat_metadata: { integrity: 'other-group' } },
                        { name: 'Bot', is_user: false, is_system: false, mes: 'Other group turn', extra: {} },
                    ],
                });
            }
            return runtime.defaultFetchHandler(url, init);
        });

        const reloading = runtime.script.reloadCurrentChatUnsafe();
        await fetching.promise;

        runtime.groupChats.groups.push({ id: 'group-2', name: 'Group 2', chat_id: 'branch-2', chats: ['branch-2'], members: [] });
        await runtime.groupChats.openGroupById('group-2', { switchMenu: false });
        runtime.chatChangedEvents.length = 0;

        response.resolve({
            ok: true,
            status: 200,
            json: async () => [{ name: 'Bot', is_user: false, is_system: false, mes: 'Stale original group turn', extra: {} }],
        });
        await reloading;

        expect(runtime.script.chat.map(m => m.mes)).toEqual(['Other group turn']);
        expect(runtime.script.chat_metadata).toEqual({ integrity: 'other-group' });
        expect(runtime.renderedTexts()).toEqual(['Other group turn']);
        expect(runtime.chatChangedEvents).toEqual([]);
    });

    for (const navigation of ['group', 'branch']) {
        test(`does not save into the old target after ${navigation} navigation during generation abort`, async () => {
            const runtime = await setupReloadRuntime({ group: true, active: true, holdAbort: true });
            const waiting = deferred();
            const release = deferred();
            runtime.delayMock.mockImplementation(() => {
                waiting.resolve();
                return release.promise;
            });

            const reloading = runtime.script.reloadCurrentChatUnsafe();
            await waiting.promise;

            // Release the held generation so openGroupById is not blocked by is_send_press when switching groups.
            runtime.releaseHeldGeneration();
            await runtime.activeGenPromise;

            if (navigation === 'group') {
                runtime.groupChats.groups.push({ id: 'group-2', name: 'Group 2', chat_id: 'branch-2', chats: ['branch-2'], members: [] });
                runtime.setFetchHandler(async () => ({
                    ok: true,
                    status: 200,
                    json: async () => [
                        { chat_metadata: { integrity: 'new-target' } },
                        { name: 'Bot', is_user: false, is_system: false, mes: 'Newly selected chat', extra: {} },
                    ],
                }));
                await runtime.groupChats.openGroupById('group-2', { switchMenu: false });
                runtime.fetchMock.mockClear();
            } else {
                runtime.groupChats.groups[0].chat_id = 'branch-3';
                runtime.script.chat.splice(0, runtime.script.chat.length, { name: 'Bot', is_user: false, is_system: false, mes: 'Newly selected chat', extra: {} });
                runtime.script.updateChatMetadata({ integrity: 'new-target' }, true);
                await runtime.script.printMessages();
            }

            release.resolve();
            await reloading;

            expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/chats/group/save' || url === '/api/chats/save')).toBe(false);
            expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/chats/group/get' || url === '/api/chats/get')).toBe(false);
            expect(runtime.script.chat.map(m => m.mes)).toEqual(['Newly selected chat']);
            expect(runtime.script.chat_metadata).toEqual({ integrity: 'new-target' });
            expect(runtime.renderedTexts()).toEqual(['Newly selected chat']);
        });
    }

    test('preserves pending edits when the navigation save refuses to flush', async () => {
        const runtime = await setupReloadRuntime();
        runtime.setFetchHandler(async (url) => {
            if (url === '/api/chats/save') {
                return { ok: false, status: 500, statusText: 'Save failed', json: async () => ({}) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        runtime.script.saveChatDebounced();
        await runtime.script.reloadCurrentChatUnsafe();

        expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/chats/get')).toBe(false);
        expectPreserved(runtime);
        expect(runtime.toastr.error).toHaveBeenCalled();
    });
});
