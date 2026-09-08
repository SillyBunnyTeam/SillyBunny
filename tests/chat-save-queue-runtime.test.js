import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, jest, test } from '@jest/globals';
import { getQueuedChatSaveAbortReason } from '../public/scripts/chat-save-guard.js';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

function createSaveRuntime() {
    let releaseQueue;
    const runtime = vm.createContext({
        console: { trace: jest.fn(), warn: jest.fn(), error: jest.fn() },
        structuredClone,
        chatSaveQueue: new Promise(resolve => { releaseQueue = resolve; }),
        chat: [{ mes: 'queued message', extra: { value: 'queued' } }],
        chat_metadata: { integrity: 'original' },
        chatGeneration: 1,
        this_chid: 0,
        selected_group: null,
        characters: [{ name: 'Bunny', avatar: 'bunny.png', chat: 'original-chat' }],
        name2: 'Bunny', neutralCharacterName: 'Assistant',
        getQueuedChatSaveAbortReason,
        getCurrentChatId: () => runtime.characters[runtime.this_chid]?.chat,
        cloneChatSavePayload: structuredClone,
        setChatSaveActive: jest.fn(),
        getQueuedChatIntegrityKey: () => 'key',
        applyQueuedChatIntegrity: jest.fn(),
        rememberQueuedChatIntegrity: jest.fn(),
        compressRequest: async request => request,
        getRequestHeaders: () => ({}),
        fetch: jest.fn(async () => ({ ok: true, json: async () => ({ integrity: 'saved' }) })),
        toastr: { error: jest.fn() },
        t: strings => strings.join(''),
    });
    for (const name of ['saveChat', 'saveChatImmediately']) {
        const node = ast.body.map(node => node.declaration ?? node).find(node => node.id?.name === name);
        vm.runInContext(source.slice(node.start, node.end), runtime);
    }
    return { runtime, releaseQueue };
}

describe('real chat save queue', () => {
    test('snapshots legacy positional saves before they wait in the queue', async () => {
        const { runtime, releaseQueue } = createSaveRuntime();
        const save = runtime.saveChat('copy-chat', { label: 'queued metadata' }, 0, false, true);
        runtime.chat[0].mes = 'later message';
        runtime.chat[0].extra.value = 'later';
        runtime.chat_metadata.label = 'later metadata';
        releaseQueue();

        await expect(save).resolves.toBe(true);
        const payload = JSON.parse(runtime.fetch.mock.calls[0][1].body);
        expect(payload).toMatchObject({
            file_name: 'copy-chat', avatar_url: 'bunny.png',
            chat: [{ chat_metadata: { label: 'queued metadata' } }, { mes: 'queued message', extra: { value: 'queued' } }],
        });
    });

    test('legacy callers can omit the filename and save the active chat', async () => {
        const { runtime, releaseQueue } = createSaveRuntime();
        const save = runtime.saveChat(undefined, { label: 'legacy' });
        releaseQueue();
        await expect(save).resolves.toBe(true);
        expect(JSON.parse(runtime.fetch.mock.calls[0][1].body).file_name).toBe('original-chat');
    });

    test('invalidates legacy positional saves after a swipe or chat reload', async () => {
        const { runtime, releaseQueue } = createSaveRuntime();
        const save = runtime.saveChat('original-chat', {}, undefined, false, true);
        runtime.chatGeneration++;
        releaseQueue();
        await expect(save).resolves.toBe(false);
        expect(runtime.fetch).not.toHaveBeenCalled();
    });

    test('invalidates object saves after a character switch without writing a new file', async () => {
        const { runtime, releaseQueue } = createSaveRuntime();
        const save = runtime.saveChat();
        runtime.characters.push({ name: 'Other', avatar: 'other.png', chat: 'other-chat' });
        runtime.this_chid = 1;
        releaseQueue();
        await expect(save).resolves.toBe(false);
        expect(runtime.fetch).not.toHaveBeenCalled();
    });
});
