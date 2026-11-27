/** @jest-environment jsdom */
import { TextEncoder } from 'node:util';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

if (typeof window.TextEncoder === 'undefined') {
    window.TextEncoder = TextEncoder;
}

const views = new Map();
const chats = new Map();
const confirmConversationAction = jest.fn(async () => true);
const isConversationActive = jest.fn(() => false);
const scheduleConversationListRender = jest.fn();
const scheduleInterfaceRefresh = jest.fn();
const scheduleTimelineRender = jest.fn();
const deleteMessagesInChat = jest.fn(() => []);
const identityOf = jest.fn(view => ({ avatar: view.characters?.[0] ?? '', groupId: view.kind === 'group' ? view.id : '' }));

const conversationData = {
    get: jest.fn(id => views.get(id) ?? null),
    chat: jest.fn(address => (address ? chats.get(`${address.conversationId}:${address.chatId}`) ?? null : null)),
    commitChat: jest.fn((address, edit) => {
        const loaded = chats.get(`${address.conversationId}:${address.chatId}`);
        if (loaded) {
            edit(loaded);
        }
    }),
    deleteChat: jest.fn(async ({ conversationId, chatId }) => {
        const view = views.get(conversationId);
        if (view) {
            view.chats = view.chats.filter(chat => chat.id !== chatId);
        }
        return view;
    }),
    exportChat: jest.fn(async ({ chatId }) => ({ text: `{"id":"${chatId}"}\n` })),
};

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/dialogs.js', () => ({ confirmConversationAction }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/notifications.js', () => ({ isConversationActive }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({
    scheduleConversationListRender,
    scheduleInterfaceRefresh,
    scheduleTimelineRender,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-render.js', () => ({ deleteMessagesInChat }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/details/access.js', () => ({
    conversationData,
    getCardName: avatar => avatar || 'Character',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/details/actions.js', () => ({ identityOf }));

const { deleteChats, downloadAttachmentsArchive, removeAttachmentsFromChat } = await import('../public/scripts/sillybunny-conversation/details/bulk-actions.js');

describe('bulk actions: app actions', () => {
    const origFetch = window.fetch;
    const origJSZip = window.JSZip;
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;

    beforeEach(() => {
        views.clear();
        chats.clear();
        jest.clearAllMocks();
        confirmConversationAction.mockResolvedValue(true);
        isConversationActive.mockReturnValue(false);
        identityOf.mockImplementation(view => ({ avatar: view.characters?.[0] ?? '', groupId: view.kind === 'group' ? view.id : '' }));
        window.toastr = { error: jest.fn(), warning: jest.fn(), info: jest.fn() };
    });

    afterEach(() => {
        window.fetch = origFetch;
        window.JSZip = origJSZip;
        URL.createObjectURL = origCreateObjectURL;
        URL.revokeObjectURL = origRevokeObjectURL;
        jest.restoreAllMocks();
    });

    test('deleteChats deletes through conversationData.deleteChat even for an orphaned group with no anchor avatar, and re-plans after the alert', async () => {
        const view = {
            id: 'group-1',
            kind: 'group',
            name: 'Orphaned Group',
            personaId: 'p1',
            characters: [],
            activeChatId: 'c1',
            chats: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
        };
        views.set('group-1', view);
        identityOf.mockReturnValue({ avatar: '', groupId: 'group-1' });
        confirmConversationAction.mockImplementationOnce(async () => {
            // While the alert is open, c2 becomes the active chat and c3 is removed elsewhere.
            view.activeChatId = 'c2';
            view.chats = [{ id: 'c1' }, { id: 'c2' }];
            return true;
        });

        const deleted = await deleteChats('group-1', ['c1', 'c2', 'c3']);
        expect(deleted).toBe(true);
        expect(conversationData.deleteChat.mock.calls.map(([arg]) => arg)).toEqual([
            { conversationId: 'group-1', chatId: 'c1' },
            { conversationId: 'group-1', chatId: 'c2' },
        ]);
        expect(scheduleConversationListRender).toHaveBeenCalledTimes(1);
    });

    test('downloadAttachmentsArchive uses STORE for Media, rejects cross-origin redirects, and respects an aborted signal', async () => {
        const generatedOptions = [];
        window.JSZip = class FakeJSZip {
            constructor() { this.files = []; }
            file(name, data) { this.files.push({ name, data }); }
            async generateAsync(options) {
                generatedOptions.push(options);
                return new Uint8Array([80, 75, 5, 6]);
            }
        };
        URL.createObjectURL = jest.fn(() => 'blob:http://localhost/zip');
        URL.revokeObjectURL = jest.fn();
        jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        window.fetch = jest.fn(async (url) => {
            if (url === '/redirect') {
                return { ok: true, status: 200, url: 'https://evil.example/payload.png', arrayBuffer: async () => new Uint8Array([1]).buffer };
            }
            return { ok: true, status: 200, url: `${window.location.origin}${url}`, arrayBuffer: async () => new Uint8Array([1, 2]).buffer };
        });

        const view = { id: 'conv-1', name: 'Ada', characters: ['ada.png'] };
        const saved = await downloadAttachmentsArchive(view, [
            { kind: 'image', url: '/img/ok.png' },
            { kind: 'image', url: '/redirect' },
        ], 'Media');
        expect(saved).toBe(true);
        expect(generatedOptions).toEqual([{ type: 'uint8array', compression: 'STORE' }]);
        expect(window.toastr.warning).toHaveBeenCalledWith('Could not download: redirect', '', expect.any(Object));

        const aborted = new AbortController();
        aborted.abort();
        const afterAbort = await downloadAttachmentsArchive(view, [{ kind: 'image', url: '/img/ok.png' }], 'Media', { signal: aborted.signal });
        expect(afterAbort).toBe(false);
    });

    test('removeAttachmentsFromChat skips rendering when the attachment disappeared while the alert was open', async () => {
        views.set('conv-1', { id: 'conv-1', activeChatId: 'c1', chats: [{ id: 'c1' }] });
        const loaded = { messages: [{ id: 'm1', mes: 'hi', extra: { media: [{ url: '/a.png', type: 'image' }] } }] };
        chats.set('conv-1:c1', loaded);
        confirmConversationAction.mockImplementationOnce(async () => {
            loaded.messages[0].extra = {};
            return true;
        });

        expect(await removeAttachmentsFromChat('conv-1', ['m1:media:0'], 'item')).toBe(true);
        expect(conversationData.commitChat).not.toHaveBeenCalled();
        expect(deleteMessagesInChat).not.toHaveBeenCalled();
        expect(scheduleTimelineRender).not.toHaveBeenCalled();
    });
});
