/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

let onlineStatus = 'Connected';
let currentAvatar = 'Nova.png';
let currentGroupId = null;
let currentPersonaId = 'persona.png';
let composerHeld = false;
let conversationRecord = { id: 'conv_1', activeChatId: 'main' };

const conversationState = { conversationUploadActive: false };
const sendQueue = [];

const ensureDirectConversation = jest.fn();
const ensureConversationChatLoaded = jest.fn();
const appendConversationChatMessage = jest.fn();
const updateLastUserActivity = jest.fn();
const scheduleInterfaceRefresh = jest.fn();
const handleConversationSlashAction = jest.fn();
const processSendQueue = jest.fn();
const queueForcedConversationReply = jest.fn();
const populateFileAttachment = jest.fn();
const appendFileContent = jest.fn();

await jest.unstable_mockModule('../public/script.js', () => ({
    get is_send_press() {
        return false;
    },
    get online_status() {
        return onlineStatus;
    },
}));
await jest.unstable_mockModule('../public/scripts/constants.js', () => ({
    MEDIA_DISPLAY: { LIST: 'list' },
}));
await jest.unstable_mockModule('../public/scripts/chats.js', () => ({
    populateFileAttachment,
    appendFileContent,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    ensureDirectConversation,
    getConversationGroupIdForAvatar: () => currentGroupId,
    getConversationPersonaId: () => currentPersonaId,
    getConversationKey: (avatar, groupId, { personaId } = {}) => `${personaId}:${groupId || ''}:${avatar}`,
    getConversationRecord: () => conversationRecord,
    getCurrentCharAvatar: () => currentAvatar,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({
    getConversationPersonaName: () => 'You',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/prompt.js', () => ({
    formatConversationFileSize: bytes => `${bytes} B`,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({
    formatPromptText: text => String(text || '').trim(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({
    scheduleInterfaceRefresh,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-utils.js', () => ({
    escapeHtmlText: text => String(text || ''),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/screen-target.js', () => ({
    isComposerHeld: () => composerHeld,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getSettings: () => ({}),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState,
    sendQueue,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-render.js', () => ({
    consumeConversationReplyTarget: () => null,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    appendConversationChatMessage,
    ensureConversationChatLoaded,
    getConversationAttachmentSummary: message => (message?.extra?.file?.name ? `Attached file: ${message.extra.file.name}` : ''),
    getConversationFileAttachments: message => (message?.extra?.file ? [message.extra.file] : []),
    getConversationMediaAttachments: message => (Array.isArray(message?.extra?.media) ? message.extra.media : []),
    getConversationMessages: () => [],
    updateLastUserActivity,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-slash-commands.js', () => ({
    handleConversationSlashAction,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
    splitChatroomMessages: text => [text],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-connection-notices.js', () => ({
    notifyNotConnected: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/send-queue.js', () => ({
    processSendQueue,
    queueForcedConversationReply,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/send-queue-utils.js', () => ({
    createConversationMessageRevisionEntries: messages => messages.map(item => item.id),
    createConversationQueueItem: item => item,
    createConversationQueueReplyTarget: () => null,
}));

const { CHROME_IDS } = await import('../public/scripts/sillybunny-conversation/constants.js');
const {
    buildConversationAttachmentPromptContext,
    populateConversationUserAttachments,
    submitConversationInput,
} = await import('../public/scripts/sillybunny-conversation/attachments.js');

let input;
let sendButton;
let fileInput;

function attachFiles(files) {
    Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: files,
    });
}

beforeEach(() => {
    document.body.innerHTML = `
        <textarea id="${CHROME_IDS.input}"></textarea>
        <button id="${CHROME_IDS.send}" type="button">Send</button>
        <input id="${CHROME_IDS.fileInput}" type="file" />
        <div id="${CHROME_IDS.attachmentPreview}"></div>
    `;
    input = document.getElementById(CHROME_IDS.input);
    sendButton = document.getElementById(CHROME_IDS.send);
    fileInput = document.getElementById(CHROME_IDS.fileInput);

    onlineStatus = 'Connected';
    currentAvatar = 'Nova.png';
    currentGroupId = null;
    currentPersonaId = 'persona.png';
    composerHeld = false;
    conversationRecord = { id: 'conv_1', activeChatId: 'main' };
    conversationState.conversationUploadActive = false;
    sendQueue.length = 0;

    jest.clearAllMocks();
    ensureDirectConversation.mockResolvedValue({ id: 'conv_1', activeChatId: 'main' });
    ensureConversationChatLoaded.mockResolvedValue({ conversationId: 'conv_1', chatId: 'main' });
    appendConversationChatMessage.mockImplementation((_avatar, message) => ({ id: 'msg-1', ...message }));
    handleConversationSlashAction.mockResolvedValue(false);
});

describe('submitConversationInput concurrency and draft safety', () => {
    test('guards the entire async submission flow before ensureDirectConversation and ensureConversationChatLoaded', async () => {
        conversationRecord = null;
        let releaseCreate;
        ensureDirectConversation.mockReturnValueOnce(new Promise((resolve) => {
            releaseCreate = resolve;
        }));
        input.value = 'Hello Nova';

        const first = submitConversationInput();
        expect(conversationState.conversationUploadActive).toBe(true);
        expect(sendButton.disabled).toBe(true);

        // A second submit while conversation creation is awaiting is ignored.
        await submitConversationInput();
        expect(ensureDirectConversation).toHaveBeenCalledTimes(1);

        releaseCreate({ id: 'conv_new', activeChatId: 'main' });
        await first;

        expect(conversationState.conversationUploadActive).toBe(false);
        expect(appendConversationChatMessage).toHaveBeenCalledTimes(1);
        expect(input.value).toBe('');
    });

    test('resets conversationUploadActive on early returns, load failure, forced reply, and slash commands', async () => {
        // Load failure.
        ensureConversationChatLoaded.mockResolvedValueOnce(null);
        input.value = 'Hello';
        await submitConversationInput();
        expect(conversationState.conversationUploadActive).toBe(false);

        // Empty-input forced reply.
        input.value = '';
        await submitConversationInput();
        expect(queueForcedConversationReply).toHaveBeenCalledTimes(1);
        expect(conversationState.conversationUploadActive).toBe(false);

        // Handled slash command.
        handleConversationSlashAction.mockResolvedValueOnce(true);
        input.value = '/remind 10m tea';
        await submitConversationInput();
        expect(conversationState.conversationUploadActive).toBe(false);
        expect(input.value).toBe('');
    });

    test('does not wipe another conversation draft when the user switches conversations mid-await', async () => {
        let releaseLoad;
        ensureConversationChatLoaded.mockReturnValueOnce(new Promise((resolve) => {
            releaseLoad = resolve;
        }));
        input.value = 'Message for Nova';

        const pending = submitConversationInput();
        // Switch active conversation while chat loading is awaiting.
        currentAvatar = 'Orion.png';
        input.value = 'Draft for Orion';
        releaseLoad({ conversationId: 'conv_1', chatId: 'main' });
        await pending;

        expect(appendConversationChatMessage).toHaveBeenCalledWith('Nova.png', expect.objectContaining({ mes: 'Message for Nova' }), expect.any(Object));
        expect(input.value).toBe('Draft for Orion');
    });

    test('does not wipe another conversation draft when switching during a handled slash command', async () => {
        let releaseSlash;
        handleConversationSlashAction.mockReturnValueOnce(new Promise((resolve) => {
            releaseSlash = resolve;
        }));
        input.value = '/remind 15m check';

        const pending = submitConversationInput();
        currentPersonaId = 'other-persona.png';
        input.value = 'Draft on other persona';
        releaseSlash(true);
        await pending;

        expect(input.value).toBe('Draft on other persona');
    });

    test('loads populateFileAttachment and appendFileContent from ../chats.js', async () => {
        const note = { name: 'notes.txt', type: 'text/plain', size: 12 };
        attachFiles([note]);
        populateFileAttachment.mockImplementationOnce(async (messageInput) => {
            messageInput.extra.file = { name: 'notes.txt' };
            messageInput.extra.media = [{ url: '/img.png' }];
        });
        appendFileContent.mockResolvedValueOnce('Contents of notes.txt');

        const messageInput = { role: 'user', name: 'You', mes: '', extra: {} };
        await populateConversationUserAttachments(messageInput);
        expect(populateFileAttachment).toHaveBeenCalledWith(messageInput, CHROME_IDS.fileInput);
        expect(messageInput.extra.media_display).toBe('list');
        expect(messageInput.extra.inline_image).toBe(true);

        const promptContext = await buildConversationAttachmentPromptContext(messageInput, '');
        expect(appendFileContent).toHaveBeenCalledTimes(1);
        expect(promptContext).toContain('Attached file: notes.txt');
        expect(promptContext).toContain('Attached file text: Contents of notes.txt');
    });
});
