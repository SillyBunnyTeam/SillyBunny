/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const sources = Object.fromEntries(['script.js', 'scripts/extensions.js', 'scripts/group-chats.js', 'scripts/utils.js'].map(file => {
    const source = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    return [file, { source, ast: parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) }];
}));

// The host's lifecycle tests also execute extracted declarations to avoid booting the browser bundle.
function load(context, file, names) {
    const { source, ast } = sources[file];
    for (const name of names) {
        const node = ast.body.map(node => node.declaration ?? node).find(node => node.id?.name === name);
        if (!node) throw new Error(`Missing declaration: ${name}`);
        vm.runInContext(source.slice(node.start, node.end), context);
    }
}

function saveContext(group = false) {
    const context = vm.createContext({
        console: { error: jest.fn(), warn: jest.fn() },
        selected_group: group ? 'group' : null,
        saveChat: jest.fn(async () => true),
        saveGroupChat: jest.fn(async () => true),
        cancelDebouncedChatSave: jest.fn(),
        setChatSaveActive: jest.fn(),
        saveTokenCache: jest.fn(async () => {}),
        saveItemizedPrompts: jest.fn(async () => {}),
        getCurrentChatId: () => 'story',
    });
    load(context, 'script.js', ['saveChatConditional', 'saveMetadata']);
    return context;
}

describe('strict host chat saves', () => {
    test.each([false, true])('returns success and forwards strict options (group: %s)', async group => {
        const context = saveContext(group);
        const options = { throwOnError: true, deferBackup: true, allowShrink: true };
        await expect(context.saveMetadata(options)).resolves.toBe(true);
        const helper = group ? context.saveGroupChat : context.saveChat;
        expect(helper).toHaveBeenCalledWith(...(group ? ['group', true, false, true, options] : [options]));
        expect(context.saveItemizedPrompts).toHaveBeenCalledWith('story');
        expect(context.setChatSaveActive).toHaveBeenLastCalledWith(false);
    });

    test.each([false, undefined])('rejects a lower helper refusal (%s), while default callers receive false', async result => {
        for (const group of [false, true]) {
            const context = saveContext(group);
            const helper = group ? context.saveGroupChat : context.saveChat;
            helper.mockResolvedValue(result);
            await expect(context.saveChatConditional({ throwOnError: true })).rejects.toThrow('Chat was not saved');
            await expect(context.saveChatConditional()).resolves.toBe(false);
            expect(context.saveTokenCache).not.toHaveBeenCalled();
            expect(context.setChatSaveActive).toHaveBeenLastCalledWith(false);
        }
    });

    test('preserves the original rejection and the default swallow behaviour', async () => {
        const context = saveContext();
        const error = new Error('network failure');
        context.saveChat.mockRejectedValue(error);
        await expect(context.saveMetadata({ throwOnError: true })).rejects.toBe(error);
        await expect(context.saveMetadata()).resolves.toBe(false);
        expect(context.setChatSaveActive).toHaveBeenLastCalledWith(false);
    });

    test.each(['http', 'integrity', 'missing'])('executes the queued character save through a real %s refusal', async failure => {
        const context = saveContext();
        Object.assign(context, {
            structuredClone,
            chatSaveQueue: Promise.resolve(),
            chat: [{ mes: 'original', extra: {} }],
            chat_metadata: {},
            this_chid: 0,
            characters: [{ name: 'Story', avatar: 'story.png', chat: failure === 'missing' ? '' : 'story' }],
            name2: 'Story',
            neutralCharacterName: 'Assistant',
            cloneChatSavePayload: structuredClone,
            getQueuedChatIntegrityKey: () => 'key',
            applyQueuedChatIntegrity: jest.fn(),
            rememberQueuedChatIntegrity: jest.fn(),
            compressRequest: async value => value,
            getRequestHeaders: () => ({}),
            fetch: jest.fn(async () => ({ ok: false, statusText: 'failure', json: async () => ({ error: failure }) })),
            Popup: { show: { input: async () => '' } },
            window: { location: { reload: jest.fn() } },
            toastr: { error: jest.fn() },
            t: strings => strings.join(''),
        });
        load(context, 'script.js', ['saveChat', 'saveChatImmediately']);
        await expect(context.saveMetadata({ throwOnError: true })).rejects.toThrow();
        await expect(context.saveMetadata()).resolves.toBe(false);
        expect(context.saveTokenCache).not.toHaveBeenCalled();
    });

    test.each(['group', 123])('waits for group metadata and rejects its HTTP failure instead of scheduling success: %s', async id => {
        const context = saveContext(true);
        Object.assign(context, {
            structuredClone,
            groupChatSaveQueue: Promise.resolve(),
            selected_group: String(id),
            groups: [{ id, chat_id: 'story', chats: ['story'] }],
            chat: [{ mes: 'original', extra: {} }],
            chat_metadata: {},
            cloneGroupChatSavePayload: structuredClone,
            applyQueuedGroupChatIntegrity: jest.fn(),
            rememberQueuedGroupChatIntegrity: jest.fn(),
            compressRequest: async value => value,
            getRequestHeaders: () => ({}),
            refreshCsrfToken: jest.fn(),
            fetchWithCsrfRetry: jest.fn(async (url, build) => {
                await build();
                return { ok: true, json: async () => ({ integrity: 'saved' }) };
            }),
            fetch: jest.fn(async () => ({ ok: false })),
            saveGroupDebounced: jest.fn(),
        });
        load(context, 'scripts/group-chats.js', ['saveGroupChat', 'saveGroupChatImmediately', 'editGroup', '_save']);
        await expect(context.saveMetadata({ throwOnError: true })).rejects.toThrow('Could not save group');
        expect(context.fetch).toHaveBeenCalledWith('/api/groups/edit', expect.any(Object));
        expect(context.saveGroupDebounced).not.toHaveBeenCalled();
        await expect(context.saveMetadata()).resolves.toBe(true);
        expect(context.saveGroupDebounced).toHaveBeenCalledTimes(typeof id === 'string' ? 1 : 0);
    });

    test('propagates an actual group integrity decline without saving metadata or caches', async () => {
        const context = saveContext(true);
        Object.assign(context, {
            structuredClone, groupChatSaveQueue: Promise.resolve(),
            groups: [{ id: 'group', chat_id: 'story', chats: ['story'] }],
            chat: [{ mes: 'original', extra: {} }], chat_metadata: {},
            cloneGroupChatSavePayload: structuredClone,
            applyQueuedGroupChatIntegrity: jest.fn(),
            refreshCsrfToken: jest.fn(),
            fetchWithCsrfRetry: jest.fn(async () => ({ ok: false, json: async () => ({ error: 'integrity' }) })),
            Popup: { show: { input: async () => '' } },
            window: { location: { reload: jest.fn() } },
            t: strings => strings.join(''), editGroup: jest.fn(),
        });
        load(context, 'scripts/group-chats.js', ['saveGroupChat', 'saveGroupChatImmediately']);
        await expect(context.saveMetadata({ throwOnError: true })).rejects.toThrow('Chat was not saved');
        await expect(context.saveMetadata()).resolves.toBe(false);
        expect(context.editGroup).not.toHaveBeenCalled();
        expect(context.saveTokenCache).not.toHaveBeenCalled();
        expect(context.saveItemizedPrompts).not.toHaveBeenCalled();
    });
});

function fieldContext() {
    const character = { avatar: 'story.png', data: { extensions: { story: { enabled: false }, other: 1 } } };
    character.json_data = JSON.stringify({ data: structuredClone(character.data) });
    const state = { characters: [character], characterId: 0 };
    const form = { val: jest.fn() };
    const context = vm.createContext({
        console: { error: jest.fn(), warn: jest.fn() },
        getContext: () => state,
        getRequestHeaders: () => ({}),
        UNSET_VALUE: '__@@UNSET@@__',
        $: () => form,
        fetch: jest.fn(async () => ({ ok: true })),
    });
    load(context, 'scripts/utils.js', ['setValueByPath', 'deleteValueByPath']);
    load(context, 'scripts/extensions.js', ['writeExtensionField']);
    return { context, state, character, form };
}

describe('strict host extension field writes', () => {
    test.each(['http', 'network'])('does not mutate the card, JSON or form on %s failure', async failure => {
        const { context, character, form } = fieldContext();
        const original = structuredClone(character);
        context.fetch.mockImplementation(async () => {
            character.data.extensions.other = 2;
            if (failure === 'network') throw new Error('network failure');
            return { ok: false, statusText: 'failure' };
        });
        await expect(context.writeExtensionField(0, 'story', { enabled: true }, { throwOnError: true })).rejects.toThrow();
        expect(character.data.extensions).toEqual({ story: { enabled: false }, other: 2 });
        expect(character.json_data).toBe(original.json_data);
        expect(form.val).not.toHaveBeenCalled();
    });

    test('commits the sent value only after success and keeps unrelated concurrent changes', async () => {
        const { context, state, character, form } = fieldContext();
        let respond;
        context.fetch.mockReturnValue(new Promise(resolve => { respond = resolve; }));
        const value = { enabled: true };
        const pending = context.writeExtensionField(0, 'story', value, { throwOnError: true });
        expect(character.data.extensions.story.enabled).toBe(false);
        expect(form.val).not.toHaveBeenCalled();

        value.enabled = false;
        character.data.extensions.other = 2;
        character.json_data = JSON.stringify({ data: { extensions: { ...character.data.extensions, newer: 3 } } });
        state.characters.unshift({ avatar: 'other.png' });
        state.characterId = 0;
        respond({ ok: true });
        await expect(pending).resolves.toBe(true);
        expect(character.data.extensions).toEqual({ story: { enabled: true }, other: 2 });
        expect(JSON.parse(character.json_data).data.extensions).toEqual({ story: { enabled: true }, other: 2, newer: 3 });
        expect(form.val).not.toHaveBeenCalled();
        expect(JSON.parse(context.fetch.mock.calls[0][1].body)).toEqual({ avatar: 'story.png', data: { extensions: { story: { enabled: true } } } });
    });

    test('updates the active form after strict success and keeps the UNSET request shape', async () => {
        const { context, character, form } = fieldContext();
        await expect(context.writeExtensionField('0', 'story', context.UNSET_VALUE, { throwOnError: true })).resolves.toBe(true);
        expect(character.data.extensions).toEqual({ other: 1 });
        expect(JSON.parse(character.json_data).data.extensions).toEqual({ other: 1 });
        expect(form.val).toHaveBeenCalledWith(character.json_data);
        expect(JSON.parse(context.fetch.mock.calls[0][1].body).data.extensions.story).toBe(context.UNSET_VALUE);
    });

    test('retains optimistic mutation and undefined return for default HTTP failures', async () => {
        const { context, character, form } = fieldContext();
        context.fetch.mockResolvedValue({ ok: false, statusText: 'failure' });
        await expect(context.writeExtensionField(0, 'story', true)).resolves.toBeUndefined();
        expect(character.data.extensions.story).toBe(true);
        expect(form.val).toHaveBeenCalledWith(character.json_data);
    });

    test('rejects a missing card or identity before sending a strict request', async () => {
        const { context, character } = fieldContext();
        await expect(context.writeExtensionField(5, 'story', true, { throwOnError: true })).rejects.toThrow('Character not found');
        delete character.avatar;
        await expect(context.writeExtensionField(0, 'story', true, { throwOnError: true })).rejects.toThrow('identity');
        expect(context.fetch).not.toHaveBeenCalled();
        await expect(context.writeExtensionField(5, 'story', true)).resolves.toBeUndefined();
    });

    test('does not commit to a different card if the target disappears during the request', async () => {
        const { context, state, character, form } = fieldContext();
        context.fetch.mockImplementation(async () => {
            state.characters = [{ avatar: 'replacement.png', data: { extensions: {} } }];
            return { ok: true };
        });
        await expect(context.writeExtensionField(0, 'story', true, { throwOnError: true })).rejects.toThrow('no longer available');
        expect(character.data.extensions.story.enabled).toBe(false);
        expect(state.characters[0].data.extensions).toEqual({});
        expect(form.val).not.toHaveBeenCalled();
    });
});
