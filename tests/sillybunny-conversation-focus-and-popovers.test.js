/** @jest-environment jsdom */
/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

globalThis.CSS ??= { escape: value => String(value).replace(/(["\\])/g, '\\$1') };

let currentMessages = [];
let popoverCall = null;
const openPopover = jest.fn((options) => {
    popoverCall = options;
    return { close: jest.fn(), get isOpen() { return true; } };
});
const openEmojiChooser = jest.fn();

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [{ avatar: 'char.png', name: 'Aster' }],
    default_user_avatar: 'default.png',
    getThumbnailUrl: () => '/thumb.png',
    messageFormatting: value => value,
    name1: 'User',
}));
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), ''),
    translate: value => value,
}));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'persona-a.png' }));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: { persona_description: '' } }));
await jest.unstable_mockModule('../public/scripts/sillybunny-action-menu.js', () => ({
    openPopover,
    openActionMenu: jest.fn(),
    closeActionMenu: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-color-picker.js', () => ({
    COLOR_PICKER_CLOSED_EVENT: 'sb:color-picker-closed',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/dialog.js', () => ({
    openAlert: jest.fn(async () => 'cancel'),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/dialogs.js', () => ({
    confirmConversationAction: jest.fn(async () => false),
    promptConversationText: jest.fn(async () => null),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getActiveConversationChat: () => ({ id: 'chat-1', messages: currentMessages, loaded: true }),
    getConversationChats: () => [{ id: 'chat-1', messages: currentMessages }],
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationKey: () => 'persona-a.png::char.png',
    getConversationPersonaId: () => 'persona-a.png',
    getConversationRecord: () => ({ id: 'conv-1', activeChatId: 'chat-1', chats: [{ id: 'chat-1' }] }),
    getConversationStore: () => ({}),
    getCurrentCharAvatar: () => 'char.png',
    getCurrentCharName: () => 'Aster',
    parsePositiveInt: (v, fallback) => Number.parseInt(v, 10) || fallback,
    persistConversationStore: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({
    conversationData: { get: () => ({ id: 'conv-1', activeChatId: 'chat-1' }) },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({
    commitCharacterReplyCommands: jest.fn(),
    extractCharacterReplyCommands: jest.fn(v => ({ text: v, selfieRequests: [] })),
    generateConversationRaw: jest.fn(),
    generateSelfieFromContext: jest.fn(),
    getCharacterReplyCommandMetadata: () => null,
    reportConversationGenerationError: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterAuthorNote: () => '',
    getCharacterForAvatar: avatar => ({ avatar, name: 'Aster' }),
    getConversationParticipants: () => [],
    getEffectiveConversationStatus: () => 'online',
    getParticipantNamesForDisplay: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list.js', () => ({
    getConversationMessageAvatar: () => '/avatar.png',
    getConversationMessageReceipt: () => '',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/members.js', () => ({
    escapeRegExp: v => v,
    getCharacterMentionHandles: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({
    composeConversationPersonaDescription: () => '',
    getAvailabilityCopy: () => ({ label: 'Online' }),
    getConversationPersonaName: () => 'User',
    getUserPersonaStatus: () => '',
    getUserStatus: () => 'online',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    getCharacterStatus: () => ({ source: 'manual', status: 'online', activity: '' }),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({
    registerConversationRenderer: jest.fn(),
    scheduleInterfaceRefresh: jest.fn(),
    scheduleConversationListRender: jest.fn(),
    scheduleTimelineRender: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getConversationGroupMemorySummaries: () => [],
    getConversationMemorySummary: () => '',
    getConversationSoloMemorySummary: () => null,
    getSettings: () => ({}),
    saveConversationMemorySummary: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    addConversationReminder: jest.fn(),
    appendConversationChatMessage: jest.fn(),
    buildConversationMessageReplyReference: () => null,
    getConversationAttachmentSummary: () => '',
    getConversationFileAttachments: message => (Array.isArray(message?.extra?.files) ? message.extra.files.filter(item => item?.url) : []),
    getConversationMediaAttachments: message => (Array.isArray(message?.extra?.media) ? message.extra.media.filter(item => item?.url) : []),
    getConversationMediaDisplay: () => 'list',
    getConversationMediaIndex: () => 0,
    getConversationMessages: () => currentMessages,
    getConversationPromptMediaAttachments: () => [],
    getConversationSeenAt: () => 0,
    hasConversationMessageContent: () => true,
    saveConversationMessages: jest.fn(),
    updateConversationChatMessageReactions: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
    getActiveTypingParticipants: () => [],
    getPrimaryTypingParticipant: () => null,
    withTypingParticipant: (_p, task) => task(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/world-info.js', () => ({
    getConversationWorldInfo: jest.fn(async () => ({})),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/tts.js', () => ({
    narrateConversationMessage: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/message-menu.js', () => ({
    registerMessageMenuReactions: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/emoji/emoji-chooser.js', () => ({
    openEmojiChooser,
}));

const { renderConversationAttachments } = await import('../public/scripts/sillybunny-conversation/prompt.js');
const { openReactionChooser } = await import('../public/scripts/sillybunny-conversation/reactions-ui.js');
const { renderConversationTimeline } = await import('../public/scripts/sillybunny-conversation/timeline-render.js');
const { conversationState } = await import('../public/scripts/sillybunny-conversation/state.js');
const { openFolderNamePopover } = await import('../public/scripts/sillybunny-editor/folder-popovers.js');

const flush = async () => {
    for (let i = 0; i < 8; i++) {
        await Promise.resolve();
    }
};

describe('prompt renderConversationAttachments URL validation', () => {
    beforeEach(() => {
        document.body.replaceChildren();
    });

    test('blocks javascript:, vbscript:, data:, and control-char URLs on file links while keeping safe URLs and raster image data URIs', () => {
        const container = document.createElement('div');
        renderConversationAttachments(container, {
            extra: {
                media: [
                    { url: 'javascript:alert(1)', type: 'image', title: 'xss-img' },
                    { url: 'data:image/svg+xml;base64,PHN2Zz4=', type: 'image', title: 'svg-img' },
                    { url: 'data:image/png;base64,iVBORw0KGgo=', type: 'image', title: 'inline-png' },
                    { url: 'vbscript:msgbox(1)', type: 'video', title: 'xss-vid' },
                    { url: 'data:audio/mpeg;base64,AAAA', type: 'audio', title: 'data-audio' },
                    { url: '/user/media/clip.mp4', type: 'video', title: 'safe-vid' },
                ],
                files: [
                    { url: 'javascript:alert(2)', name: 'evil.html', size: 12 },
                    { url: '  JaVaScRiPt:alert(3)', name: 'mixed.html', size: 12 },
                    { url: 'java\tscript:alert(4)', name: 'tab.html', size: 12 },
                    { url: 'vbscript:bad', name: 'vbs.txt', size: 12 },
                    { url: 'data:text/html,<script>alert(1)</script>', name: 'data.html', size: 12 },
                    { url: 'data:image/png;base64,iVBORw0KGgo=', name: 'data-file.png', size: 12 },
                    { url: 'https://example.com/report.pdf', name: 'report.pdf', size: 2048 },
                    { url: 'blob:https://example.com/1234', name: 'local.txt', size: 10 },
                    { url: '/files/notes.txt', name: 'notes.txt', size: 100 },
                ],
            },
        });

        const images = [...container.querySelectorAll('img')].map(img => img.getAttribute('src'));
        const videos = [...container.querySelectorAll('video')].map(video => video.getAttribute('src'));
        const audios = [...container.querySelectorAll('audio')].map(audio => audio.getAttribute('src'));
        const links = [...container.querySelectorAll('a')].map(link => link.getAttribute('href'));

        expect(images).toEqual(['data:image/png;base64,iVBORw0KGgo=']);
        expect(videos).toEqual(['/user/media/clip.mp4']);
        expect(audios).toEqual([]);
        expect(links).toEqual([
            'https://example.com/report.pdf',
            'blob:https://example.com/1234',
            '/files/notes.txt',
        ]);
    });

    test('omits the attachments wrapper when all attachment URLs are rejected', () => {
        const container = document.createElement('div');
        renderConversationAttachments(container, {
            extra: {
                files: [{ url: 'javascript:alert(1)', name: 'bad.txt', size: 1 }],
            },
        });
        expect(container.querySelector('.sb-conversation-attachments')).toBeNull();
    });
});

describe('timeline reconciliation focus preservation and More Reactions stability', () => {
    let timeline;

    beforeEach(() => {
        jest.clearAllMocks();
        document.body.replaceChildren();
        timeline = document.createElement('div');
        timeline.id = 'sb_conversation_timeline';
        document.body.append(timeline);
        conversationState.lastTimelineFingerprint = '';
        conversationState.lastRenderedConversationKey = '';
        conversationState.lastRenderedAvatar = null;
        conversationState.lastRenderedMessageCount = 0;
        conversationState.conversationTimelineSearchQuery = '';
        currentMessages = [];
        window.matchMedia = jest.fn(() => ({ matches: false }));
    });

    test('updates reactions in place without detaching the message node or More Reactions trigger, keeping has-open-menu intact', () => {
        currentMessages = [{ id: 'm1', role: 'character', name: 'Aster', mes: 'Hello', created_at: 1000, extra: {} }];
        renderConversationTimeline();

        const originalNode = timeline.querySelector('.sb-conversation-message[data-message-id="m1"]');
        const moreButton = originalNode.querySelector('.sb-conversation-reaction-more');
        originalNode.classList.add('has-open-menu');

        // Simulate Shift+Click adding a reaction in More Reactions.
        currentMessages = [{
            id: 'm1',
            role: 'character',
            name: 'Aster',
            mes: 'Hello',
            created_at: 1000,
            extra: { conversation_reactions: [{ emoji: '🔥', by: 'user', at: 1 }] },
        }];
        renderConversationTimeline();

        expect(timeline.querySelector('.sb-conversation-message[data-message-id="m1"]')).toBe(originalNode);
        expect(moreButton.isConnected).toBe(true);
        expect(originalNode.classList.contains('has-open-menu')).toBe(true);
        expect(originalNode.querySelector('.sb-conversation-message-reaction-chip[data-reaction="🔥"]')).not.toBeNull();
    });

    test('preserves focus on reaction chips across reaction updates and falls back cleanly when the last chip is removed', () => {
        currentMessages = [{
            id: 'm1',
            role: 'character',
            name: 'Aster',
            mes: 'Hello',
            created_at: 1000,
            extra: {
                conversation_reactions: [
                    { emoji: '🔥', by: 'user', at: 1 },
                    { emoji: '👍', by: 'char.png', at: 2 },
                ],
            },
        }];
        renderConversationTimeline();

        const fireChip = timeline.querySelector('.sb-conversation-message-reaction-chip[data-reaction="🔥"]');
        fireChip.focus();
        expect(document.activeElement).toBe(fireChip);

        // User removes 🔥 while 👍 remains: focus falls back to remaining chip 👍.
        currentMessages = [{
            id: 'm1',
            role: 'character',
            name: 'Aster',
            mes: 'Hello',
            created_at: 1000,
            extra: {
                conversation_reactions: [
                    { emoji: '👍', by: 'char.png', at: 2 },
                ],
            },
        }];
        renderConversationTimeline();
        expect(document.activeElement).toBe(timeline.querySelector('.sb-conversation-message-reaction-chip[data-reaction="👍"]'));

        // Removing the last chip falls back to the message menu trigger.
        currentMessages = [{ id: 'm1', role: 'character', name: 'Aster', mes: 'Hello', created_at: 1000, extra: {} }];
        renderConversationTimeline();
        expect(document.activeElement).toBe(timeline.querySelector('.sb-conversation-message-menu'));
    });

    test('preserves has-open-menu and restores focus to action buttons, reaction buttons, and More Reactions on full node replacement', () => {
        currentMessages = [{ id: 'm1', role: 'character', name: 'Aster', mes: 'Before edit', created_at: 1000, extra: {} }];
        renderConversationTimeline();

        const node1 = timeline.querySelector('.sb-conversation-message[data-message-id="m1"]');
        node1.classList.add('has-open-menu');
        const more1 = node1.querySelector('.sb-conversation-reaction-more');
        more1.focus();

        // Changing message text triggers full node replacement.
        currentMessages = [{ id: 'm1', role: 'character', name: 'Aster', mes: 'After edit', created_at: 1000, extra: {} }];
        renderConversationTimeline();

        const node2 = timeline.querySelector('.sb-conversation-message[data-message-id="m1"]');
        expect(node2).not.toBe(node1);
        expect(node2.classList.contains('has-open-menu')).toBe(true);
        expect(document.activeElement).toBe(node2.querySelector('.sb-conversation-reaction-more'));

        // Also test a regular action button (reply-message).
        const reply2 = node2.querySelector('[data-sb-conversation-action="reply-message"]');
        reply2.focus();
        currentMessages = [{ id: 'm1', role: 'character', name: 'Aster', mes: 'Third edit', created_at: 1000, extra: {} }];
        renderConversationTimeline();
        const node3 = timeline.querySelector('.sb-conversation-message[data-message-id="m1"]');
        expect(document.activeElement).toBe(node3.querySelector('[data-sb-conversation-action="reply-message"]'));
    });

    test('openReactionChooser cleans up has-open-menu even if the message node was replaced before close', async () => {
        const message1 = document.createElement('article');
        message1.className = 'sb-conversation-message';
        message1.dataset.messageId = 'm-open';
        const trigger = document.createElement('button');
        message1.append(trigger);
        timeline.append(message1);

        await openReactionChooser('m-open', trigger);
        expect(message1.classList.contains('has-open-menu')).toBe(true);
        expect(openEmojiChooser).toHaveBeenCalledTimes(1);

        // Simulate message replacement that carried has-open-menu onto the replacement node.
        const message2 = document.createElement('article');
        message2.className = 'sb-conversation-message has-open-menu';
        message2.dataset.messageId = 'm-open';
        message1.replaceWith(message2);

        openEmojiChooser.mock.calls[0][0].onClose();
        expect(message1.classList.contains('has-open-menu')).toBe(false);
        expect(message2.classList.contains('has-open-menu')).toBe(false);
    });

    test('openReactionChooser aborts cleanly if trigger is disconnected', async () => {
        const detached = document.createElement('button');
        await openReactionChooser('m-gone', detached);
        expect(openEmojiChooser).not.toHaveBeenCalled();
    });
});

describe('folder-popovers async submit guard', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        popoverCall = null;
        document.body.replaceChildren();
    });

    test('disables both input and submit while async onSubmit runs and restores submit without clearing rejection error', async () => {
        const trigger = document.createElement('button');
        document.body.append(trigger);
        let rejectSubmit;
        const onSubmit = jest.fn(() => new Promise((_resolve, reject) => {
            rejectSubmit = reject;
        }));

        openFolderNamePopover({ trigger, title: 'New Folder', submitLabel: 'Create', onSubmit });
        const input = popoverCall.content.querySelector('input');
        const submit = popoverCall.content.querySelector('button');
        const error = popoverCall.content.querySelector('.sb-manager-name-popover__error');

        input.value = 'Work';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(submit.disabled).toBe(false);

        submit.click();
        expect(input.disabled).toBe(true);
        expect(submit.disabled).toBe(true);

        // Second click while pending must not invoke onSubmit again.
        submit.click();
        expect(onSubmit).toHaveBeenCalledTimes(1);

        rejectSubmit(new Error('Already exists'));
        await flush();

        expect(input.disabled).toBe(false);
        expect(submit.disabled).toBe(false);
        expect(error.hidden).toBe(false);
        expect(error.textContent).toBe('Already exists');
    });
});

describe('sillybunny-conversation.css reduced-motion parity', () => {
    test('body.reduced-motion mirrors all reduced-motion list and typing selectors', () => {
        const css = readFileSync(new URL('../public/css/sillybunny-conversation.css', import.meta.url), 'utf8');
        for (const expected of [
            'body.reduced-motion .sb-conversation-typing-dots span',
            'body.reduced-motion .sb-conversation-list-item[data-unread=\'true\'] .sb-conversation-list-item-unread',
            'body.reduced-motion .sb-conversation-list-row.is-just-moved .sb-conversation-list-item',
            'body.reduced-motion .sb-conversation-list-row.is-lifted .sb-conversation-list-item',
            'body.reduced-motion .sb-conversation-list-section',
            'body.reduced-motion .sb-conversation-list-heading-button > i',
        ]) {
            expect(css).toContain(expected);
        }
    });
});
