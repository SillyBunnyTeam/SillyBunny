/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const appendConversationMessage = jest.fn();
const addConversationReminder = jest.fn();
const generateConversationImage = jest.fn();
const updateConversationChatMessage = jest.fn();
const updateConversationChatMessageReactions = jest.fn();
const waitForReplyDelay = jest.fn();
const ensureConversationChatLoaded = jest.fn(async () => ({ conversationId: 'conv_1_direct', chatId: 'main' }));
const loadRelatedMemoryChats = jest.fn(async () => {});
const runtimeStatusOverrides = new Map();
const chatMessages = [{ id: 'user-1', role: 'user', name: 'User', mes: 'hello', extra: {} }];
const generateRaw = jest.fn();
const buildConversationPromptMessages = jest.fn(async () => [{ role: 'user', content: 'Conversation transcript:' }]);
const buildConversationSystemPrompt = jest.fn(() => 'system prompt');
const worldInfo = { before: 'Lore before.', after: '', authorsNoteBefore: '', authorsNoteAfter: '', depth: [] };
const getConversationWorldInfo = jest.fn(async () => worldInfo);
const getActiveApiResponseLength = jest.fn(async responseLength => responseLength);
const getProfileResponseLength = jest.fn(async () => 700);
const getConnectionProfiles = jest.fn(() => []);
const registerGenerationCommitPlan = jest.fn();
const settleGenerationCommit = jest.fn(async () => null);
const missingReplyListeners = new Set();
const onServerOwnedReplyMissing = jest.fn((listener) => {
    missingReplyListeners.add(listener);
    return () => missingReplyListeners.delete(listener);
});
let currentMainApi = 'openai';

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [{ avatar: 'char.png', name: 'Aster' }],
    generateRaw,
    main_api: currentMainApi,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/response-length.js', () => ({ getActiveApiResponseLength, getProfileResponseLength }));
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
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/members.js', () => ({
    stripSpeakerPrefix: value => String(value || '').trim(),
}));
const confirmConversationAction = jest.fn(async () => true);
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/dialogs.js', () => ({ confirmConversationAction }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({ getConnectionProfiles }));
await jest.unstable_mockModule('../public/scripts/resumable-generation.js', () => ({ onServerOwnedReplyMissing, registerGenerationCommitPlan, settleGenerationCommit }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/prompt.js', () => ({
    buildConversationPromptMessages,
    buildConversationSystemPrompt,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/members-utils.js', () => ({
    getSpeakerPrefixMatch: () => null,
    stripSpeakerPrefixText: value => String(value || '').trim(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({
    formatPromptText: value => String(value || ''),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    getConversationRuntimeStatusKey: (avatar, personaId) => `${personaId}\u001f${avatar}`,
    parseDurationToMs: () => 60_000,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ runtimeStatusOverrides }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({ loadRelatedMemoryChats }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    addConversationReminder,
    buildConversationMessageReplyReference: message => message ? { messageId: message.id, name: message.name, role: message.role, text: message.mes } : null,
    ensureConversationChatLoaded,
    getConversationMessages: () => chatMessages,
    getImageCooldownRemainingSeconds: () => 0,
    hasConversationMessageContent: message => Boolean(message?.id && message?.mes),
    markImageGenerated: jest.fn(),
    updateConversationChatMessage,
    updateConversationChatMessageReactions,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
    splitChatroomMessages: value => String(value || '').split(/\n\s*\n+/).map(part => part.trim()).filter(Boolean),
    waitForReplyDelay,
    withTypingParticipant: (_participant, task) => task(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/world-info.js', () => ({ getConversationWorldInfo }));

const {
    editConversationMessage,
    commitCharacterReplyCommands,
    generateConversationRaw,
    generateConversationReply,
    generateSelfieFromContext,
    getConversationErrorDetail,
    postCharacterReply,
    postMemberConversationReply,
} = await import('../public/scripts/sillybunny-conversation/generation.js');
const { generationTargets } = await import('../public/scripts/sillybunny-conversation/deletion-guards.js');

const settings = {
    image_gen_enabled: false,
    schedule_command_enabled: true,
    selfie_command_enabled: true,
};

describe('Conversation error detail', () => {
    test('shows the provider sentence of a failure thrown as a raw JSON body', () => {
        const error = new Error('{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}');
        expect(getConversationErrorDetail(error)).toBe('Incorrect API key provided');
    });

    test('reads the text of an error body thrown as an object', () => {
        expect(getConversationErrorDetail({ error: true, status: 429, response: '{"error":{"message":"Slow down"}}' })).toBe('Slow down');
    });

    test('keeps ordinary messages as they are', () => {
        expect(getConversationErrorDetail(new Error('Got response status 502'))).toBe('Got response status 502');
        expect(getConversationErrorDetail('plain')).toBe('plain');
    });
});

describe('Conversation core generated reply regressions', () => {
    beforeEach(() => {
        appendConversationMessage.mockReset().mockImplementation(async (text, options) => ({ id: `message-${appendConversationMessage.mock.calls.length}`, mes: text, ...options }));
        addConversationReminder.mockClear();
        generateConversationImage.mockClear();
        updateConversationChatMessage.mockClear();
        updateConversationChatMessageReactions.mockReset();
        waitForReplyDelay.mockReset();
        runtimeStatusOverrides.clear();
        generateRaw.mockReset();
        getConnectionProfiles.mockReset().mockReturnValue([]);
        registerGenerationCommitPlan.mockClear();
        settleGenerationCommit.mockReset().mockResolvedValue(null);
        onServerOwnedReplyMissing.mockClear();
        missingReplyListeners.clear();
        currentMainApi = 'openai';
        getActiveApiResponseLength.mockClear();
        buildConversationPromptMessages.mockClear();
        buildConversationSystemPrompt.mockClear();
        getConversationWorldInfo.mockClear();
        delete globalThis.document;
        confirmConversationAction.mockReset();
        confirmConversationAction.mockImplementation(async () => true);
        delete globalThis.window;
    });

    test('scans lorebooks for the speaker and gives the entries to both prompt builders', async () => {
        globalThis.window = {};
        generateRaw.mockResolvedValueOnce('reply');

        await expect(generateConversationReply('Reply now.', settings, {
            avatar: 'char.png',
            chatId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
            speakerAvatar: 'partner.png',
            speakerName: 'Partner',
        })).resolves.toBe('reply');

        expect(getConversationWorldInfo).toHaveBeenCalledWith(chatMessages, settings, { avatar: 'partner.png', personaId: 'persona-a.png' });
        expect(buildConversationPromptMessages).toHaveBeenCalledWith(chatMessages, 'Reply now.', 'Partner', { groupId: '', personaId: 'persona-a.png', worldInfo });
        expect(buildConversationSystemPrompt).toHaveBeenCalledWith(settings, 'partner.png', { anchorAvatar: 'char.png', chatId: 'branch-a', groupId: '', personaId: 'persona-a.png', worldInfo });
        expect(getActiveApiResponseLength).toHaveBeenCalledWith(undefined);
        expect(generateRaw).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: 'system prompt', responseLength: undefined }));
    });

    test('loads the chat that the transcript is read from, and the chats of related memories only when the setting asks for them', async () => {
        globalThis.window = {};
        generateRaw.mockResolvedValue('reply');
        ensureConversationChatLoaded.mockClear();
        loadRelatedMemoryChats.mockClear();

        await generateConversationReply('Reply now.', settings, { avatar: 'char.png', chatId: 'branch-a', groupId: '', personaId: 'persona-a.png' });

        expect(ensureConversationChatLoaded).toHaveBeenCalledWith('char.png', { chatId: 'branch-a', groupId: '', personaId: 'persona-a.png' });
        expect(loadRelatedMemoryChats).not.toHaveBeenCalled();

        await generateConversationReply('Reply now.', { ...settings, include_related_memory: true }, { avatar: 'char.png', speakerAvatar: 'partner.png', groupId: 'conv_2_group', personaId: 'persona-a.png' });

        expect(loadRelatedMemoryChats).toHaveBeenCalledWith('partner.png', { groupId: 'conv_2_group', personaId: 'persona-a.png' });
    });

    test('answers nothing for a reply whose conversation was deleted while the model worked, and hands the model a signal to stop', async () => {
        globalThis.window = {};
        let signal;
        generateRaw.mockImplementationOnce(async (options) => {
            signal = options.signal;
            generationTargets.cancel({ conversationId: 'conv_1_direct' });
            return 'a reply for a conversation that is gone';
        });

        await expect(generateConversationReply('Reply now.', settings, { avatar: 'char.png', chatId: 'main', groupId: '', personaId: 'persona-a.png' })).resolves.toBe('');

        expect(signal.aborted).toBe(true);
        expect(generationTargets.size).toBe(0);
    });

    test('answers nothing, and reports no error, when the request fails because its chat was deleted', async () => {
        globalThis.window = {};
        generateRaw.mockImplementationOnce(async () => {
            generationTargets.cancel({ conversationId: 'conv_1_direct', chatId: 'main' });
            throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
        });

        await expect(generateConversationReply('Reply now.', settings, { avatar: 'char.png', chatId: 'main', groupId: '', personaId: 'persona-a.png' })).resolves.toBe('');
    });

    test('still raises the error of a request that failed for another reason', async () => {
        globalThis.window = {};
        generateRaw.mockRejectedValueOnce(new Error('The model is down.'));

        await expect(generateConversationReply('Reply now.', settings, { avatar: 'char.png', chatId: 'main', groupId: '', personaId: 'persona-a.png' })).rejects.toThrow('The model is down.');
        expect(generationTargets.size).toBe(0);
    });

    test('asks the active API for the response length that it can serve', async () => {
        globalThis.window = {};
        generateRaw.mockResolvedValueOnce('reply');
        getActiveApiResponseLength.mockResolvedValueOnce(64);

        await expect(generateConversationReply('Reply now.', settings, { avatar: 'char.png', groupId: '', personaId: 'persona-a.png' })).resolves.toBe('reply');

        expect(getActiveApiResponseLength).toHaveBeenCalledWith(undefined);
        expect(generateRaw).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: 'system prompt', responseLength: 64 }));
    });

    test('keeps native selfie command metadata when image generation is disabled', async () => {
        await postCharacterReply('Here you go [selfie: context="at my desk"]', settings, {
            chatId: 'branch-a',
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
            chatId: 'branch-a',
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
            chatId: 'branch-a',
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
            chatId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
            validateTarget: () => true,
        }, 'char.png');

        expect(runtimeStatusOverrides.get('persona-a.png\u001fchar.png')).toMatchObject({
            activity: 'working',
            status: 'dnd',
        });
        expect(addConversationReminder).toHaveBeenCalledWith('char.png', '', '15m', 'check in', {
            chatId: 'branch-a',
            personaId: 'persona-a.png',
        });
    });

    describe('the reaction of a character to the message that it answers', () => {
        const reactingSettings = { ...settings, characters_react: true };
        const reactionTarget = { messageId: 'user-1' };
        const scope = { chatId: 'branch-a', groupId: '', personaId: 'persona-a.png' };
        /** The entries that the store would write for the call, when the message held `entries`. */
        const writtenBy = (callIndex, entries = []) => updateConversationChatMessageReactions.mock.calls[callIndex][2](entries);

        test('is written to the message that the reply answers, with the speaker as its reactor', async () => {
            await postCharacterReply('haha [react: 😂] that is great', reactingSettings, { ...scope, reactionTarget }, 'char.png');

            expect(updateConversationChatMessageReactions).toHaveBeenCalledTimes(1);
            expect(updateConversationChatMessageReactions.mock.calls[0].slice(0, 2)).toEqual(['char.png', 'user-1']);
            expect(updateConversationChatMessageReactions.mock.calls[0][3]).toEqual(scope);
            expect(writtenBy(0)).toEqual([{ emoji: '😂', by: 'char.png', at: expect.any(Number) }]);
            expect(appendConversationMessage.mock.calls.map(call => call[0])).toEqual(['haha that is great']);
        });

        test('comes before the typing delay of the first bubble, so that the user sees the reaction, the dots and then the text', async () => {
            await postCharacterReply('[react: 👍] sounds good', reactingSettings, { ...scope, reactionTarget }, 'char.png');

            const reacted = updateConversationChatMessageReactions.mock.invocationCallOrder[0];
            expect(reacted).toBeLessThan(waitForReplyDelay.mock.invocationCallOrder[0]);
            expect(reacted).toBeLessThan(appendConversationMessage.mock.invocationCallOrder[0]);
        });

        test('is all that a reply of only the marker does: it posts no bubble', async () => {
            const posted = await postCharacterReply('[react: 🎉]', reactingSettings, { ...scope, reactionTarget }, 'char.png');

            expect(updateConversationChatMessageReactions).toHaveBeenCalledTimes(1);
            expect(appendConversationMessage).not.toHaveBeenCalled();
            expect(posted).toBe('');
        });

        test('is taken out of the text and not written when characters may not react', async () => {
            await postCharacterReply('haha [react: 😂]', { ...settings, characters_react: false }, { ...scope, reactionTarget }, 'char.png');
            await postCharacterReply('haha [react: 😂]', settings, { ...scope, reactionTarget }, 'char.png');

            expect(updateConversationChatMessageReactions).not.toHaveBeenCalled();
            expect(appendConversationMessage.mock.calls.map(call => call[0])).toEqual(['haha', 'haha']);
        });

        test('is not written for a message that answers no message of the user, such as an automatic one', async () => {
            await postCharacterReply('thinking of you [react: ❤️]', reactingSettings, { ...scope }, 'char.png');

            expect(updateConversationChatMessageReactions).not.toHaveBeenCalled();
            expect(appendConversationMessage).toHaveBeenCalledTimes(1);
        });

        test('is not written when the reply is no longer wanted', async () => {
            await postCharacterReply('haha [react: 😂]', reactingSettings, { ...scope, reactionTarget, validateTarget: () => false }, 'char.png');

            expect(updateConversationChatMessageReactions).not.toHaveBeenCalled();
            expect(appendConversationMessage).not.toHaveBeenCalled();
        });

        test('is written once for a speaker that answers in several bubbles with several markers', async () => {
            await postCharacterReply('one [react: 😂]\n\ntwo [react: 👍]', reactingSettings, { ...scope, reactionTarget }, 'char.png');

            expect(updateConversationChatMessageReactions).toHaveBeenCalledTimes(1);
            expect(writtenBy(0)[0].emoji).toBe('😂');
        });

        test('leaves the message as it was when the character reacted to it already', async () => {
            await postCharacterReply('again [react: 👍]', reactingSettings, { ...scope, reactionTarget }, 'char.png');

            const held = [{ emoji: '😂', by: 'char.png', at: 5 }];
            expect(writtenBy(0, held)).toBe(held);
        });

        test('belongs to the member that wrote the reply, when a member answers', async () => {
            await postMemberConversationReply('lol [react: 😂]', { avatar: 'partner.png', name: 'Partner' }, reactingSettings, { avatar: 'char.png', ...scope, reactionTarget });

            expect(updateConversationChatMessageReactions.mock.calls[0].slice(0, 2)).toEqual(['char.png', 'user-1']);
            expect(writtenBy(0)).toEqual([{ emoji: '😂', by: 'partner.png', at: expect.any(Number) }]);
        });
    });

    describe('the marker of a round', () => {
        const roundMarker = { remaining: ['partner.png'], started: 1234, triggers: ['user-1'] };
        const markers = () => appendConversationMessage.mock.calls.map(call => call[1].extra.conversation_round);

        test('goes on the last bubble of a reply of the character, and on no other', async () => {
            await postCharacterReply('One\n\nTwo\n\nThree', settings, { chatId: 'branch-a', groupId: '', personaId: 'persona-a.png', roundMarker }, 'char.png');

            expect(markers()).toEqual([undefined, undefined, roundMarker]);
        });

        test('goes on the last bubble of a reply of a member, even when the lines are bubbles of their own', async () => {
            await postMemberConversationReply('One\nTwo', { avatar: 'partner.png', name: 'Partner' }, settings, { avatar: 'char.png', chatId: 'branch-a', groupId: '', personaId: 'persona-a.png', roundMarker });

            expect(markers()).toEqual([undefined, roundMarker]);
        });

        test('is not written for a reply that ends its round', async () => {
            await postCharacterReply('One\n\nTwo', settings, { chatId: 'branch-a', groupId: '', personaId: 'persona-a.png', roundMarker: null }, 'char.png');

            expect(markers()).toEqual([undefined, undefined]);
        });

        test('stays on the last bubble of text when a picture follows it', async () => {
            await postCharacterReply('One\n\nTwo [selfie: context="beach"]', settings, { chatId: 'branch-a', groupId: '', personaId: 'persona-a.png', roundMarker }, 'char.png');

            expect(markers().filter(Boolean)).toEqual([roundMarker]);
            expect(appendConversationMessage.mock.calls.findIndex(call => call[1].extra.conversation_round)).toBe(1);
        });
    });

    test('derives the ids of the reminders of a reply from an id that the caller gives, so that two pages that land the reply add each once', () => {
        commitCharacterReplyCommands({ scheduleUpdates: [], reminders: [{ delay: '15m', memo: 'tea' }, { delay: '1h', memo: 'call' }] }, 'char.png', {
            chatId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
            reminderIdPrefix: 'rem_p_g0',
        });

        expect(addConversationReminder.mock.calls).toEqual([
            ['char.png', '', '15m', 'tea', { chatId: 'branch-a', personaId: 'persona-a.png', id: 'rem_p_g0_0' }],
            ['char.png', '', '1h', 'call', { chatId: 'branch-a', personaId: 'persona-a.png', id: 'rem_p_g0_1' }],
        ]);
    });

    test('gives the picture message of a selfie the id that the caller names, and makes no picture when that message is in the chat already', async () => {
        generateConversationImage.mockResolvedValue('/img/beach.png');
        const options = { anchorAvatar: 'char.png', chatId: 'branch-a', groupId: '', personaId: 'persona-a.png', force: true, messageId: 'pending.s0', name: 'Aster' };

        await expect(generateSelfieFromContext('beach', settings, 'char.png', options)).resolves.toBe(true);

        expect(appendConversationMessage.mock.calls.at(-1)[1]).toMatchObject({ id: 'pending.s0', extra: { conversation_mode_image: true, image_url: '/img/beach.png' } });

        generateConversationImage.mockClear();
        chatMessages.push({ id: 'pending.s0', role: 'character', name: 'Aster', mes: 'Here', extra: {} });
        await expect(generateSelfieFromContext('beach', settings, 'char.png', options)).resolves.toBe(false);

        expect(generateConversationImage).not.toHaveBeenCalled();
        chatMessages.pop();
    });

    describe('a reply that carries a commit plan', () => {
        const PROFILE = { name: 'Fast', id: 'profile-1' };
        const profileSettings = { connection_profile: 'Fast' };
        const handle = () => ({ createPlan: jest.fn(route => ({ route })), state: null });
        const sendRequest = jest.fn();

        beforeEach(() => {
            sendRequest.mockReset().mockResolvedValue('profile reply');
            getProfileResponseLength.mockClear();
            getConnectionProfiles.mockReturnValue([PROFILE]);
            globalThis.window = { SillyTavern: { getContext: () => ({ ConnectionManagerRequestService: { sendRequest } }) } };
        });

        test('asks for the length of the preset of the profile when the request names none, and keeps a length that it names', async () => {
            await generateConversationRaw({ prompt: 'p', signal: new AbortController().signal }, profileSettings);
            await generateConversationRaw({ prompt: 'p', responseLength: 50, signal: new AbortController().signal }, profileSettings);

            expect(getProfileResponseLength).toHaveBeenCalledTimes(1);
            expect(getProfileResponseLength).toHaveBeenCalledWith(PROFILE);
            expect(sendRequest.mock.calls.map(call => call[2])).toEqual([700, 50]);
        });

        test('registers the plan of the profile route on the signal of the caller before the request, and keeps what the claim answered', async () => {
            const commit = handle();
            const signal = new AbortController().signal;
            const order = [];
            registerGenerationCommitPlan.mockImplementation(() => order.push('register'));
            sendRequest.mockImplementation(async () => {
                order.push('request');
                return 'profile reply';
            });
            settleGenerationCommit.mockImplementation(async () => {
                order.push('settle');
                return 'committed';
            });

            await expect(generateConversationRaw({ prompt: 'p', systemPrompt: 's', responseLength: 50, signal, commit }, profileSettings)).resolves.toBe('profile reply');

            expect(registerGenerationCommitPlan).toHaveBeenCalledWith(signal, { route: 'profile' });
            expect(commit.createPlan).toHaveBeenCalledTimes(1);
            expect(settleGenerationCommit).toHaveBeenCalledWith(signal);
            expect(order).toEqual(['register', 'request', 'settle']);
            expect(commit.state).toBe('committed');
            expect(generateRaw).not.toHaveBeenCalled();
        });

        test('sends a new plan with the same handle when the profile fails and the active API takes over, and reports the state of that request', async () => {
            const commit = handle();
            sendRequest.mockRejectedValue(new Error('the profile is down'));
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            generateRaw.mockImplementation(async (options) => {
                options.commit.state = 'claimed';
                return 'raw reply';
            });

            await expect(generateConversationRaw({ prompt: 'p', responseLength: 50, signal: new AbortController().signal, commit }, profileSettings)).resolves.toBe('raw reply');

            expect(commit.createPlan.mock.calls.map(([route]) => route)).toEqual(['profile', 'raw']);
            expect(generateRaw.mock.calls[0][0].commit).toEqual({ plan: { route: 'raw' }, state: 'claimed' });
            expect(commit.state).toBe('claimed');
            expect(settleGenerationCommit).not.toHaveBeenCalled();
            warn.mockRestore();
        });

        test('does not fall back when the request was stopped, and keeps no state', async () => {
            const commit = handle();
            const controller = new AbortController();
            sendRequest.mockImplementation(async () => {
                controller.abort();
                throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            });

            await expect(generateConversationRaw({ prompt: 'p', responseLength: 50, signal: controller.signal, commit }, profileSettings)).rejects.toThrow('aborted');

            expect(generateRaw).not.toHaveBeenCalled();
            expect(commit.state).toBeNull();
        });

        test('hands the plan of the raw route to generateRaw when no profile is configured, and reports the state', async () => {
            const commit = handle();
            generateRaw.mockImplementation(async (options) => {
                options.commit.state = 'committed';
                return 'raw reply';
            });

            await generateConversationRaw({ prompt: 'p', responseLength: 50, signal: new AbortController().signal, commit }, { connection_profile: '' });

            expect(sendRequest).not.toHaveBeenCalled();
            expect(commit.createPlan.mock.calls).toEqual([['raw']]);
            expect(commit.state).toBe('committed');
        });

        test('sends no plan, registers nothing and asks for no state when the caller gives no handle', async () => {
            await generateConversationRaw({ prompt: 'p', responseLength: 50, signal: new AbortController().signal }, profileSettings);
            sendRequest.mockRejectedValue(new Error('down'));
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            await generateConversationRaw({ prompt: 'p', responseLength: 50, signal: new AbortController().signal }, profileSettings);

            expect(registerGenerationCommitPlan).not.toHaveBeenCalled();
            expect(settleGenerationCommit).not.toHaveBeenCalled();
            expect(generateRaw.mock.calls[0][0].commit).toBeNull();
            warn.mockRestore();
        });

        test('is asked for by generateConversationReply, which passes the handle of its caller down to the request', async () => {
            const commit = handle();
            generateRaw.mockResolvedValue('reply');

            await generateConversationReply('Reply now.', { connection_profile: '' }, { avatar: 'char.png', chatId: 'main', groupId: '', personaId: 'persona-a.png', commit });

            expect(commit.createPlan).toHaveBeenCalledWith('raw');
            expect(generateRaw.mock.calls[0][0].commit.plan).toEqual({ route: 'raw' });
        });

        test('does not fall back to generateRaw when a scoped profile reply goes missing on the server, and marks the error and commit state', async () => {
            const commit = handle();
            let registeredPlan = null;
            registerGenerationCommitPlan.mockImplementation((_signal, plan) => {
                registeredPlan = plan;
            });
            sendRequest.mockImplementation(async () => {
                for (const listener of [...missingReplyListeners]) {
                    listener(registeredPlan);
                }
                throw new TypeError('Load failed');
            });

            await expect(generateConversationRaw({ prompt: 'p', responseLength: 50, signal: new AbortController().signal, commit }, profileSettings))
                .rejects.toMatchObject({ message: 'Load failed', serverOwnedReplyMissing: true });

            expect(generateRaw).not.toHaveBeenCalled();
            expect(commit.state).toBe('missing');
            expect(missingReplyListeners.size).toBe(0);
        });

        test('marks the error and commit state when an active-profile server-owned reply goes missing', async () => {
            const commit = handle();
            generateRaw.mockImplementation(async (options) => {
                for (const listener of [...missingReplyListeners]) {
                    listener(options.commit.plan);
                }
                throw new TypeError('Load failed');
            });

            await expect(generateConversationRaw({ prompt: 'p', responseLength: 50, signal: new AbortController().signal, commit }, { connection_profile: '' }))
                .rejects.toMatchObject({ message: 'Load failed', serverOwnedReplyMissing: true });

            expect(commit.state).toBe('missing');
            expect(missingReplyListeners.size).toBe(0);
        });

        test('still falls back to generateRaw when a missing-reply notification was for an unrelated plan', async () => {
            const commit = handle();
            sendRequest.mockImplementation(async () => {
                for (const listener of [...missingReplyListeners]) {
                    listener({ route: 'other-plan' });
                }
                throw new Error('transient profile error');
            });
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            generateRaw.mockImplementation(async (options) => {
                options.commit.state = 'claimed';
                return 'fallback reply';
            });

            await expect(generateConversationRaw({ prompt: 'p', responseLength: 50, signal: new AbortController().signal, commit }, profileSettings))
                .resolves.toBe('fallback reply');

            expect(generateRaw).toHaveBeenCalledTimes(1);
            expect(commit.state).toBe('claimed');
            warn.mockRestore();
        });

        test('skips attaching a commit plan on generateRaw when main_api is koboldhorde', async () => {
            currentMainApi = 'koboldhorde';
            jest.resetModules();
            const { generateConversationRaw: generateForHorde } = await import('../public/scripts/sillybunny-conversation/generation.js');
            const commit = handle();
            generateRaw.mockResolvedValue('horde reply');

            await expect(generateForHorde({ prompt: 'p', responseLength: 50, signal: new AbortController().signal, commit }, { connection_profile: '' }))
                .resolves.toBe('horde reply');

            expect(commit.createPlan).not.toHaveBeenCalled();
            expect(generateRaw.mock.calls[0][0].commit).toBeNull();
            expect(commit.state).toBeNull();
        });
    });

    test('saves only changed content and closes the editor in all cases', async () => {
        const originalTextElement = {};
        const textElement = {
            append: jest.fn(),
            cloneNode: jest.fn(() => originalTextElement),
            isConnected: true,
            querySelector: jest.fn(() => null),
            replaceWith: jest.fn(),
            textContent: 'hello',
        };
        const actionBar = { classList: { remove: jest.fn() } };
        const messageElement = {
            classList: { add: jest.fn(), remove: jest.fn() },
            dataset: {
                messageId: '42',
                sbConversationMessageFingerprint: 'fingerprint',
            },
            querySelector: jest.fn(selector => selector === '.sb-conversation-mobile-menu-trigger' ? null : selector === '.sb-conversation-message-actions' ? actionBar : textElement),
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
        chatMessages.splice(0, chatMessages.length, { id: 42, role: 'user', name: 'User', mes: 'hello', extra: {} });

        await editConversationMessage('42');

        const [textarea, buttonContainer] = createdElements;
        const [saveButton, cancelButton] = buttonContainer.children;
        cancelButton.onclick();
        expect(textElement.replaceWith).toHaveBeenCalledWith(originalTextElement);
        expect(messageElement.classList.remove).toHaveBeenCalledWith('is-editing');

        saveButton.onclick();
        expect(updateConversationChatMessage).not.toHaveBeenCalled();

        textarea.value = 'updated';
        saveButton.onclick();
        expect(updateConversationChatMessage).toHaveBeenCalledWith('char.png', 42, 'updated', null, {
            groupId: '',
            personaId: 'persona-a.png',
        });
    });

    test('cancels an existing editor before opening another', async () => {
        const restoredText = {};
        const originalText = {
            append: jest.fn(),
            cloneNode: jest.fn(() => restoredText),
            isConnected: true,
            querySelector: jest.fn(() => null),
            replaceWith: jest.fn(),
            textContent: 'first',
        };
        const originalActions = { classList: { remove: jest.fn() } };
        const previousMessageElement = {
            classList: { add: jest.fn(), remove: jest.fn() },
            dataset: { messageId: '42', sbConversationMessageFingerprint: 'previous-fingerprint' },
            querySelector: jest.fn(selector => selector === '.sb-conversation-mobile-menu-trigger' ? null : selector === '.sb-conversation-message-actions' ? originalActions : originalText),
        };
        const nextText = {
            append: jest.fn(),
            cloneNode: jest.fn(() => ({})),
            querySelector: jest.fn(() => null),
            textContent: 'hello',
        };
        const nextActions = { classList: { remove: jest.fn() } };
        const nextMessageElement = {
            classList: { add: jest.fn(), remove: jest.fn() },
            dataset: { messageId: '43' },
            querySelector: jest.fn(selector => selector === '.sb-conversation-mobile-menu-trigger' ? null : selector === '.sb-conversation-message-actions' ? nextActions : nextText),
        };
        globalThis.document = {
            createElement: jest.fn(() => ({
                append: jest.fn(),
                classList: { add: jest.fn(), remove: jest.fn() },
                dataset: {},
                focus: jest.fn(),
                setAttribute: jest.fn(),
                value: '',
            })),
            querySelectorAll: jest.fn(() => [previousMessageElement]),
        };
        chatMessages.splice(0, chatMessages.length,
            { id: 42, role: 'user', name: 'User', mes: 'first', extra: {} },
            { id: 43, role: 'user', name: 'User', mes: 'hello', extra: {} },
        );

        await editConversationMessage('42');
        globalThis.document.querySelectorAll.mockReturnValue([nextMessageElement]);
        await editConversationMessage('43');

        expect(previousMessageElement.classList.remove).toHaveBeenCalledWith('is-editing');
        expect(originalText.replaceWith).toHaveBeenCalledWith(restoredText);
        expect(originalActions.classList.remove).toHaveBeenCalledWith('open');
    });

    test('does not persist a blanked message so deletion stays explicit', async () => {
        const textElement = {
            append: jest.fn(),
            cloneNode: jest.fn(() => ({})),
            isConnected: true,
            querySelector: jest.fn(() => null),
            replaceWith: jest.fn(),
            textContent: 'hello',
        };
        const actionBar = { classList: { remove: jest.fn() } };
        const messageElement = {
            classList: { add: jest.fn(), remove: jest.fn() },
            dataset: { messageId: '42' },
            querySelector: jest.fn(selector => selector === '.sb-conversation-mobile-menu-trigger' ? null : selector === '.sb-conversation-message-actions' ? actionBar : textElement),
        };
        const createdElements = [];
        globalThis.document = {
            createElement: jest.fn(() => {
                const element = {
                    append: jest.fn(),
                    children: [],
                    classList: { add: jest.fn(), remove: jest.fn() },
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
        chatMessages.splice(0, chatMessages.length, { id: 42, role: 'user', name: 'User', mes: 'hello', extra: {} });

        await editConversationMessage('42');

        const [textarea, buttonContainer] = createdElements;
        const [saveButton] = buttonContainer.children;
        textarea.value = '   ';
        saveButton.onclick();

        expect(updateConversationChatMessage).not.toHaveBeenCalled();
        expect(messageElement.classList.remove).toHaveBeenCalledWith('is-editing');
    });

    test('keeps the open editor when discarding unsaved changes is declined', async () => {
        const originalText = {
            append: jest.fn(),
            cloneNode: jest.fn(() => ({})),
            isConnected: true,
            querySelector: jest.fn(() => null),
            replaceWith: jest.fn(),
            textContent: 'first',
        };
        const previousMessageElement = {
            classList: { add: jest.fn(), remove: jest.fn() },
            dataset: { messageId: '42' },
            querySelector: jest.fn(selector => selector === '.sb-conversation-mobile-menu-trigger' ? null : selector === '.sb-conversation-message-actions'
                ? { classList: { remove: jest.fn() } }
                : originalText),
        };
        const nextText = {
            append: jest.fn(),
            cloneNode: jest.fn(() => ({})),
            querySelector: jest.fn(() => null),
            textContent: 'hello',
        };
        const nextMessageElement = {
            classList: { add: jest.fn() },
            dataset: { messageId: '43' },
            querySelector: jest.fn(selector => selector === '.sb-conversation-mobile-menu-trigger' ? null : selector === '.sb-conversation-message-actions'
                ? { classList: { remove: jest.fn() } }
                : nextText),
        };
        const createdElements = [];
        globalThis.document = {
            createElement: jest.fn(() => {
                const element = {
                    append: jest.fn(),
                    classList: { add: jest.fn(), remove: jest.fn() },
                    dataset: {},
                    focus: jest.fn(),
                    setAttribute: jest.fn(),
                    value: '',
                };
                createdElements.push(element);
                return element;
            }),
            querySelectorAll: jest.fn(() => [previousMessageElement]),
        };
        confirmConversationAction.mockImplementation(async () => false);
        chatMessages.splice(0, chatMessages.length,
            { id: 42, role: 'user', name: 'User', mes: 'first', extra: {} },
            { id: 43, role: 'user', name: 'User', mes: 'hello', extra: {} },
        );

        await editConversationMessage('42');
        const [textarea] = createdElements;
        textarea.value = 'edited but unsaved';
        globalThis.document.querySelectorAll.mockReturnValue([nextMessageElement]);
        await editConversationMessage('43');

        expect(confirmConversationAction).toHaveBeenCalled();
        expect(originalText.replaceWith).not.toHaveBeenCalled();
        expect(nextMessageElement.classList.add).not.toHaveBeenCalled();
    });
});
