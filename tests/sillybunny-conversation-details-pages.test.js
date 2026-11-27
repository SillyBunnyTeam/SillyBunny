/** @jest-environment jsdom */
/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const views = new Map();
const chats = new Map();
const listeners = new Set();
const removalListeners = new Set();

const conversationData = {
    get: jest.fn(id => views.get(id) ?? null),
    chat: jest.fn(address => (address ? chats.get(`${address.conversationId}:${address.chatId}`) ?? null : null)),
    loadChat: jest.fn(async address => chats.get(`${address.conversationId}:${address.chatId}`) ?? null),
    commitChat: jest.fn((address, mutator) => {
        const chat = chats.get(`${address.conversationId}:${address.chatId}`);
        if (chat) {
            mutator(chat);
        }
    }),
    reminders: jest.fn(id => views.get(id)?.reminders ?? []),
    cancelReminder: jest.fn(),
    patchConversation: jest.fn(),
    subscribe: jest.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }),
    onRemoval: jest.fn((listener) => {
        removalListeners.add(listener);
        return () => removalListeners.delete(listener);
    }),
};

const emit = event => {
    for (const listener of [...listeners]) {
        listener(event);
    }
};

const ensureConversationChatLoaded = jest.fn(async () => undefined);
const getConversationMessages = jest.fn(() => []);
const updateConversationMemorySummary = jest.fn(async () => true);
const getConversationMemorySummary = jest.fn(() => 'Saved memory');
const saveConversationMemorySummary = jest.fn();
const clearConversationMemorySummary = jest.fn(() => true);
const addMembersTo = jest.fn(async () => ({ switched: false }));
const showMessageInTimeline = jest.fn(async () => undefined);
const scheduleTimelineRender = jest.fn();
const releaseRowIds = jest.fn();
const openDialog = jest.fn();
const ensureDetailsStyles = jest.fn(async () => undefined);
const openActionMenu = jest.fn();

const createStubRow = (label = '') => {
    const row = document.createElement('div');
    row.className = 'ds-row';
    const text = document.createElement('div');
    text.className = 'ds-row-text';
    row.append(text);
    const textarea = document.createElement('textarea');
    row.append(textarea);
    return {
        row,
        setValue: jest.fn(val => { textarea.value = val; }),
        setDisabled: jest.fn(),
        destroy: jest.fn(),
    };
};

await jest.unstable_mockModule('../public/scripts/sillybunny-editor/rows.js', () => ({
    createButtonRow: jest.fn(({ label, onActivate }) => {
        const made = createStubRow(label);
        made.onActivate = onActivate;
        return made;
    }),
    createEntryRow: jest.fn(({ label }) => createStubRow(label)),
    createPrefGroup: jest.fn(({ rows = [] }) => {
        const section = document.createElement('section');
        const group = document.createElement('div');
        for (const item of rows) {
            group.append(item.row ?? item);
        }
        section.append(group);
        return { section, group };
    }),
    createRow: jest.fn(({ label, suffix }) => {
        const made = createStubRow(label);
        if (suffix) {
            made.row.append(suffix);
        }
        return made;
    }),
    createSpinRow: jest.fn(({ label }) => createStubRow(label)),
    createSwitchRow: jest.fn(({ label }) => createStubRow(label)),
    createTextAreaField: jest.fn(({ label }) => createStubRow(label)),
    releaseRowIds,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/select-row.js', () => ({
    createSelectRow: jest.fn(({ label }) => createStubRow(label)),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/toggle-row.js', () => ({
    createToggleRow: jest.fn(({ label }) => createStubRow(label)),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/picker.js', () => ({
    mountPicker: jest.fn((_host, opts) => ({
        focusSearch: jest.fn(),
        destroy: jest.fn(),
        select: value => opts.onSelect(value),
    })),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/lazy-image.js', () => ({
    createLazyImage: jest.fn((src) => {
        const img = document.createElement('img');
        img.src = src;
        return img;
    }),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/dialog.js', () => ({ createIconButton: jest.fn(() => document.createElement('button')), openAlert: jest.fn(async () => 'cancel'), openDialog }));
await jest.unstable_mockModule('../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu }));
await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({ world_names: [] }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/dialogs.js', () => ({
    confirmConversationAction: jest.fn(async () => true),
    promptConversationText: jest.fn(async () => 'Updated'),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    ensureConversationChatLoaded,
    getConversationMessages,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/prompt.js', () => ({
    updateConversationMemorySummary,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    clearConversationMemorySummary,
    getConversationMemorySummary,
    saveConversationMemorySummary,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({
    scheduleTimelineRender,
}));
// The pages' selection mode imports the shared selection mode and the Show More row, which read the page's locale data through `t`; the bulk actions reach the whole app.
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (strings, ...values) => strings.reduce((text, string, index) => text + string + (values[index] ?? ''), '') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/details/bulk-actions.js', () => ({
    deleteChats: jest.fn(async () => true),
    downloadAttachmentsArchive: jest.fn(async () => true),
    exportChatsArchive: jest.fn(async () => true),
    removeAttachmentsFromChat: jest.fn(async () => true),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/details/styles.js', () => ({
    ensureDetailsStyles,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/details/avatars.js', () => ({
    createAvatar: () => document.createElement('div'),
    createCharacterAvatar: () => document.createElement('div'),
    createConversationAvatar: () => document.createElement('div'),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/details/actions.js', () => ({
    addMembersTo,
    identityOf: view => ({ avatar: view.characters[0], groupId: view.kind === 'group' ? view.id : '' }),
    openCharacterEditor: jest.fn(async () => undefined),
    openConversation: jest.fn(async () => true),
    openDirectConversationWith: jest.fn(async () => true),
    showMessageInTimeline,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/details/access.js', () => ({
    GEECHAN_DEFAULT_PROMPT: 'default',
    conversationData,
    describeCharacterStatus: () => ({ status: 'online', label: 'Online', line: 'Online' }),
    getCardName: avatar => avatar.replace(/\.png$/, ''),
    getCharacterPickerOptions: () => ({ items: [{ value: 'bob.png', label: 'Bob' }] }),
    getFullPictureUrl: avatar => `/characters/${avatar}`,
    getView: id => views.get(id) ?? null,
    readSettings: () => ({
        geechan_chatroom_prompt: '',
        authors_note: '',
        lorebook_override: '',
        include_related_memory: false,
        roleplay_reactions: false,
        prose_polisher: false,
        proactive_messaging: false,
        inactivity_threshold: 30,
        max_followups: 1,
        offline_message: '',
        selfie_command_enabled: false,
        schedule_command_enabled: false,
        characters_react: false,
        image_gen_enabled: false,
        image_gen_prompt_template: '',
        image_gen_negative: '',
        image_gen_cooldown: 0,
        spontaneous_selfies: false,
    }),
    requireView: id => {
        const view = views.get(id);
        if (!view) {
            throw new Error(`The conversation ${id} is not there.`);
        }
        return view;
    },
    writeSetting: jest.fn(),
}));

const dialogModule = await import('../public/scripts/sillybunny-editor/dialog.js');
const { buildAdvanced } = await import('../public/scripts/sillybunny-conversation/details/pages/advanced.js');
const { buildFiles, buildPinned } = await import('../public/scripts/sillybunny-conversation/details/pages/shared.js');
const { buildAddMember } = await import('../public/scripts/sillybunny-conversation/details/pages/add-member.js');
const { buildGeneral } = await import('../public/scripts/sillybunny-conversation/details/pages/general.js');
const { buildBehaviour } = await import('../public/scripts/sillybunny-conversation/details/pages/behaviour.js');
const { toAvatarDataUrl } = await import('../public/scripts/sillybunny-conversation/details/avatar-upload.js');

let lastWindowNav = null;
const leaveSelection = jest.fn();
const canClose = jest.fn(() => true);
const onMount = jest.fn();
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/details/pages/index.js', () => ({
    isKnownPage: id => ['general', 'add-member'].includes(id),
    buildPage: (id, ctx) => {
        lastWindowNav = ctx.nav;
        const spec = id === 'add-member' ? buildAddMember(ctx) : buildGeneral(ctx);
        // The pages of selection mode have this; the window calls it, whichever page it is.
        return Object.assign(spec, { leaveSelection, canClose, onMount });
    },
}));
const { openConversationDetails } = await import('../public/scripts/sillybunny-conversation/details/window.js');

const flush = async () => {
    for (let i = 0; i < 8; i++) {
        await Promise.resolve();
    }
};

function makeView(overrides = {}) {
    return {
        id: 'conv-1',
        kind: 'direct',
        name: 'Ada',
        description: '',
        avatar: '',
        characters: ['ada.png'],
        extras: [],
        personaId: 'persona-1',
        activeChatId: 'chat-1',
        chats: [{ id: 'chat-1', name: 'Chat 1', messageCount: 2 }],
        settings: {},
        reminders: [],
        ...overrides,
    };
}

describe('details pages lifecycle, URL safety, and row ID cleanup', () => {
    beforeEach(() => {
        views.clear();
        chats.clear();
        listeners.clear();
        removalListeners.clear();
        jest.clearAllMocks();
        document.body.replaceChildren();
        globalThis.toastr = { info: jest.fn(), success: jest.fn(), error: jest.fn(), clear: jest.fn() };
    });

    afterEach(() => {
        jest.restoreAllMocks();
        document.body.replaceChildren();
    });

    test('advanced page guards async load completion and chat events after deletion or dispose', async () => {
        let resolveLoad;
        ensureConversationChatLoaded.mockImplementationOnce(() => new Promise((resolve) => {
            resolveLoad = resolve;
        }));
        views.set('conv-1', makeView());
        const nav = { gone: jest.fn(), close: jest.fn(), push: jest.fn() };

        const page = buildAdvanced({ conversationId: 'conv-1', nav });
        views.delete('conv-1');

        expect(() => emit({ type: 'chat', address: { conversationId: 'conv-1', chatId: 'chat-1' } })).not.toThrow();
        resolveLoad();
        await flush();
        expect(globalThis.toastr.error).not.toHaveBeenCalled();

        page.dispose();
        views.set('conv-1', makeView());
        getConversationMemorySummary.mockClear();
        emit({ type: 'chat', address: { conversationId: 'conv-1', chatId: 'chat-1' } });
        expect(getConversationMemorySummary).not.toHaveBeenCalled();
    });

    test('shared page loads newly activated unloaded chats and ignores stale out-of-order loads', async () => {
        const view = makeView({
            activeChatId: 'chat-1',
            chats: [
                { id: 'chat-1', name: 'Chat 1' },
                { id: 'chat-2', name: 'Chat 2' },
                { id: 'chat-3', name: 'Chat 3' },
            ],
        });
        views.set('conv-1', view);
        chats.set('conv-1:chat-1', {
            messages: [{ id: 'm1', role: 'user', name: 'You', mes: '', created_at: 100, extra: { files: [{ url: '/u/one.txt', name: 'one.txt', size: 10 }] } }],
        });

        const deferredLoads = new Map();
        conversationData.loadChat.mockImplementation(address => new Promise((resolve) => {
            deferredLoads.set(address.chatId, resolve);
        }));

        const nav = { gone: jest.fn(), close: jest.fn(), viewPicture: jest.fn() };
        const page = buildFiles({ conversationId: 'conv-1', nav });
        expect(page.content.textContent).toContain('one.txt');

        // Switch to unloaded chat-2: stale chat-1 items must clear and loadChat must run.
        view.activeChatId = 'chat-2';
        emit({ type: 'list', id: 'conv-1' });
        expect(conversationData.loadChat).toHaveBeenCalledWith({ conversationId: 'conv-1', chatId: 'chat-2' });
        expect(page.content.textContent).not.toContain('one.txt');

        // Switch quickly to chat-3 before chat-2 resolves.
        view.activeChatId = 'chat-3';
        emit({ type: 'list', id: 'conv-1' });
        expect(conversationData.loadChat).toHaveBeenCalledWith({ conversationId: 'conv-1', chatId: 'chat-3' });

        // Stale chat-2 resolves first — must not overwrite chat-3.
        chats.set('conv-1:chat-2', {
            messages: [{ id: 'm2', role: 'user', name: 'You', mes: '', created_at: 200, extra: { files: [{ url: '/u/two.txt', name: 'two.txt', size: 20 }] } }],
        });
        deferredLoads.get('chat-2')(chats.get('conv-1:chat-2'));
        await flush();
        expect(page.content.textContent).not.toContain('two.txt');

        // Now chat-3 resolves and renders.
        chats.set('conv-1:chat-3', {
            messages: [{ id: 'm3', role: 'user', name: 'You', mes: '', created_at: 300, extra: { files: [{ url: '/u/three.txt', name: 'three.txt', size: 30 }] } }],
        });
        deferredLoads.get('chat-3')(chats.get('conv-1:chat-3'));
        await flush();
        expect(page.content.textContent).toContain('three.txt');
        page.dispose();
    });

    test('shared Files page blocks unsafe download URLs and allows safe ones', () => {
        views.set('conv-1', makeView());
        chats.set('conv-1:chat-1', {
            messages: [{
                id: 'm1',
                role: 'user',
                name: 'You',
                mes: '',
                created_at: 100,
                extra: {
                    files: [
                        { url: 'javascript:alert(1)', name: 'evil.js', size: 10 },
                        { url: 'https://example.com/safe.pdf', name: 'safe.pdf', size: 50 },
                    ],
                },
            }],
        });

        const clickedHrefs = [];
        const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
            clickedHrefs.push(this.getAttribute('href'));
        });

        const page = buildFiles({ conversationId: 'conv-1', nav: { gone: jest.fn(), close: jest.fn() } });
        document.body.append(page.content);
        const rows = page.content.querySelectorAll('.sb-details-collection-row');
        expect(rows).toHaveLength(1);
        expect(page.content.textContent).not.toContain('evil.js');

        rows[0].click();
        expect(clickedHrefs).toEqual(['https://example.com/safe.pdf']);

        clickSpy.mockRestore();
        page.dispose();
    });

    test('pinned Undo restores the pin on its captured chatId and never throws after deletion', async () => {
        const view = makeView({
            activeChatId: 'chat-1',
            chats: [{ id: 'chat-1', name: 'Chat 1' }, { id: 'chat-2', name: 'Chat 2' }],
        });
        views.set('conv-1', view);
        const chat1Message = { id: 'm1', role: 'character', name: 'Ada', mes: 'Remember this', created_at: 100, extra: { conversation_pinned: true, conversation_pinned_at: 555 } };
        const chat2Message = { id: 'm1', role: 'character', name: 'Ada', mes: 'Different chat same id', created_at: 200, extra: {} };
        chats.set('conv-1:chat-1', { messages: [chat1Message] });
        chats.set('conv-1:chat-2', { messages: [chat2Message] });

        const page = buildPinned({ conversationId: 'conv-1', nav: { gone: jest.fn(), close: jest.fn() } });
        document.body.append(page.content);

        // Open row menu and click Unpin.
        page.content.querySelector('.sb-details-row-button').click();
        const unpin = openActionMenu.mock.calls[0][0].sections.flatMap(section => section.items).find(item => item.label === 'Unpin');
        unpin.onSelect();
        expect(chat1Message.extra.conversation_pinned).toBe(false);
        expect(globalThis.toastr.info).toHaveBeenCalledTimes(1);
        const undoButton = globalThis.toastr.info.mock.calls[0][0].querySelector('.sb-details-toast-undo');

        // Switch active chat to chat-2 before clicking Undo: must restore chat-1 and leave chat-2 untouched!
        view.activeChatId = 'chat-2';
        undoButton.click();
        await flush();
        expect(chat1Message.extra.conversation_pinned).toBe(true);
        expect(chat1Message.extra.conversation_pinned_at).toBe(555);
        expect(chat2Message.extra.conversation_pinned).toBeUndefined();

        // Deleting the conversation before Undo must not throw.
        views.delete('conv-1');
        expect(() => undoButton.click()).not.toThrow();
        await flush();
        page.dispose();
    });

    test('add-member onResponse exits cleanly when the conversation was deleted', async () => {
        views.set('conv-1', makeView());
        const nav = { close: jest.fn() };
        const page = buildAddMember({ conversationId: 'conv-1', nav });

        views.delete('conv-1');
        await expect(page.onResponse()).resolves.toBeUndefined();
        expect(addMembersTo).not.toHaveBeenCalled();
        page.dispose();
    });

    test('general and behaviour release row IDs before replacing children on redraw', () => {
        const view = makeView({ reminders: [{ id: 'r1', text: 'Ping', triggerAt: 1000, state: 'scheduled' }] });
        views.set('conv-1', view);

        const general = buildGeneral({ conversationId: 'conv-1', nav: { gone: jest.fn(), push: jest.fn(), viewPicture: jest.fn() } });
        const generalCallsBefore = releaseRowIds.mock.calls.length;
        view.name = 'Ada Updated';
        view.kind = 'group';
        emit({ type: 'list', id: 'conv-1' });
        expect(releaseRowIds.mock.calls.length).toBeGreaterThan(generalCallsBefore);
        general.dispose();

        const behaviour = buildBehaviour({ conversationId: 'conv-1', nav: { gone: jest.fn() } });
        const behaviourCallsBefore = releaseRowIds.mock.calls.length;
        view.reminders = [];
        emit({ type: 'list', id: 'conv-1' });
        expect(releaseRowIds.mock.calls.length).toBeGreaterThan(behaviourCallsBefore);
        behaviour.dispose();
    });

    test('window handles async onResponse rejections and rejects unsafe picture URLs', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const pushedPages = [];
        openDialog.mockImplementation(() => {
            const surface = document.createElement('div');
            const body = document.createElement('div');
            const dialog = {
                isOpen: true,
                surface,
                body,
                close: jest.fn(),
                forceClose: jest.fn(),
                setTitle: jest.fn(),
                setSubtitle: jest.fn(),
                closed: new Promise(() => {}),
                push: jest.fn((spec) => {
                    let resolveClosed;
                    const closed = new Promise((resolve) => { resolveClosed = resolve; });
                    const handle = {
                        closed,
                        close: jest.fn(),
                        forceClose: jest.fn(),
                        setResponseEnabled: jest.fn(),
                        setTitle: jest.fn(),
                        resolveClosed,
                    };
                    pushedPages.push({ spec, handle });
                    return handle;
                }),
            };
            return dialog;
        });

        views.set('conv-1', makeView());
        addMembersTo.mockRejectedValueOnce(new Error('network down'));

        await openConversationDetails('conv-1', { page: 'add-member' });
        expect(pushedPages).toHaveLength(1);

        // Unsafe picture URLs are refused cleanly without pushing a page.
        expect(lastWindowNav.viewPicture({ title: 'Bad', src: 'javascript:alert(1)', kind: 'image' })).toBeNull();
        expect(lastWindowNav.viewPicture({ title: 'Bad Video', src: 'data:text/html,<script>alert(1)</script>', kind: 'video' })).toBeNull();
        expect(pushedPages).toHaveLength(1);
        expect(lastWindowNav.viewPicture({ title: 'Good', src: '/characters/ada.png', kind: 'image' })).not.toBeNull();
        expect(pushedPages).toHaveLength(2);

        // Trigger committed response on add-member whose async handler rejects.
        pushedPages[0].handle.resolveClosed({ response: 'add' });
        await flush();
        expect(errorSpy).toHaveBeenCalled();
        expect(globalThis.toastr.error).toHaveBeenCalledWith('This action could not be completed');
    });

    describe('selection mode and the window', () => {
        let pushed;

        async function openWindowOnAddMember() {
            pushed = [];
            openDialog.mockImplementation(() => ({
                isOpen: true,
                surface: document.createElement('div'),
                body: document.createElement('div'),
                close: jest.fn(),
                forceClose: jest.fn(),
                setTitle: jest.fn(),
                setSubtitle: jest.fn(),
                closed: new Promise(() => {}),
                push: jest.fn((spec) => {
                    const handle = { closed: new Promise(() => {}), close: jest.fn(), forceClose: jest.fn(), setResponseEnabled: jest.fn(), setTitle: jest.fn(), page: document.createElement('section'), body: document.createElement('div'), header: document.createElement('header'), headerStart: document.createElement('div'), headerEnd: document.createElement('div'), titleNode: document.createElement('h2'), closeButton: null, search: null };
                    pushed.push({ spec, handle });
                    return handle;
                }),
            }));
            views.set('conv-1', makeView());
            leaveSelection.mockClear();
            await openConversationDetails('conv-1', { page: 'add-member' });
        }

        test('a page pushed over a page leaves that page\'s selection mode first, and so does a picture', async () => {
            await openWindowOnAddMember();
            expect(leaveSelection).not.toHaveBeenCalled();

            lastWindowNav.push('add-member');
            expect(leaveSelection).toHaveBeenCalledTimes(1);

            lastWindowNav.viewPicture({ title: 'Good', src: '/characters/ada.png', kind: 'image' });
            expect(leaveSelection).toHaveBeenCalledTimes(2);
        });

        test('a picture refused for its address leaves selection mode alone', async () => {
            await openWindowOnAddMember();
            lastWindowNav.viewPicture({ title: 'Bad', src: 'javascript:alert(1)', kind: 'image' });
            expect(leaveSelection).not.toHaveBeenCalled();
        });

        test('hands a page its frame for selection mode, with the dialog\'s icon button, and its canClose to the dialog', async () => {
            onMount.mockClear();
            await openWindowOnAddMember();
            const { spec, handle } = pushed[0];
            expect(spec.canClose).toBe(canClose);
            expect(onMount).toHaveBeenCalledTimes(1);
            const [{ frame }] = onMount.mock.calls[0];
            expect(frame).toEqual({
                page: handle.page,
                body: handle.body,
                header: handle.header,
                headerStart: handle.headerStart,
                headerEnd: handle.headerEnd,
                titleNode: handle.titleNode,
                closeButton: null,
                search: null,
                createIconButton: dialogModule.createIconButton,
            });
        });

        test('a picture with onRemove has a menu with Remove From Chat that closes the page once the item is gone, and not before', async () => {
            await openWindowOnAddMember();
            const onRemove = jest.fn(async () => false);
            lastWindowNav.viewPicture({ title: 'Good', src: '/characters/ada.png', kind: 'image', onRemove });
            const { spec, handle } = pushed.at(-1);
            expect(spec.menuLabel).toBe('Picture Menu');
            const [item] = spec.menu().flatMap(section => section.items);
            expect(item).toMatchObject({ label: 'Remove From Chat', danger: true });

            item.onSelect();
            await flush();
            expect(onRemove).toHaveBeenCalledTimes(1);
            expect(handle.close).not.toHaveBeenCalled();

            onRemove.mockResolvedValue(true);
            item.onSelect();
            await flush();
            expect(handle.close).toHaveBeenCalledTimes(1);
        });

        test('a picture without onRemove has no menu, and a video is a Video Menu', async () => {
            await openWindowOnAddMember();
            lastWindowNav.viewPicture({ title: 'Plain', src: '/characters/ada.png', kind: 'image' });
            expect(pushed.at(-1).spec.menu).toBeUndefined();
            lastWindowNav.viewPicture({ title: 'Clip', src: '/u/clip.mp4', kind: 'video', onRemove: async () => true });
            expect(pushed.at(-1).spec.menuLabel).toBe('Video Menu');
        });
    });

    test('avatar-upload accepts extension fallback when file.type is empty and guards zero dimensions and missing 2d context', async () => {
        const origCreateObjectURL = URL.createObjectURL;
        const origRevokeObjectURL = URL.revokeObjectURL;
        URL.createObjectURL = jest.fn(() => 'blob:http://localhost/avatar');
        URL.revokeObjectURL = jest.fn();

        const origImage = globalThis.Image;
        let nextDimensions = { width: 100, height: 100 };
        globalThis.Image = class FakeImage {
            set src(_value) {
                this.naturalWidth = nextDimensions.width;
                this.naturalHeight = nextDimensions.height;
                queueMicrotask(() => this.onload?.());
            }
        };

        const drawImage = jest.fn();
        const getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage });
        const toDataURLSpy = jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');

        try {
            // Extension fallback when MIME type is empty.
            const untypedPng = new File(['x'], 'photo.PNG', { type: '' });
            await expect(toAvatarDataUrl(untypedPng)).resolves.toBe('data:image/png;base64,AAAA');
            expect(drawImage).toHaveBeenCalledTimes(1);

            const untypedSvg = new File(['<svg/>'], 'photo.svg', { type: '' });
            await expect(toAvatarDataUrl(untypedSvg)).rejects.toThrow(/PNG, JPEG, GIF or WebP/);

            // Zero dimensions guard.
            nextDimensions = { width: 0, height: 100 };
            await expect(toAvatarDataUrl(new File(['x'], 'empty.png', { type: 'image/png' }))).rejects.toThrow(/no dimensions/i);

            // Missing 2D context guard.
            nextDimensions = { width: 64, height: 64 };
            getContextSpy.mockReturnValueOnce(null);
            await expect(toAvatarDataUrl(new File(['x'], 'ok.png', { type: 'image/png' }))).rejects.toThrow(/canvas/i);
        } finally {
            globalThis.Image = origImage;
            URL.createObjectURL = origCreateObjectURL;
            URL.revokeObjectURL = origRevokeObjectURL;
            getContextSpy.mockRestore();
            toDataURLSpy.mockRestore();
        }
    });
});
