import { describe, expect, test, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import {
    commitChatStaging,
    fetchChatRaw,
    fetchGroupChatRaw,
    shouldAbortReloadForActiveGeneration,
    shouldDiscardReloadTarget,
} from '../public/scripts/chat-reload-guard.js';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const declarations = ['getCurrentChatId', 'reloadCurrentChatUnsafe'].map(name => {
    const node = ast.body.map(node => node.declaration ?? node).find(node => node.id?.name === name);
    if (!node) throw new Error(`Missing declaration: ${name}`);
    return source.slice(node.start, node.end);
}).join('\n');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function reloadContext({ group = false, active = false } = {}) {
    const original = [{ mes: 'User turn' }, { mes: 'Partial assistant output' }];
    let disk = [{ mes: 'User turn' }];
    let rendered = structuredClone(original);
    const context = vm.createContext({
        console: { error: jest.fn(), warn: jest.fn() },
        t: strings => strings.join(''),
        toastr: { error: jest.fn(), warning: jest.fn() },
        selected_group: group ? 'group-1' : null,
        this_chid: group ? undefined : 0,
        groups: [{ id: 'group-1', chat_id: 'branch-2', chats: ['branch-1', 'branch-2'] }],
        characters: [{ name: 'Bot', avatar: 'bot.png', chat: 'character-chat' }],
        chat: structuredClone(original),
        chat_metadata: { integrity: 'live' },
        is_send_press: active,
        activeGenerationRun: active ? {} : null,
        delay: jest.fn(),
        flushPendingChatSavesForNavigation: jest.fn(async () => true),
        getRequestHeaders: () => ({}),
        shouldAbortReloadForActiveGeneration,
        shouldDiscardReloadTarget,
        commitChatStaging,
        preserveNeutralChat: jest.fn(),
        ensureMessageMediaIsArray: jest.fn(),
        loadItemizedPrompts: jest.fn(),
        eventSource: { emit: jest.fn() },
        event_types: { CHAT_CHANGED: 'chat_changed' },
        refreshSwipeButtons: jest.fn(),
    });
    context.stopGeneration = jest.fn(() => {
        context.is_send_press = false;
        context.activeGenerationRun = null;
    });
    const persist = async () => {
        disk = structuredClone(context.chat);
        return true;
    };
    context.saveChatConditional = jest.fn(persist);
    context.saveGroupChat = jest.fn(persist);
    context.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => [{ chat_metadata: { integrity: 'disk' } }, ...structuredClone(disk)],
    }));
    context.fetchChatRaw = options => fetchChatRaw({ ...options, fetchImpl: context.fetch });
    context.fetchGroupChatRaw = options => fetchGroupChatRaw({ ...options, fetchImpl: context.fetch });
    context.clearChat = jest.fn(async ({ clearData }) => {
        rendered = [];
        if (clearData) context.chat.length = 0;
    });
    context.printMessages = jest.fn(async () => { rendered = structuredClone(context.chat); });
    vm.runInContext(declarations, context);
    return { context, original, rendered: () => rendered, disk: () => disk };
}

function expectPreserved(harness) {
    expect(harness.context.chat).toEqual(harness.original);
    expect(harness.context.chat_metadata).toEqual({ integrity: 'live' });
    expect(harness.rendered()).toEqual(harness.original);
    expect(harness.context.clearChat).not.toHaveBeenCalled();
    expect(harness.context.eventSource.emit).not.toHaveBeenCalled();
}

// These cases execute the production orchestration and raw fetch/commit helpers.
describe('reloadCurrentChatUnsafe data preservation', () => {
    test('loads the active group branch file rather than the group metadata ID', async () => {
        const { context, rendered } = reloadContext({ group: true });
        context.fetch.mockImplementation(async (url, options) => {
            const { id } = JSON.parse(options.body);
            return {
                ok: id === 'branch-2',
                status: 404,
                json: async () => [{ mes: 'Active branch turn' }],
            };
        });

        await context.reloadCurrentChatUnsafe();

        expect(context.fetch).toHaveBeenCalledWith('/api/chats/group/get', expect.any(Object));
        expect(context.chat).toEqual([{ mes: 'Active branch turn' }]);
        expect(rendered()).toEqual([{ mes: 'Active branch turn' }]);
        expect(context.eventSource.emit).toHaveBeenCalledWith('chat_changed', 'branch-2');
    });

    for (const group of [false, true]) {
        const kind = group ? 'group' : 'character';
        for (const failure of ['false', 'rejection']) {
            test(`preserves partial ${kind} output when its save returns ${failure}`, async () => {
                const harness = reloadContext({ group, active: true });
                const { context } = harness;
                const save = group ? context.saveGroupChat : context.saveChatConditional;
                if (failure === 'false') save.mockResolvedValue(false);
                else save.mockRejectedValue(new Error('save failed'));

                await context.reloadCurrentChatUnsafe();

                expect(save).toHaveBeenCalledTimes(1);
                expect(context.fetch).not.toHaveBeenCalled();
                expect(context.flushPendingChatSavesForNavigation).not.toHaveBeenCalled();
                expectPreserved(harness);
                expect(context.toastr.error).toHaveBeenCalled();
            });
        }

        test(`waits for partial ${kind} output to save before fetching it back`, async () => {
            const harness = reloadContext({ group, active: true });
            const { context, original } = harness;
            const save = group ? context.saveGroupChat : context.saveChatConditional;
            const persist = save.getMockImplementation();
            const saving = deferred();
            const release = deferred();
            save.mockImplementation(async () => {
                saving.resolve();
                await release.promise;
                return persist();
            });
            const reloading = context.reloadCurrentChatUnsafe();
            await saving.promise;

            expect(context.fetch).not.toHaveBeenCalled();
            expectPreserved(harness);
            release.resolve();
            await reloading;

            expect(context.stopGeneration).toHaveBeenCalledTimes(1);
            expect(harness.disk()).toEqual(original);
            expect(context.fetch).toHaveBeenCalledTimes(1);
            expect(context.chat).toEqual(original);
            expect(harness.rendered()).toEqual(original);
            expect(context.chat_metadata).toEqual({ integrity: 'disk' });
            expect(context.eventSource.emit).toHaveBeenCalledWith('chat_changed', group ? 'branch-2' : 'character-chat');
        });
    }

    test('keeps live messages and rendered chat intact while a fetch is pending and after it fails', async () => {
        const harness = reloadContext();
        const { context } = harness;
        const fetching = deferred();
        const response = deferred();
        context.fetch.mockImplementation(() => {
            fetching.resolve();
            return response.promise;
        });
        const reloading = context.reloadCurrentChatUnsafe();
        await fetching.promise;

        expectPreserved(harness);
        // A save from another caller during network latency must still see the complete live chat.
        await context.saveChatConditional();
        expect(harness.disk()).toEqual(harness.original);
        response.resolve({ ok: false, status: 500 });
        await reloading;

        expectPreserved(harness);
        expect(context.toastr.error).toHaveBeenCalled();
    });

    test('discards a completed fetch after navigation even when the next group uses the same filename', async () => {
        const { context, rendered } = reloadContext({ group: true });
        const fetching = deferred();
        const response = deferred();
        context.fetch.mockImplementation(() => {
            fetching.resolve();
            return response.promise;
        });
        const reloading = context.reloadCurrentChatUnsafe();
        await fetching.promise;

        context.groups.push({ id: 'group-2', chat_id: 'branch-2' });
        context.selected_group = 'group-2';
        context.chat.splice(0, context.chat.length, { mes: 'Other group turn' });
        context.chat_metadata = { integrity: 'other-group' };
        await context.printMessages();
        response.resolve({ ok: true, json: async () => [{ mes: 'Stale original group turn' }] });
        await reloading;

        expect(context.chat).toEqual([{ mes: 'Other group turn' }]);
        expect(context.chat_metadata).toEqual({ integrity: 'other-group' });
        expect(rendered()).toEqual([{ mes: 'Other group turn' }]);
        expect(context.clearChat).not.toHaveBeenCalled();
        expect(context.eventSource.emit).not.toHaveBeenCalled();
    });

    for (const navigation of ['group', 'branch']) {
        test(`does not save into the old target after ${navigation} navigation during generation abort`, async () => {
            const harness = reloadContext({ group: true, active: true });
            const { context } = harness;
            const waiting = deferred();
            const release = deferred();
            context.stopGeneration.mockImplementation(() => {});
            context.delay.mockImplementation(() => {
                waiting.resolve();
                return release.promise;
            });
            const reloading = context.reloadCurrentChatUnsafe();
            await waiting.promise;

            if (navigation === 'group') {
                context.groups.push({ id: 'group-2', chat_id: 'branch-2' });
                context.selected_group = 'group-2';
            } else {
                context.groups[0].chat_id = 'branch-3';
            }
            context.chat.splice(0, context.chat.length, { mes: 'Newly selected chat' });
            context.chat_metadata = { integrity: 'new-target' };
            await context.printMessages();
            context.is_send_press = false;
            context.activeGenerationRun = null;
            release.resolve();
            await reloading;

            expect(context.saveGroupChat).not.toHaveBeenCalled();
            expect(context.saveChatConditional).not.toHaveBeenCalled();
            expect(context.fetch).not.toHaveBeenCalled();
            expect(context.chat).toEqual([{ mes: 'Newly selected chat' }]);
            expect(context.chat_metadata).toEqual({ integrity: 'new-target' });
            expect(harness.rendered()).toEqual([{ mes: 'Newly selected chat' }]);
            expect(context.clearChat).not.toHaveBeenCalled();
        });
    }

    test('preserves pending edits when the navigation save refuses to flush', async () => {
        const harness = reloadContext();
        harness.context.flushPendingChatSavesForNavigation.mockResolvedValue(false);

        await harness.context.reloadCurrentChatUnsafe();

        expect(harness.context.fetch).not.toHaveBeenCalled();
        expectPreserved(harness);
    });
});
