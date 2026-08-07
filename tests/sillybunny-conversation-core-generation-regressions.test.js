/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const appendConversationMessage = jest.fn();
const addConversationReminder = jest.fn();
const generateConversationImage = jest.fn();
const scheduleTimelineRender = jest.fn();
const updateConversationThreadMessage = jest.fn();
const runtimeStatusOverrides = new Map();
const threadMessages = [{ id: 'user-1', role: 'user', name: 'User', mes: 'hello', extra: {} }];

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [{ avatar: 'char.png', name: 'Aster' }],
    generateRaw: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/llm-utils.js', () => ({
    extractProfileResponseText: value => String(value || ''),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'persona-a.png' : value || ''),
    getCurrentCharAvatar: () => 'char.png',
    getCurrentCharName: () => 'Aster',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    buildCharacterImagePrompt: value => value,
    generateConversationImage,
    getCharacterForAvatar: avatar => ({ avatar, name: avatar === 'char.png' ? 'Aster' : 'Partner' }),
    getCharacterImageDetails: () => '',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/message-writer.js', () => ({ appendConversationMessage }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/partners.js', () => ({
    stripSpeakerPrefix: value => String(value || '').trim(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/partners-utils.js', () => ({
    getSpeakerPrefixMatch: () => null,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({ getConnectionProfiles: () => [] }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/prompt.js', () => ({
    buildConversationPromptMessages: jest.fn(),
    buildConversationSystemPrompt: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({
    formatPromptText: value => String(value || ''),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({ scheduleTimelineRender }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    getConversationReplyMaxTokens: () => 100,
    getConversationRuntimeStatusKey: (avatar, personaId) => `${personaId}\u001f${avatar}`,
    parseDurationToMs: () => 60_000,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ runtimeStatusOverrides }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/thread-store.js', () => ({
    addConversationReminder,
    buildConversationMessageReplyReference: message => message ? { messageId: message.id, name: message.name, role: message.role, text: message.mes } : null,
    getConversationThread: () => threadMessages,
    getImageCooldownRemainingSeconds: () => 0,
    hasConversationMessageContent: message => Boolean(message?.id && message?.mes),
    markImageGenerated: jest.fn(),
    updateConversationThreadMessage,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
    splitChatroomMessages: value => String(value || '').split(/\n\s*\n+/).map(part => part.trim()).filter(Boolean),
    waitForReplyDelay: jest.fn(),
    withTypingParticipant: (_participant, task) => task(),
}));

const {
    editConversationMessage,
    postCharacterReply,
} = await import('../public/scripts/sillybunny-conversation/generation.js');

const settings = {
    image_gen_enabled: false,
    schedule_command_enabled: true,
    selfie_command_enabled: true,
};

describe('Conversation core generated reply regressions', () => {
    beforeEach(() => {
        appendConversationMessage.mockReset().mockImplementation(async (text, options) => ({ id: `message-${appendConversationMessage.mock.calls.length}`, mes: text, ...options }));
        addConversationReminder.mockClear();
        generateConversationImage.mockClear();
        scheduleTimelineRender.mockClear();
        updateConversationThreadMessage.mockClear();
        runtimeStatusOverrides.clear();
        delete globalThis.document;
    });

    test('keeps native selfie command metadata when image generation is disabled', async () => {
        await postCharacterReply('Here you go [selfie: context="at my desk"]', settings, {
            branchId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
        }, 'char.png');

        expect(appendConversationMessage).toHaveBeenCalledTimes(1);
        expect(appendConversationMessage.mock.calls[0][1].extra.conversation_commands).toEqual({
            selfieRequests: ['at my desk'],
        });
        expect(generateConversationImage).not.toHaveBeenCalled();
    });

    test('attaches a reply card only to the first bubble from the same speaker', async () => {
        const replyReference = { messageId: 'user-1', name: 'User', role: 'user', text: 'hello' };
        await postCharacterReply('First bubble\n\nSecond bubble\n\nThird bubble', settings, {
            branchId: 'branch-a',
            extra: { conversation_reply_to: replyReference },
            groupId: '',
            personaId: 'persona-a.png',
        }, 'char.png');

        expect(appendConversationMessage).toHaveBeenCalledTimes(3);
        expect(appendConversationMessage.mock.calls[0][1].extra.conversation_reply_to).toEqual(replyReference);
        expect(appendConversationMessage.mock.calls[1][1].extra.conversation_reply_to).toBeUndefined();
        expect(appendConversationMessage.mock.calls[2][1].extra.conversation_reply_to).toBeUndefined();
    });

    test('does not commit command side effects when final target validation fails', async () => {
        const validateTarget = jest.fn()
            .mockReturnValueOnce(true)
            .mockReturnValueOnce(false);

        await postCharacterReply('Later [schedule_update: status="dnd" activity="working"] [reminder: 15m | check in]', settings, {
            branchId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
            validateTarget,
        }, 'char.png');

        expect(appendConversationMessage).not.toHaveBeenCalled();
        expect(addConversationReminder).not.toHaveBeenCalled();
        expect(runtimeStatusOverrides.size).toBe(0);
    });

    test('commits command side effects to the captured persona after append succeeds', async () => {
        await postCharacterReply('Later [schedule_update: status="dnd" activity="working"] [reminder: 15m | check in]', settings, {
            branchId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
            validateTarget: () => true,
        }, 'char.png');

        expect(runtimeStatusOverrides.get('persona-a.png\u001fchar.png')).toMatchObject({
            activity: 'working',
            status: 'dnd',
        });
        expect(addConversationReminder).toHaveBeenCalledWith('char.png', '', '15m', 'check in', {
            branchId: 'branch-a',
            personaId: 'persona-a.png',
        });
    });

    test('saves only changed content and closes the editor in all cases', () => {
        const textElement = {
            append: jest.fn(),
            querySelector: jest.fn(() => null),
            textContent: 'hello',
        };
        const actionBar = { classList: { remove: jest.fn() } };
        const messageElement = {
            classList: { add: jest.fn(), remove: jest.fn() },
            dataset: {
                messageId: '42',
                sbConversationMessageFingerprint: 'fingerprint',
            },
            querySelector: jest.fn(selector => selector === '.sb-conversation-message-actions' ? actionBar : textElement),
        };
        const createdElements = [];
        globalThis.document = {
            createElement: jest.fn(() => {
                const element = {
                    append: jest.fn(),
                    children: [],
                    classList: { add: jest.fn(), remove: jest.fn() },
                    closest: jest.fn(() => null),
                    dataset: {},
                    focus: jest.fn(),
                    setAttribute: jest.fn(),
                    value: '',
                };
                element.append.mockImplementation((...children) => element.children.push(...children));
                createdElements.push(element);
                return element;
            }),
            querySelectorAll: jest.fn(() => [messageElement]),
        };
        threadMessages.splice(0, threadMessages.length, { id: 42, role: 'user', name: 'User', mes: 'hello', extra: {} });

        editConversationMessage('42');

        const [textarea, buttonContainer] = createdElements;
        const [saveButton, cancelButton] = buttonContainer.children;
        cancelButton.onclick();
        expect(messageElement.dataset.sbConversationMessageFingerprint).toBeUndefined();
        expect(scheduleTimelineRender).toHaveBeenCalledTimes(1);

        messageElement.dataset.sbConversationMessageFingerprint = 'fingerprint';
        saveButton.onclick();
        expect(updateConversationThreadMessage).not.toHaveBeenCalled();
        expect(messageElement.dataset.sbConversationMessageFingerprint).toBeUndefined();
        expect(scheduleTimelineRender).toHaveBeenCalledTimes(2);

        textarea.value = 'updated';
        saveButton.onclick();
        expect(updateConversationThreadMessage).toHaveBeenCalledWith('char.png', 42, 'updated', null, {
            groupId: '',
            personaId: 'persona-a.png',
        });
        expect(scheduleTimelineRender).toHaveBeenCalledTimes(3);
    });

    test('cancels an existing editor before opening another', () => {
        const originalText = { querySelector: jest.fn(() => null) };
        const originalActions = { classList: { remove: jest.fn() } };
        const previousMessageElement = {
            classList: { remove: jest.fn() },
            dataset: { sbConversationMessageFingerprint: 'previous-fingerprint' },
            querySelector: jest.fn(selector => selector === '.sb-conversation-message-actions' ? originalActions : originalText),
        };
        const nextText = {
            append: jest.fn(),
            querySelector: jest.fn(() => null),
            textContent: 'hello',
        };
        const nextActions = { classList: { remove: jest.fn() } };
        const nextMessageElement = {
            classList: { add: jest.fn() },
            dataset: { messageId: '43' },
            querySelector: jest.fn(selector => selector === '.sb-conversation-message-actions' ? nextActions : nextText),
        };
        const activeEditor = { closest: jest.fn(() => previousMessageElement) };
        globalThis.document = {
            createElement: jest.fn(() => ({
                append: jest.fn(),
                classList: { add: jest.fn(), remove: jest.fn() },
                dataset: {},
                focus: jest.fn(),
                setAttribute: jest.fn(),
                value: '',
            })),
            querySelectorAll: jest.fn(selector => selector === '.sb-conversation-message-edit-textarea' ? [activeEditor] : [nextMessageElement]),
        };
        threadMessages.splice(0, threadMessages.length, { id: 43, role: 'user', name: 'User', mes: 'hello', extra: {} });

        editConversationMessage('43');

        expect(previousMessageElement.classList.remove).toHaveBeenCalledWith('is-editing');
        expect(previousMessageElement.dataset.sbConversationMessageFingerprint).toBeUndefined();
        expect(originalActions.classList.remove).toHaveBeenCalledWith('open');
        expect(scheduleTimelineRender).toHaveBeenCalledTimes(1);
    });
});
