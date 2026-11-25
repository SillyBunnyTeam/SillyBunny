/**
 * The page around `auto-engine.js`, as a world that a test sets up: conversations as the data module holds them, the
 * cards of the characters, the status of the user and of each character, and spies on everything that the worker asks
 * of the model or writes into a chat. The engine itself is the real module.
 *
 * A test file calls `await installAutoEngineMocks(jest, world)` before it imports the engine.
 */

export const PERSONA = 'persona-a.png';
export const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
export const MINUTE = 60_000;

export function createWorld(jest) {
    const world = {
        views: new Map(),
        railItems: [],
        cards: new Map(),
        /** Messages of each chat, by `conversationId/chatId`. */
        messages: new Map(),
        userStatus: 'online',
        /** Status of a character now; absent means online. */
        statuses: new Map(),
        /** Events in the order that they happened, so that a test can say that one came before another. */
        log: [],
        state: { conversationState: {}, sendQueue: [] },
        spies: {
            generateConversationReply: jest.fn(),
            postCharacterReply: jest.fn(),
            postMemberConversationReply: jest.fn(),
            ensureConversationChatLoaded: jest.fn(),
            reloadConversationChat: jest.fn(),
            generateConversationImage: jest.fn(),
            appendConversationMessage: jest.fn(),
            reportConversationGenerationError: jest.fn(),
        },
    };

    world.reset = () => {
        world.views.clear();
        world.railItems = [];
        world.cards.clear();
        world.messages.clear();
        world.userStatus = 'online';
        world.statuses.clear();
        world.log.length = 0;
        for (const key of Object.keys(world.state.conversationState)) {
            delete world.state.conversationState[key];
        }
        world.state.sendQueue.length = 0;
        for (const spy of Object.values(world.spies)) {
            spy.mockReset();
        }
        world.spies.generateConversationReply.mockImplementation(async () => {
            world.log.push('generate');
            return 'Hello there.';
        });
        world.spies.postCharacterReply.mockResolvedValue('Hello there.');
        world.spies.postMemberConversationReply.mockResolvedValue(true);
        world.spies.ensureConversationChatLoaded.mockImplementation(async (avatar, { chatId = '', groupId = '' } = {}) => {
            const view = world.findView(groupId);
            const entry = view?.chats.find(item => item.id === (chatId || view.activeChatId));
            return entry ? { conversationId: view.id, chatId: entry.id } : null;
        });
        world.spies.reloadConversationChat.mockImplementation(async () => null);
    };

    world.findView = groupId => [...world.views.values()].find(view => (groupId ? view.id === groupId : view.kind === 'direct')) ?? null;

    /** A character card and the status that it has now. */
    world.addCharacter = (avatar, { name = avatar.replace('.png', ''), talkativeness = 0.5, status = 'online' } = {}) => {
        world.cards.set(avatar, { avatar, name, talkativeness });
        world.statuses.set(avatar, status);
    };

    /**
     * A conversation. The chat has a message from the user unless `hasUserMessage` is false, and the user last wrote
     * `quietMinutes` ago.
     */
    world.addConversation = (id, { kind = 'direct', characters = ['char.png'], hasUserMessage = true, quietMinutes = 0, settings = {}, lastMessageRole = null, chats, reminders = [] } = {}) => {
        for (const avatar of characters) {
            if (!world.cards.has(avatar)) {
                world.addCharacter(avatar, { name: avatar === 'char.png' ? 'Aster' : avatar.replace('.png', '') });
            }
        }
        const view = {
            id,
            kind,
            personaId: PERSONA,
            characters,
            extras: [],
            settings: { inactivity_threshold: 60, ...settings },
            activeChatId: 'main',
            chats: chats ?? [{
                id: 'main',
                hasUserMessage,
                messageCount: hasUserMessage ? 2 : 0,
                lastMessageRole: lastMessageRole ?? (hasUserMessage ? 'character' : ''),
                lastActivity: NOW - quietMinutes * MINUTE,
                followupCount: 0,
                lastAutoMessageAt: 0,
            }],
            reminders,
        };
        world.views.set(id, view);
        world.messages.set(`${id}/main`, []);
        return view;
    };

    /** The rail item that the worker sees for a conversation, with the settings of the conversation on top of the defaults. */
    world.railItemFor = (view, { anchor = view.characters[0] } = {}) => ({
        character: world.cards.get(anchor),
        settings: { proactive_messaging: false, max_followups: 3, ...view.settings },
        groupId: view.kind === 'group' ? view.id : '',
        group: view.kind === 'group' ? { id: view.id, members: view.characters, disabled_members: [] } : null,
    });

    world.entryOf = view => view.chats.find(item => item.id === view.activeChatId);
    world.say = (view, message) => world.messages.get(`${view.id}/${view.activeChatId}`).push(message);
    return world;
}

/**
 * @param {typeof import('@jest/globals').jest} jest
 * @param {ReturnType<typeof createWorld>} world
 */
export async function installAutoEngineMocks(jest, world) {
    const { spies } = world;
    const viewFor = groupId => world.findView(groupId);

    await jest.unstable_mockModule('../public/script.js', () => ({ chat: [], is_send_press: false, name1: 'User' }));
    await jest.unstable_mockModule('../public/scripts/resumable-generation.js', () => ({ pageId: 'page-test' }));
    await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: null }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
        getActiveConversationChat: (_avatar, { groupId = '' } = {}) => {
            const view = viewFor(groupId);
            return view ? world.entryOf(view) : null;
        },
        getConversationAddress: (_avatar, { groupId = '', chatId = '' } = {}) => {
            const view = viewFor(groupId);
            const entry = view?.chats.find(item => item.id === (chatId || view.activeChatId));
            return entry ? { conversationId: view.id, chatId: entry.id } : null;
        },
        getConversationGroupIdForAvatar: () => '',
        getConversationPersonaId: value => String(typeof value === 'undefined' ? PERSONA : value || ''),
        getConversationRecord: (_avatar, { groupId = '' } = {}) => viewFor(groupId),
        getCurrentCharAvatar: () => 'char.png',
        getCurrentCharName: () => 'Aster',
        getRoleplayCurrentCharacter: () => ({ avatar: 'char.png' }),
        getRoleplayGroupById: () => null,
        parsePositiveInt: (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback),
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({
        conversationData: {
            list: ({ personaId } = {}) => [...world.views.values()].filter(view => personaId === undefined || view.personaId === personaId),
            get: id => world.views.get(id) ?? null,
            patchConversation: jest.fn((id, patch) => {
                const view = world.views.get(id);
                if (!view) {
                    return false;
                }
                for (const [chatId, state] of Object.entries(patch.chats ?? {})) {
                    Object.assign(view.chats.find(item => item.id === chatId) ?? {}, state);
                    world.log.push(`patch:${Object.keys(state).join(',')}`);
                }
                return true;
            }),
            patchReminder: jest.fn((id, reminderId, change) => {
                const view = world.views.get(id);
                const reminder = view?.reminders.find(item => item.id === reminderId);
                if (!reminder) {
                    return false;
                }
                for (const [key, value] of Object.entries(change)) {
                    if (value === null) {
                        delete reminder[key];
                    } else {
                        reminder[key] = value;
                    }
                }
                world.log.push(`reminder:${Object.keys(change).join(',')}`);
                return true;
            }),
        },
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({
        generateConversationReply: spies.generateConversationReply,
        postCharacterReply: spies.postCharacterReply,
        postMemberConversationReply: spies.postMemberConversationReply,
        reportConversationGenerationError: spies.reportConversationGenerationError,
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/interface.js', () => ({ loadCurrentPanelSettings: jest.fn() }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
        buildCharacterImagePrompt: () => 'a prompt',
        generateConversationImage: spies.generateConversationImage,
        getCharacterForAvatar: avatar => world.cards.get(avatar) ?? null,
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/message-writer.js', () => ({ appendConversationMessage: spies.appendConversationMessage }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list.js', () => ({
        buildGroupChatContext: () => '',
        getConversationRailItems: () => world.railItems,
        getCurrentGroupConversationMembers: () => [],
        getGroupAsideKey: () => '',
        getSelectedConversationGroup: () => null,
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/members.js', () => ({ isCharacterMentionedInText: () => false }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({
        getConversationPersonaName: () => 'User',
        getUserStatus: () => world.userStatus,
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({ buildConversationRoleplayContext: () => '' }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
        getFollowupCount: (_avatar, { groupId = '' } = {}) => {
            const view = viewFor(groupId);
            return view ? (world.entryOf(view).followupCount ?? 0) : 0;
        },
        getLastUserActivity: (_avatar, fallback, { groupId = '' } = {}) => {
            const view = viewFor(groupId);
            return view ? (world.entryOf(view).lastActivity ?? fallback) : fallback;
        },
        getSettings: (avatar, { groupId = '' } = {}) => {
            const view = viewFor(groupId);
            return { image_gen_enabled: false, spontaneous_selfies: false, ...view?.settings, availability: world.statuses.get(avatar) ?? 'online' };
        },
        setFollowupCount: (_avatar, count, { groupId = '' } = {}) => {
            const view = viewFor(groupId);
            if (view) {
                world.entryOf(view).followupCount = count;
                world.log.push('claim:followupCount');
            }
        },
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
        conversationState: world.state.conversationState,
        groupAsideBusyKeys: new Set(),
        groupAsideLastSent: new Map(),
        sendQueue: world.state.sendQueue,
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timers.js', () => ({
        clearConversationTimeouts: jest.fn(),
        setConversationTimeout: jest.fn(),
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', async () => {
        const { resolveConversationReminderChatId } = await import('../../public/scripts/sillybunny-conversation/conversation-store-utils.js');
        return {
            ensureConversationChatLoaded: spies.ensureConversationChatLoaded,
            getConversationMessages: (_avatar, { chatId = '', groupId = '' } = {}) => {
                const view = viewFor(groupId);
                return view ? (world.messages.get(`${view.id}/${chatId || view.activeChatId}`) ?? []) : [];
            },
            getImageCooldownRemainingSeconds: () => 0,
            markImageGenerated: jest.fn(),
            reloadConversationChat: spies.reloadConversationChat,
            resolveConversationReminderChatId,
        };
    });
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
        getConversationActivityContext: (_settings, avatar) => ({ activity: 'reading', source: 'manual', status: world.statuses.get(avatar) ?? 'online' }),
        withTypingParticipant: (_participant, task) => task(),
    }));
}
