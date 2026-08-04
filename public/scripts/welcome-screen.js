import {
    characters,
    chat,
    deleteCharacterChatByName,
    displayVersion,
    doNewChat,
    event_types,
    eventSource,
    getCharacters,
    getCurrentChatId,
    getRequestHeaders,
    getThumbnailUrl,
    is_send_press,
    main_api,
    newAssistantChat,
    openCharacterChat,
    printCharactersDebounced,
    renameGroupOrCharacterChat,
    saveSettingsDebounced,
    selectCharacterById,
    setActiveCharacter,
    setActiveGroup,
    system_avatar,
    this_chid,
} from '../script.js';
import { deleteGroupChatByName, getGroupAvatar, groups, is_group_generating, openGroupById, openGroupChat } from './group-chats.js';
import { deleteExtension, enableExtension, extension_settings, findExtension, getExtensionType, installExtension } from './extensions.js';
import { t } from './i18n.js';
import { getPresetManager } from './preset-manager.js';
import { isIOSWebKitPlatform } from './mobile-send-button.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { renderTemplateAsync } from './templates.js';
import { isAdmin } from './user.js';
import { accountStorage } from './util/AccountStorage.js';
import { clamp, flashHighlight, isElementInViewport, sortMoments, timestampToMoment } from './utils.js';

const assistantAvatarKey = 'assistant';
const pinnedChatsKey = 'pinnedChats';

const tutorialStatusKey = 'WelcomePage_TutorialStatus';
const tutorialIndexKey = 'WelcomePage_TutorialIndex';
const welcomeDeckViewKey = 'WelcomePage_DeckView';
const welcomePanelModeKey = 'WelcomePage_PanelMode';
const DEFAULT_BUNDLED_ASSISTANT_ID = 'guide';
const bundledAssistantNahidaAvatarKey = 'bundledAssistantNahidaAvatar';
const DEFAULT_NEUTRAL_ASSISTANT_NAME = 'Assistant';

const AGENT_MESSAGE_EXTRA_KEY = 'inChatAgents';
const AGENT_PROMPT_TRANSFORM_HISTORY_KEY = 'inChatAgentTransformHistory';
const STARTER_PACK_PRESET_NAME_SILLYBUNNY = 'Pura\'s Director Preset 15.0 (SillyBunny)';
const STARTER_PACK_PRESET_TITLE = 'Pura\'s Director Preset';
const TLD_PRESET_NAME = 'TLD Card Conversion Preset (Standalone)';
const STARTER_PACK_SITE_URL = 'https://platberlitz.github.io/';
const GEECHAN_PRESET_NAME = 'Geechan - Universal Roleplay (Chat Completions) (v5.2)';
const GEECHAN_SITE_URL = 'https://rentry.org/geechan';
const TLD_SITE_URL = 'https://botbooru.com/profile/25826';
const TLD_DISCORD_PALS_URL = 'https://github.com/TheLonelyDevil9/discord-pals/';
const STARTER_PACK_EXTENSIONS = Object.freeze({
    dialogueColors: Object.freeze({
        id: 'third-party/sillytavern-character-colors',
        repoUrl: 'https://github.com/platberlitz/sillytavern-character-colors',
    }),
    summarySharder: Object.freeze({
        id: 'third-party/summary-sharder',
        repoUrl: 'https://github.com/Promansis/summary-sharder',
    }),
    cssSnippets: Object.freeze({
        id: 'third-party/SillyBunny-CssSnippets',
        repoUrl: 'https://github.com/SillyBunnyTeam/SillyBunny-CssSnippets',
    }),
    moonlitEchoes: Object.freeze({
        id: 'third-party/SillyBunny-MoonlitEchoesTheme',
        repoUrl: 'https://github.com/platberlitz/SillyBunny-MoonlitEchoesTheme',
    }),
    groupUtilities: Object.freeze({
        id: 'third-party/SB-GroupUtilities',
        repoUrl: 'https://github.com/aracnai/SB-GroupUtilities',
    }),
    laLib: Object.freeze({
        id: 'third-party/SillyTavern-LALib',
        repoUrl: 'https://github.com/LenAnderson/SillyTavern-LALib',
    }),
    adhdBunnyUi: Object.freeze({
        id: 'third-party/ADHDBunny-UI',
        repoUrl: 'https://github.com/OnlyJimmy/ADHDBunny-UI',
    }),
    promptingLab: Object.freeze({
        id: 'third-party/SillyBunny-Prompting-Lab',
        repoUrl: 'https://github.com/SillyBunnyTeam/SillyBunny-Prompting-Lab',
    }),
    worldInfoLab: Object.freeze({
        id: 'third-party/SillyBunny-WorldInfo-Lab',
        repoUrl: 'https://github.com/SillyBunnyTeam/SillyBunny-WorldInfo-Lab',
    }),
    regexAgentThemes: Object.freeze({
        id: 'third-party/SillyBunny-Regex-Agent-Themes',
        repoUrl: 'https://github.com/SillyBunnyTeam/SillyBunny-Regex-Agent-Themes',
    }),
    botSearcher: Object.freeze({
        id: 'third-party/SillyBunny-BotSearcher',
        repoUrl: 'https://github.com/SillyBunnyTeam/SillyBunny-BotSearcher',
    }),
    macroEnhanced: Object.freeze({
        id: 'third-party/SillyBunny-MacroEnhanced',
        repoUrl: 'https://github.com/SillyBunnyTeam/SillyBunny-MacroEnhanced',
    }),
    promptTags: Object.freeze({
        id: 'third-party/SillyBunny-PromptTags',
        repoUrl: 'https://github.com/SillyBunnyTeam/SillyBunny-PromptTags',
    }),
});

const WELCOME_TUTORIAL_STEPS = Object.freeze([
    {
        title: 'Your homepage',
        body: 'The Home Page is your personal launchpad. You can quickly access various essential functions of SillyBunny here. For full access to this program\'s functionality, please use the top bar for further navigation and configuration.',
        hint: 'If you just want to directly chat with your chosen model, clicking Temporary Chat will get you started.',
        actions: Object.freeze([
            Object.freeze({ label: 'Open Workspace', type: 'open-tab', value: 'left:presets' }),
            Object.freeze({ label: 'Open Customize', type: 'open-tab', value: 'right:settings' }),
            Object.freeze({ label: 'Open Characters', type: 'open-characters-menu' }),
        ]),
    },
    {
        title: 'Connect a model',
        body: 'You will need to connect a large language model (LLM) to actually utilize the functionalities of this program. Open the API sub-tab found in Workspace to get started.',
        hint: 'Not sure what provider to use? OpenRouter is a good place to start. SillyBunny needs at least one working connection before you can chat.',
        actions: Object.freeze([
            Object.freeze({ label: 'Open API', type: 'open-tab', value: 'left:api' }),
            Object.freeze({ label: 'Open Sampling', type: 'open-tab', value: 'left:sampling' }),
        ]),
    },
    {
        title: 'Choose a preset',
        body: 'Next, you can optionally enable a preset of your choice. This influences your model\'s responses and give it appropriate instructions for its task. We recommend starting with a Chat Completions preset if you\'re unsure.',
        hint: 'Presets are entirely optional, but can be beneficial for response quality. Our bundled Geechan or Director presets are a great starting preset option if you\'re unsure.',
        actions: Object.freeze([
            Object.freeze({ label: 'Open Presets', type: 'open-tab', value: 'left:presets' }),
            Object.freeze({ label: 'Open World Info', type: 'open-tab', value: 'left:world-info' }),
        ]),
    },
    {
        title: 'Load a character',
        body: 'Now that you\'ve gotten the pre-requisites out of the way, you\'re close to being able to chat! Open the Characters menu and select a character to get started on your RP/storywriting journey.',
        hint: 'You will need to source your own character cards from online (or create your own!) if you want more than just the bundled characters. SillyBunny supports all cards following the V2/V3 format.',
        actions: Object.freeze([
            Object.freeze({ label: 'Open Characters', type: 'open-characters-menu' }),
            Object.freeze({ label: 'Open Personas', type: 'open-tab', value: 'characters:persona' }),
            Object.freeze({ label: 'Open World Info', type: 'open-tab', value: 'left:world-info' }),
        ]),
    },
    {
        title: 'Customize your workspace',
        body: 'Congrats, you\'re done! If you wish to delve into all the functionality and customization that SillyBunny can offer, please explore our UI from the top bar. A good starting point is SillyBunny\'s vast extension ecosystem. For more information: check out the UI Handbook tab!',
        hint: 'The world of AI creative writing is vast and seemingly neverending. We recommend asking our built-in assistants for more help if you\'re confused!',
        actions: Object.freeze([
            Object.freeze({ label: 'Open UI Handbook', type: 'open-deck-view', value: 'basics' }),
            Object.freeze({ label: 'Open Extensions', type: 'open-tab', value: 'right:extensions' }),
            Object.freeze({ label: 'Open Assistant', type: 'open-assistant', assistantId: 'guide' }),
            Object.freeze({ label: 'Open Assistant Nahida', type: 'open-assistant', assistantId: 'nahida' }),
        ]),
    },
]);

const WELCOME_GUIDE_CARDS = Object.freeze([
    {
        title: 'Workspace Menu',
        body: 'Open the Workspace button in the top bar when you want to change how the LLM behaves behind the scenes. You can connect APIs, swap presets, tune samplers or formatting, and load in-chat agents to complement your chat.',
        icon: 'fa-compass-drafting',
        actions: Object.freeze([
            Object.freeze({ label: 'Open the Workspace menu', type: 'open-tab', value: 'left:presets' }),
            Object.freeze({ label: 'Open API', type: 'open-tab', value: 'left:api' }),
            Object.freeze({ label: 'Open Sampling', type: 'open-tab', value: 'left:sampling' }),
            Object.freeze({ label: 'Open Agents', type: 'open-tab', value: 'left:agents' }),
        ]),
    },
    {
        title: 'Customize Menu',
        body: 'Open the Customize button in the top bar when you want to change any setting related to SillyBunny itself. This includes app settings, extensions, backgrounds, and visual settings.',
        icon: 'fa-screwdriver-wrench',
        actions: Object.freeze([
            Object.freeze({ label: 'Open the Customize menu', type: 'open-tab', value: 'right:settings' }),
            Object.freeze({ label: 'Open Extensions', type: 'open-tab', value: 'right:extensions' }),
            Object.freeze({ label: 'Open Backgrounds', type: 'open-tab', value: 'right:background' }),
        ]),
    },
    {
        title: 'Characters Menu',
        body: 'Open the Characters button in the top bar when you want to access characters, edit personas, or create character cards. We have a few characters bundled for you to give you an idea of how to create them!',
        icon: 'fa-solid fa-id-card',
        actions: Object.freeze([
            Object.freeze({ label: 'Open the Characters menu', type: 'open-characters-menu' }),
            Object.freeze({ label: 'Open Personas', type: 'open-tab', value: 'characters:persona' }),
            Object.freeze({ label: 'Import Characters', type: 'open-import-characters' }),
        ]),
    },
    {
        title: 'Global Search',
        body: 'Open the search icon in the top bar to do a global search across all settings pages to quickly find the setting you are looking for!',
        icon: 'fa-search',
        actions: Object.freeze([
            Object.freeze({ label: 'Open the Search bar', type: 'open-global-search', isSearchTrigger: true }),
        ]),
    },
    {
        title: 'Quick-access Buttons',
        body: 'We have a few quick access buttons for your convenience in the home screen. Temporary Chat opens a quick burner chat. Open Assistant brings up one of our built-in assistants. Import Characters lets you bring in a character of your choosing.',
        icon: 'fa-hand-pointer',
        actions: Object.freeze([
            Object.freeze({ label: 'Temporary Chat', type: 'open-temporary-chat' }),
            Object.freeze({ label: 'Open Assistant', type: 'open-assistant', assistantId: 'guide' }),
            Object.freeze({ label: 'Import Characters', type: 'open-import-characters' }),
        ]),
    },
    {
        title: 'Chat Modes',
        body: 'With a selected character card, you can swap between either roleplay or conversation modes. Use roleplay if you want a traditional chatting experience with your character. Use conversation if you wish to simulate an instant-messaging live-chat environment with your character.',
        icon: 'fa-comments',
        actions: Object.freeze([
            Object.freeze({ label: 'Open Roleplay', type: 'open-roleplay' }),
            Object.freeze({ label: 'Open Conversation', type: 'open-conversation' }),
        ]),
    },
]);

const WELCOME_BUNDLED_ASSISTANTS = Object.freeze([
    Object.freeze({
        id: 'guide',
        avatarStorageKey: assistantAvatarKey,
        identityStorageKey: 'bundledAssistantGuideAvatar',
        deletedStorageKey: 'bundledAssistantGuideDeleted',
        defaultAvatar: 'default_SillyBunnyGuide.png',
        fileName: 'default_SillyBunnyGuide',
        portrait: 'img/sillybunny-guide-assistant-portrait.png',
        portraitAlt: 'Pixel-art bunny guide portrait',
        characterName: DEFAULT_NEUTRAL_ASSISTANT_NAME,
        title: 'Bunny Guide',
        body: 'Our bundled bunny assistant. It can explain what an LLM is, what providers and models mean, how SillyBunny differs from stock SillyTavern, and where presets, personas, and world info reside in the context of your RP or story.',
        credit: 'Created by purachina.',
        creator: 'purachina',
        creatorNotes: 'Automatically created bundled Bunny Guide character. Feel free to edit.',
        description: 'A calm built-in bunny assistant for explaining SillyBunny, SillyTavern, model providers, presets, personas, and related basics in plain English.',
        personality: 'Patient, beginner-friendly, calm, and practical.',
        scenario: 'You are the built-in Bunny Guide for SillyBunny. Help the user understand the interface, APIs, presets, prompt settings, personas, and world info in plain, approachable language.',
        firstMessage: 'Hi. I\'m the Bunny Guide. If anything in SillyBunny feels confusing, ask in plain English and I\'ll walk through it with you step by step.',
        questions: Object.freeze([
            'What is an LLM, in plain English?',
            'What is a character card?',
            'What does a preset actually change?',
            'How is SillyBunny different from base SillyTavern?',
        ]),
        actionLabel: 'Open Bunny Guide',
        actionIcon: 'fa-user-graduate',
        cardIcon: 'fa-user-graduate',
    }),
    Object.freeze({
        id: 'nahida',
        avatarStorageKey: bundledAssistantNahidaAvatarKey,
        identityStorageKey: 'bundledAssistantNahidaIdentityAvatar',
        deletedStorageKey: 'bundledAssistantNahidaDeleted',
        defaultAvatar: 'default_AssistantNahida.png',
        fileName: 'default_AssistantNahida',
        cardAsset: 'img/assistant-nahida-portrait.png',
        portrait: 'img/assistant-nahida-portrait.png',
        portraitAlt: 'Assistant Nahida portrait',
        characterName: 'Assistant Nahida',
        title: 'Assistant Nahida',
        body: 'Assistant Nahida is one of our bundled assistants: with a gentle, metaphor-laden demeanour for all kinds of queries. She has the same capabilities as our Bunny Assistant, but with a more philosophical lens.',
        credit: 'Created by Geechan.',
        creator: 'Geechan',
        creatorNotes: 'Bundled with SillyBunny. Created by Geechan. Feel free to edit.',
        description: 'Assistant Nahida is one of our bundled SillyBunny helpers. She can help explain prompts, token budgeting, presets, context setup, and workflow choices in calm, beginner-friendly language.',
        personality: 'Patient, observant, encouraging, thoughtful, and concise.',
        scenario: 'You are Assistant Nahida, a bundled helper for SillyBunny. Guide the user through prompts, token budgeting, presets, reasoning settings, context size, and general workflow questions with calm clarity.',
        firstMessage: 'Hello. I\'m Assistant Nahida, a bundled helper made by Geechan. If you want, we can sort out prompts, presets, context size, or any confusing settings together.',
        questions: Object.freeze([
            'Can you help me make sense of my current system prompt?',
            'What should I tune first: model, preset, or prompt settings?',
            'Do large language models feel emotions?',
            'Are larger parameter models better for roleplaying?',
        ]),
        actionLabel: 'Open Assistant Nahida',
        actionIcon: 'fa-leaf',
        cardIcon: 'fa-book-open',
    }),
]);

const WELCOME_DECK_VIEWS = Object.freeze([
    {
        id: 'tour',
        title: 'Starting Tutorial',
        summary: 'New to SillyBunny? Start here!',
        icon: 'fa-route',
    },
    {
        id: 'basics',
        title: 'UI Handbook',
        summary: 'A plain-English guide on our graphical shell.',
        icon: 'fa-compass-drafting',
    },
    {
        id: 'guide',
        title: 'Bundled Assistants',
        summary: 'Two bundled helpers for plain-English setup help.',
        icon: 'fa-user-graduate',
    },
    {
        id: 'starter',
        title: 'Bundled Extras',
        summary: 'A repository of our pre-bundled and recommended extensions/presets.',
        icon: 'fa-gift',
    },
]);

const WELCOME_PANEL_MODES = Object.freeze({
    full: 'full',
    compact: 'compact',
    list: 'list',
});
const recentChatsSettingsKey = 'recentChatsSettings';

const DEFAULT_MAX_DISPLAYED = 15;
const DEFAULT_COLLAPSED_DISPLAYED = 3;

/**
 * Gets the current recent chats settings from account storage.
 * @returns {{ maxDisplayed: number, collapsedDisplayed: number }}
 */
function getRecentChatsSettings() {
    const value = accountStorage.getItem(recentChatsSettingsKey);
    if (value) {
        try {
            const parsed = JSON.parse(value);
            return {
                maxDisplayed: Math.max(1, parseInt(parsed.maxDisplayed) || DEFAULT_MAX_DISPLAYED),
                collapsedDisplayed: Math.max(1, parseInt(parsed.collapsedDisplayed) || DEFAULT_COLLAPSED_DISPLAYED),
            };
        } catch {
            // Ignore parse errors
        }
    }
    return { maxDisplayed: DEFAULT_MAX_DISPLAYED, collapsedDisplayed: DEFAULT_COLLAPSED_DISPLAYED };
}

/**
 * Saves recent chats settings to account storage.
 * @param {{ maxDisplayed: number, collapsedDisplayed: number }} settings
 */
function saveRecentChatsSettings(settings) {
    accountStorage.setItem(recentChatsSettingsKey, JSON.stringify(settings));
}


/**
 * @typedef {Pick<RecentChat, 'group' | 'avatar' | 'file_name' | 'is_conversation' | 'conversation_branch_id'>} PinnedChat
 */

/**
 * Manages pinned chat storage and operations.
 */
class PinnedChatsManager {
    /** @type {Record<string, PinnedChat> | null} */
    static #cachedState = null;

    /**
     * Initializes the cached state from storage.
     * Should be called once on app init.
     */
    static init() {
        this.#cachedState = this.#loadFromStorage();
    }

    /**
     * Loads state from storage.
     * @returns {Record<string, PinnedChat>}
     */
    static #loadFromStorage() {
        const pinnedState = /** @type {Record<string, PinnedChat>} */ ({});
        const value = accountStorage.getItem(pinnedChatsKey);
        if (value) {
            try {
                Object.assign(pinnedState, JSON.parse(value));
            } catch (error) {
                console.warn('Failed to parse pinned chats from storage.', error);
            }
        }
        return pinnedState;
    }

    /**
     * Generates a key for pinned chat storage.
     * @param {Partial<RecentChat>} recentChat Recent chat data
     * @returns {string} Key for pinned chat storage
     */
    static getKey(recentChat) {
        if (recentChat.is_conversation && recentChat.conversation_branch_id) {
            const ownerKey = recentChat.group ? `group_${recentChat.group}` : `char_${recentChat.avatar || ''}`;
            return `conversation_${ownerKey}_branch_${recentChat.conversation_branch_id}`;
        }
        return `${recentChat.group ? 'group_' + recentChat.group : ''}${recentChat.avatar ? 'char_' + recentChat.avatar : ''}_${recentChat.file_name}`;
    }

    /**
     * Gets the pinned chat state from cache.
     * @returns {Record<string, PinnedChat>}
     */
    static getState() {
        if (this.#cachedState === null) {
            this.#cachedState = this.#loadFromStorage();
        }
        return this.#cachedState;
    }

    /**
     * Saves the pinned chat state to storage and updates cache.
     * @param {Record<string, PinnedChat>} state The state to save
     */
    static #saveState(state) {
        this.#cachedState = state;
        accountStorage.setItem(pinnedChatsKey, JSON.stringify(state));
    }

    /**
     * Checks if a chat is pinned.
     * @param {RecentChat} recentChat Recent chat data
     * @returns {boolean} True if the chat is pinned, false otherwise
     */
    static isPinned(recentChat) {
        const pinKey = this.getKey(recentChat);
        const pinState = this.getState();
        return pinKey in pinState;
    }

    /**
     * Toggles the pinned state of a chat.
     * @param {RecentChat} recentChat Recent chat data
     * @param {boolean} pinned New pinned state
     */
    static toggle(recentChat, pinned) {
        const pinKey = this.getKey(recentChat);
        const pinState = { ...this.getState() };
        if (pinned) {
            pinState[pinKey] = {
                group: recentChat.group,
                avatar: recentChat.avatar,
                file_name: recentChat.file_name,
                is_conversation: recentChat.is_conversation,
                conversation_branch_id: recentChat.conversation_branch_id,
            };
        } else {
            delete pinState[pinKey];
        }
        this.#saveState(pinState);
    }

    /**
     * Removes a deleted chat from pinned storage.
     * @param {{ avatar?: string, group?: string, fileName: string }} chat Chat identity
     */
    static removeDeleted({ avatar = '', group = '', fileName }) {
        const pinState = { ...this.getState() };
        const normalizedFileName = String(fileName).replace(/\.jsonl$/i, '');
        let changed = false;

        for (const [key, pinnedChat] of Object.entries(pinState)) {
            if (pinnedChat.is_conversation) {
                continue;
            }
            const pinnedFileName = String(pinnedChat.file_name || '').replace(/\.jsonl$/i, '');
            const matchesOwner = group
                ? String(pinnedChat.group || '') === String(group)
                : String(pinnedChat.avatar || '') === String(avatar);
            if (pinnedFileName === normalizedFileName && matchesOwner) {
                delete pinState[key];
                changed = true;
            }
        }

        if (changed) {
            this.#saveState(pinState);
        }
    }

    /**
     * Removes one exact chat from pinned storage.
     * @param {RecentChat} recentChat Recent chat data
     */
    static remove(recentChat) {
        const pinKey = this.getKey(recentChat);
        const pinState = { ...this.getState() };
        if (!(pinKey in pinState)) {
            return;
        }
        delete pinState[pinKey];
        this.#saveState(pinState);
    }

    /**
     * Migrates pinned state when a chat is renamed.
     * @param {Partial<RecentChat>} recentChat Recent chat data (with original file_name)
     * @param {string} newFileName New file name after rename
     */
    static rename(recentChat, newFileName) {
        const oldKey = this.getKey(recentChat);
        const pinState = { ...this.getState() };
        if (!(oldKey in pinState)) {
            return;
        }
        const updatedChat = { ...recentChat, file_name: newFileName };
        const newKey = this.getKey(updatedChat);
        pinState[newKey] = {
            ...pinState[oldKey],
            group: recentChat.group,
            avatar: recentChat.avatar,
            file_name: newFileName,
        };
        if (oldKey !== newKey) {
            delete pinState[oldKey];
        }
        this.#saveState(pinState);
    }

    /**
     * Gets all pinned chats.
     * @returns {PinnedChat[]}
     */
    static getAll() {
        const pinState = this.getState();
        return Object.values(pinState).filter(pinnedChat => !pinnedChat.is_conversation);
    }
}

function getBundledAssistantConfig(assistantId = DEFAULT_BUNDLED_ASSISTANT_ID) {
    return WELCOME_BUNDLED_ASSISTANTS.find(item => item.id === assistantId) ?? WELCOME_BUNDLED_ASSISTANTS[0];
}

function isBundledAssistantMarkedDeleted(config) {
    return accountStorage.getItem(config.deletedStorageKey) === 'true';
}

function clearBundledAssistantDeleted(config) {
    accountStorage.removeItem(config.deletedStorageKey);
}

function markBundledAssistantDeleted(config, deletedAvatar) {
    accountStorage.setItem(config.deletedStorageKey, 'true');
    const storedAvatar = accountStorage.getItem(config.avatarStorageKey);
    if (!storedAvatar || storedAvatar === deletedAvatar) {
        accountStorage.removeItem(config.avatarStorageKey);
    }
    const identityAvatar = accountStorage.getItem(config.identityStorageKey);
    if (!identityAvatar || identityAvatar === deletedAvatar) {
        accountStorage.removeItem(config.identityStorageKey);
    }
}

function getBundledAssistantIdentityAvatar(config) {
    return accountStorage.getItem(config.identityStorageKey) || config.defaultAvatar;
}

function setBundledAssistantIdentityAvatar(config, avatar) {
    if (!avatar || avatar === config.defaultAvatar) {
        accountStorage.removeItem(config.identityStorageKey);
    } else {
        accountStorage.setItem(config.identityStorageKey, avatar);
    }

    clearBundledAssistantDeleted(config);
}

function hasBundledAssistantFingerprint(config, character) {
    const creator = typeof character?.creator === 'string' ? character.creator.toLowerCase() : '';
    const creatorNotes = typeof character?.creator_notes === 'string' ? character.creator_notes.toLowerCase() : '';
    const name = typeof character?.name === 'string' ? character.name.toLowerCase() : '';
    const tags = Array.isArray(character?.tags) ? character.tags.map(tag => String(tag).toLowerCase()) : [];

    return creatorNotes.includes('bundled')
        || creatorNotes.includes(config.title.toLowerCase())
        || (creator === String(config.creator).toLowerCase() && name === String(config.characterName).toLowerCase())
        || (creator === String(config.creator).toLowerCase() && name === config.title.toLowerCase())
        || tags.includes('bundled');
}

function isBundledAssistantCharacter(config, character) {
    const avatar = typeof character?.avatar === 'string' ? character.avatar : '';
    if (!avatar) {
        return false;
    }

    const identityAvatar = getBundledAssistantIdentityAvatar(config);
    const storedAvatar = accountStorage.getItem(config.avatarStorageKey);
    return avatar === config.defaultAvatar
        || avatar === identityAvatar
        || (avatar === storedAvatar && hasBundledAssistantFingerprint(config, character));
}

function setBundledAssistantStoredAvatar(config, avatar) {
    if (!avatar || avatar === config.defaultAvatar) {
        accountStorage.removeItem(config.avatarStorageKey);
        return;
    }

    accountStorage.setItem(config.avatarStorageKey, avatar);
}

function getBundledAssistantAvatar(config = getBundledAssistantConfig()) {
    const assistantAvatar = accountStorage.getItem(config.avatarStorageKey);
    if (assistantAvatar === null) {
        return config.defaultAvatar;
    }

    const character = characters.find(x => x.avatar === assistantAvatar);
    if (character === undefined) {
        accountStorage.removeItem(config.avatarStorageKey);
        return config.defaultAvatar;
    }

    return assistantAvatar;
}

export function getPermanentAssistantAvatar() {
    return getBundledAssistantAvatar(getBundledAssistantConfig(DEFAULT_BUNDLED_ASSISTANT_ID));
}

/**
 * Finds the permanent assistant character in the loaded character list.
 * Falls back to the default assistant avatar if a custom assistant pointer became stale.
 * @param {string} avatar Assistant avatar name
 * @returns {number} Character ID or -1 if not found
 */
function findBundledAssistantCharacterId(config, avatar = getBundledAssistantAvatar(config)) {
    const requestedCharacterId = characters.findIndex(x => x.avatar === avatar);
    if (requestedCharacterId >= 0) {
        return requestedCharacterId;
    }

    if (avatar !== config.defaultAvatar) {
        const defaultCharacterId = characters.findIndex(x => x.avatar === config.defaultAvatar);
        if (defaultCharacterId >= 0) {
            accountStorage.removeItem(config.avatarStorageKey);
            return defaultCharacterId;
        }
    }

    return -1;
}

/**
 * Resolves the configured assistant to a loaded character, creating it on demand when needed.
 * @param {object} [options]
 * @param {boolean} [options.tryCreate=true] Whether a missing assistant should be created automatically.
 * @param {boolean} [options.created=false] Whether the current resolution came from a fresh create flow.
 * @param {boolean} [options.forceCreate=false] Whether to create even if the bundled assistant was deleted.
 * @returns {Promise<{avatar: string, characterId: number, created: boolean} | null>}
 */
async function ensureBundledAssistantCharacter(config, { tryCreate = true, created = false, forceCreate = false } = {}) {
    const avatar = getBundledAssistantAvatar(config);
    const characterId = findBundledAssistantCharacterId(config, avatar);

    if (characterId !== -1) {
        if (avatar === config.defaultAvatar || avatar === getBundledAssistantIdentityAvatar(config)) {
            clearBundledAssistantDeleted(config);
        }
        return { avatar, characterId, created };
    }

    if (!tryCreate) {
        console.error(`Character not found for avatar ID: ${avatar}. Cannot create.`);
        return null;
    }

    if (isBundledAssistantMarkedDeleted(config) && !forceCreate) {
        console.info(`Bundled assistant "${config.id}" was deleted by the user. Skipping automatic recreation.`);
        return null;
    }

    try {
        console.log(`Character not found for avatar ID: ${avatar}. Creating new bundled assistant.`, config.id);
        await createBundledAssistant(config);
        return ensureBundledAssistantCharacter(config, { tryCreate: false, created: true, forceCreate });
    } catch (error) {
        console.error(`Error creating bundled assistant "${config.id}":`, error);
        toastr.error(t`Failed to create ${config.characterName}. See console for details.`);
        return null;
    }
}

function isWelcomeDeckView(view) {
    return WELCOME_DECK_VIEWS.some(item => item.id === view);
}

function getInitialDeckView() {
    const storedView = getWelcomeUiPreference(welcomeDeckViewKey) || '';

    if (isWelcomeDeckView(storedView)) {
        return storedView;
    }

    return 'tour';
}

function isWelcomePanelMode(mode) {
    return Object.values(WELCOME_PANEL_MODES).includes(mode);
}

function getWelcomePanelMode() {
    const storedMode = getWelcomeUiPreference(welcomePanelModeKey) || WELCOME_PANEL_MODES.full;
    return isWelcomePanelMode(storedMode) ? storedMode : WELCOME_PANEL_MODES.full;
}

function getWelcomeUiPreference(key) {
    const accountValue = accountStorage.getItem(key);
    if (accountValue !== null) {
        return accountValue;
    }

    try {
        const localValue = globalThis.localStorage?.getItem(key) ?? null;

        if (localValue !== null) {
            accountStorage.setItem(key, localValue);
            return localValue;
        }
    } catch {
        // Fall through to the account-backed preference.
    }

    return accountStorage.getItem(key);
}

function setWelcomeUiPreference(key, value) {
    const stringValue = String(value);
    accountStorage.setItem(key, stringValue);

    try {
        globalThis.localStorage?.setItem(key, stringValue);
    } catch {
        // Ignore storage access failures and keep the account-backed preference.
    }
}

function buildDeckTabs(activeView) {
    return WELCOME_DECK_VIEWS.map(item => ({
        ...item,
        active: item.id === activeView,
    }));
}

function buildGuideCards() {
    return WELCOME_GUIDE_CARDS.map(card => ({
        ...card,
        actions: card.actions.map(action => ({ ...action })),
    }));
}

function buildBundledAssistantCards() {
    return WELCOME_BUNDLED_ASSISTANTS.map((assistant) => ({
        id: assistant.id,
        title: assistant.title,
        body: assistant.body,
        credit: assistant.credit,
        portrait: assistant.portrait,
        portraitAlt: assistant.portraitAlt,
        actionLabel: assistant.actionLabel,
        actionIcon: assistant.actionIcon,
        cardIcon: assistant.cardIcon,
        questions: [...assistant.questions],
        hasQuestions: assistant.questions.length > 0,
    }));
}

function buildTutorialSteps(activeIndex = 0) {
    return WELCOME_TUTORIAL_STEPS.map((step, index) => ({
        ...step,
        actions: step.actions.map(action => ({ ...action })),
        stepNumber: index + 1,
        active: index === activeIndex,
    }));
}

function getStarterPackExtensionConfig(extensionName) {
    return Object.values(STARTER_PACK_EXTENSIONS).find(extension => extension.id === extensionName) ?? null;
}

function buildExtensionStarterPackItem({ title, body, icon, extensionName }) {
    const extension = findExtension(extensionName);
    const extensionConfig = getStarterPackExtensionConfig(extensionName);

    if (!extension && extensionConfig) {
        const isCurrentUserAdmin = isAdmin();
        return {
            title,
            body,
            icon,
            statusLabel: 'Git install',
            statusTone: 'warm',
            actionIcon: 'fa-download',
            actionLabel: isCurrentUserAdmin ? 'Install for all users' : 'Install for this user',
            actionType: isCurrentUserAdmin ? 'install-starter-extension-global' : 'install-starter-extension-user',
            actionValue: extensionName,
            secondaryActionLabel: isCurrentUserAdmin ? 'Install for this user' : '',
            secondaryActionIcon: 'fa-user',
            secondaryActionType: 'install-starter-extension-user',
            secondaryActionValue: extensionName,
        };
    }

    if (!extension) {
        return {
            title,
            body,
            icon,
            statusLabel: 'Unavailable',
            statusTone: 'neutral',
            actionIcon: 'fa-arrow-up-right-from-square',
            actionLabel: 'Open Extensions',
            actionType: 'open-tab',
            actionValue: 'right:extensions',
        };
    }

    if (extension.enabled) {
        return {
            title,
            body,
            icon,
            statusLabel: 'Enabled',
            statusTone: 'good',
            actionIcon: 'fa-arrow-up-right-from-square',
            actionLabel: 'Manage in Extensions',
            actionType: 'open-tab',
            actionValue: 'right:extensions',
            secondaryActionLabel: 'Remove Extension',
            secondaryActionIcon: 'fa-trash',
            secondaryActionType: 'remove-starter-extension',
            secondaryActionValue: extension.name,
        };
    }

    return {
        title,
        body,
        icon,
        statusLabel: 'Installed',
        statusTone: 'warm',
        actionLabel: 'Enable and reload',
        actionIcon: 'fa-wand-magic-sparkles',
        actionType: 'enable-extension',
        actionValue: extension.name,
        secondaryActionLabel: 'Remove Extension',
        secondaryActionIcon: 'fa-trash',
        secondaryActionType: 'remove-starter-extension',
        secondaryActionValue: extension.name,
    };
}

function buildPresetStarterPackItem() {
    const presetManager = getPresetManager('openai');
    const sillyBunnyPreset = presetManager?.findPreset(STARTER_PACK_PRESET_NAME_SILLYBUNNY);
    const isOpenAiStyleApi = main_api === 'openai';
    const selectedPresetName = isOpenAiStyleApi ? presetManager?.getSelectedPresetName() : '';
    const isSelected = selectedPresetName === STARTER_PACK_PRESET_NAME_SILLYBUNNY;
    const hasBundledPreset = Boolean(sillyBunnyPreset);
    const body = 'Purachina\'s Director v15.0 preset is fully bundled with SillyBunny as a preset option. This preset is ideal if you want the LLM to have maximum control over the story, the characters, *and* your persona. Simply go to the Presets menu to find it. If you wish to see more of Pura\'s character cards and other projects, check out the link below!';

    if (!isOpenAiStyleApi) {
        return {
            title: STARTER_PACK_PRESET_TITLE,
            body,
            icon: 'fa-sliders',
            statusLabel: 'Chat Completions',
            statusTone: 'neutral',
            actionIcon: 'fa-arrow-up-right-from-square',
            actionLabel: 'API',
            actionType: 'open-tab',
            actionValue: 'left:api',
        };
    }

    if (hasBundledPreset) {
        return {
            title: STARTER_PACK_PRESET_TITLE,
            body,
            icon: 'fa-sliders',
            statusLabel: isSelected ? 'Selected' : 'Preset pack',
            statusTone: isSelected ? 'good' : 'warm',
            actionIcon: 'fa-wand-magic-sparkles',
            actionLabel: 'Apply preset',
            actionType: 'apply-preset',
            actionValue: STARTER_PACK_PRESET_NAME_SILLYBUNNY,
            secondaryActionLabel: 'Visit site',
            secondaryActionIcon: 'fa-arrow-up-right-from-square',
            secondaryActionType: 'open-link',
            secondaryActionValue: STARTER_PACK_SITE_URL,
        };
    }

    return {
        title: STARTER_PACK_PRESET_TITLE,
        body,
        icon: 'fa-sliders',
        statusLabel: 'Open Presets',
        statusTone: 'warm',
        actionIcon: 'fa-arrow-up-right-from-square',
        actionLabel: 'Open Presets',
        actionType: 'open-tab',
        actionValue: 'left:presets',
    };
}

function buildGeechanStarterPackItem() {
    const presetManager = getPresetManager('openai');
    const isOpenAiStyleApi = main_api === 'openai';
    const isSelected = isOpenAiStyleApi && presetManager?.getSelectedPresetName() === GEECHAN_PRESET_NAME;
    const body = 'Geechan\'s Universal Roleplay v5.2 and Universal Chatroom presets are also fully bundled with SillyBunny as a preset option. The Universal Roleplay preset is ideal if you want a traditional roleplay and storywriting experience with an LLM, while your persona and general story direction remain completely in your own hands. If you wish to see more of Geechan\'s character cards, presets, and guides, check out the link below!';

    return {
        title: 'Geechan\'s Universal Roleplay',
        body,
        icon: 'fa-leaf',
        statusLabel: isSelected ? 'Selected' : 'Preset pack',
        statusTone: isSelected ? 'good' : 'warm',
        actionLabel: 'Apply preset',
        actionIcon: 'fa-wand-magic-sparkles',
        actionType: 'apply-preset',
        actionValue: GEECHAN_PRESET_NAME,
        secondaryActionLabel: 'Visit site',
        secondaryActionIcon: 'fa-arrow-up-right-from-square',
        secondaryActionType: 'open-link',
        secondaryActionValue: GEECHAN_SITE_URL,
    };
}

function buildTldStarterPackItem() {
    const presetManager = getPresetManager('openai');
    const isOpenAiStyleApi = main_api === 'openai';
    const isSelected = isOpenAiStyleApi && presetManager?.getSelectedPresetName() === TLD_PRESET_NAME;
    const body = 'TheLonelyDevil\'s card converter preset is ideal if you want to convert a character card into a robust, well-tested AliChat + PList format for roleplay and storywriting. Very useful if you find a card that\'s of poorer quality and want a formatting polish run applied. If you wish to see more of TheLonelyDevil\'s character cards and Discord Pals project, check out the links below!';

    return {
        title: 'TheLonelyDevil\'s Card Converter',
        body,
        icon: 'fa-shoe-prints',
        statusLabel: !isOpenAiStyleApi ? 'Chat Completions' : (isSelected ? 'Selected' : 'Preset pack'),
        statusTone: isSelected ? 'good' : 'warm',
        actionLabel: isOpenAiStyleApi ? 'Apply preset' : 'API',
        actionIcon: isOpenAiStyleApi ? 'fa-wand-magic-sparkles' : 'fa-arrow-up-right-from-square',
        actionType: isOpenAiStyleApi ? 'apply-preset' : 'open-tab',
        actionValue: isOpenAiStyleApi ? TLD_PRESET_NAME : 'left:api',
        secondaryActionLabel: 'Visit site',
        secondaryActionIcon: 'fa-arrow-up-right-from-square',
        secondaryActionType: 'open-link',
        secondaryActionValue: TLD_SITE_URL,
        tertiaryActionLabel: 'Discord Pals',
        tertiaryActionIcon: 'fa-arrow-up-right-from-square',
        tertiaryActionType: 'open-link',
        tertiaryActionValue: TLD_DISCORD_PALS_URL,
    };
}

function buildStarterPackItems() {
    return {
        preInstalled: [
            buildPresetStarterPackItem(),
            buildGeechanStarterPackItem(),
            buildTldStarterPackItem(),
        ],
        optionalOfficial: [
            buildExtensionStarterPackItem({
                title: 'Dialogue Colors',
                body: 'A highly customizable extension that color-codes each character based on current chat context and certain parameters. Uses an LLM generation to write persistent <font color> tags into chat text, or can use a local DOM-only engine to color rendered dialogue without changing saved messages.',
                icon: 'fa-palette',
                extensionName: STARTER_PACK_EXTENSIONS.dialogueColors.id,
            }),
            buildExtensionStarterPackItem({
                title: 'CSS Snippets',
                body: 'Simply adds a UI to manage custom CSS snippets. Snippets can be globally activated, linked to a specific theme, or linked to a specific chat (character / group).',
                icon: 'fa-palette',
                extensionName: STARTER_PACK_EXTENSIONS.cssSnippets.id,
            }),
            buildExtensionStarterPackItem({
                title: 'Moonlit Echoes Theme',
                body: 'A popular CSS theme originally designed for SillyTavern with a clean and modern design, adapted for use in SillyBunny.',
                icon: 'fa-moon',
                extensionName: STARTER_PACK_EXTENSIONS.moonlitEchoes.id,
            }),
            buildExtensionStarterPackItem({
                title: 'Prompting Lab',
                body: 'A troubleshooting extension used to diagnose the contents of your system prompt before it\'s sent to an LLM. Shows the persona, preset, connection profile, message contents, and more.',
                icon: 'fa-flask',
                extensionName: STARTER_PACK_EXTENSIONS.promptingLab.id,
            }),
            buildExtensionStarterPackItem({
                title: 'World Info Lab',
                body: 'A troubleshooting extension used to diagnose your lorebooks and world information before it\'s sent to an LLM. Useful if you need to find problematic entries.',
                icon: 'fa-book-atlas',
                extensionName: STARTER_PACK_EXTENSIONS.worldInfoLab.id,
            }),
            buildExtensionStarterPackItem({
                title: 'Regex Agent Themes',
                body: 'Adds several themes for the Agents and companions panels found in our In-Chat Agents feature.',
                icon: 'fa-paintbrush',
                extensionName: STARTER_PACK_EXTENSIONS.regexAgentThemes.id,
            }),
            buildExtensionStarterPackItem({
                title: 'Bot Searcher',
                body: 'Adds a character-card browser to SillyBunny. It can search supported card sites, show the details each site provides, and import any selected card. Note: this requires a server plugin to use.',
                icon: 'fa-magnifying-glass',
                extensionName: STARTER_PACK_EXTENSIONS.botSearcher.id,
            }),
            buildExtensionStarterPackItem({
                title: 'Macro Enhanced',
                body: 'Adds a wide variety of new, heavily customizable macros to SillyBunny\'s STScript engine. View all macros with /help macros.',
                icon: 'fa-code',
                extensionName: STARTER_PACK_EXTENSIONS.macroEnhanced.id,
            }),
            buildExtensionStarterPackItem({
                title: 'Prompt Tags',
                body: 'Adds automatic XML tags to SillyBunny\'s prompt sections. This can be useful if you want to implement XML prompting without modifying any existing presets, personas, lorebooks, or character cards.',
                icon: 'fa-tags',
                extensionName: STARTER_PACK_EXTENSIONS.promptTags.id,
            }),
        ],
        optionalUnofficial: [
            buildExtensionStarterPackItem({
                title: 'Summary Sharder',
                body: 'An extension that captures chat history before it falls out of context. It summarizes message ranges into structured "Memory Shards" with 16 labeled sections, manages message visibility, and routes output to system messages or lorebook entries - so nothing important is forgotten. In effect: this helps manage long-term context for LLMs.',
                icon: 'fa-brain',
                extensionName: STARTER_PACK_EXTENSIONS.summarySharder.id,
            }),
            buildExtensionStarterPackItem({
                title: 'Group Utilities',
                body: 'A compilation of utilities used to enhance group chats and their capabilities.',
                icon: 'fa-users',
                extensionName: STARTER_PACK_EXTENSIONS.groupUtilities.id,
            }),
            buildExtensionStarterPackItem({
                title: 'LALib',
                body: 'A library of STScript commands - a common dependency for many popular SillyTavern extensions.',
                icon: 'fa-toolbox',
                extensionName: STARTER_PACK_EXTENSIONS.laLib.id,
            }),
            buildExtensionStarterPackItem({
                title: 'ADHDBunny UI',
                body: 'An optional CSS theme for SillyBunny which further simplifies the graphical shell and user interface. Developed by Jimmy.',
                icon: 'fa-rabbit',
                extensionName: STARTER_PACK_EXTENSIONS.adhdBunnyUi.id,
            }),
        ],
    };
}

function buildWelcomeTemplateData(chats) {
    const activeDeckView = getInitialDeckView();
    const welcomePanelMode = getWelcomePanelMode();
    const tutorialStatus = getWelcomeUiPreference(tutorialStatusKey) || '';
    const storedTutorialIndex = Number.parseInt(getWelcomeUiPreference(tutorialIndexKey) || '0', 10) || 0;
    const tutorialIndex = clamp(storedTutorialIndex, 0, WELCOME_TUTORIAL_STEPS.length - 1);

    return {
        chats,
        empty: !chats.length,
        version: displayVersion,
        more: chats.length > getRecentChatsSettings().collapsedDisplayed,
        activeDeckView,
        welcomePanelMode,
        welcomePanelFull: welcomePanelMode === WELCOME_PANEL_MODES.full,
        welcomePanelCompact: welcomePanelMode === WELCOME_PANEL_MODES.compact,
        welcomePanelListOnly: welcomePanelMode === WELCOME_PANEL_MODES.list,
        separateAgentRecentChats: shouldSeparateAgentRecentChats(),
        deckTabs: buildDeckTabs(activeDeckView),
        deckTourActive: activeDeckView === 'tour',
        deckBasicsActive: activeDeckView === 'basics',
        deckGuideActive: activeDeckView === 'guide',
        deckStarterActive: activeDeckView === 'starter',
        tutorialExpanded: tutorialStatus !== 'completed',
        tutorialIndex,
        tutorialSteps: buildTutorialSteps(tutorialIndex),
        guideCards: buildGuideCards(),
        bundledAssistants: buildBundledAssistantCards(),
        starterPackItems: buildStarterPackItems(),
    };
}

async function highlightLaunchpadItem(extensionId) {
    if (!extensionId) {
        return false;
    }

    let welcomePanel = document.querySelector('.welcomePanel');
    if (!(welcomePanel instanceof HTMLElement)) {
        await openWelcomeScreen({ force: true });
        welcomePanel = document.querySelector('.welcomePanel');
    }

    if (!(welcomePanel instanceof HTMLElement)) {
        return false;
    }

    setWelcomeDeckView(welcomePanel, 'starter');
    const selector = `.welcomeStarterPackCard[data-launchpad-extension="${CSS.escape(extensionId)}"]`;
    const card = welcomePanel.querySelector(selector);
    if (!(card instanceof HTMLElement)) {
        return false;
    }

    const panelRect = welcomePanel.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const delta = (cardRect.top - panelRect.top) - ((panelRect.height - cardRect.height) / 2);
    welcomePanel.scrollTo({
        top: Math.min(Math.max(welcomePanel.scrollTop + delta, 0), Math.max(0, welcomePanel.scrollHeight - welcomePanel.clientHeight)),
        behavior: 'smooth',
    });
    flashHighlight($(card), 1400);
    return true;
}

globalThis.SillyBunnyShell = /** @type {any} */ (globalThis.SillyBunnyShell || {});
globalThis.SillyBunnyShell.highlightLaunchpadItem = highlightLaunchpadItem;

/**
 * Gets the filter bucket used by the Recent Chats tabs.
 * @param {RecentChat} chat Recent chat data
 * @returns {'agent'|'group'|'conversation'|'individual'}
 */
function getRecentChatType(chat) {
    if (chat.is_agent) {
        return 'agent';
    }

    if (chat.is_group) {
        return 'group';
    }

    if (chat.is_conversation) {
        return 'conversation';
    }

    return 'individual';
}

/**
 * Gets the filter bucket for a rendered Recent Chat item.
 * @param {Element} item Recent chat element
 * @returns {'agent'|'group'|'conversation'|'individual'}
 */
function getRecentChatItemType(item) {
    if (item instanceof HTMLElement && ['agent', 'group', 'conversation', 'individual'].includes(item.dataset.recentChatType || '')) {
        return /** @type {'agent'|'group'|'conversation'|'individual'} */ (item.dataset.recentChatType);
    }

    if (item.classList.contains('agent')) {
        return 'agent';
    }

    if (item.classList.contains('conversation')) {
        return 'conversation';
    }

    if (item.classList.contains('group')) {
        return 'group';
    }

    return 'individual';
}

/**
 * Applies the Recent Chats tab filter and per-filter collapsed state.
 * @param {HTMLElement} root Welcome panel root
 * @param {object} [options] Options
 * @param {boolean} [options.expanded] Whether all chats in the active filter should be shown
 */
function getExpandedRecentChatFilters(root) {
    return new Set((root.dataset.expandedRecentChatFilters || '').split(',').filter(Boolean));
}

function updateRecentChatFilterView(root, { expanded } = {}) {
    const filter = root.dataset.recentChatFilter || 'all';
    const expandedFilters = getExpandedRecentChatFilters(root);
    if (typeof expanded === 'boolean') {
        if (expanded) {
            expandedFilters.add(filter);
        } else {
            expandedFilters.delete(filter);
        }
        root.dataset.expandedRecentChatFilters = [...expandedFilters].join(',');
    }
    const filterExpanded = expandedFilters.has(filter);
    const chatItems = Array.from(root.querySelectorAll('.recentChat'));
    const { collapsedDisplayed } = getRecentChatsSettings();
    let matchingCount = 0;

    chatItems.forEach((chatItem) => {
        const chatType = getRecentChatItemType(chatItem);
        const matchesFilter = filter === 'all' || chatType === filter;
        const hiddenByLimit = matchesFilter && !filterExpanded && matchingCount >= collapsedDisplayed;

        if (matchesFilter) {
            matchingCount++;
        }

        chatItem.classList.toggle('recentChatFiltered', !matchesFilter);
        chatItem.classList.toggle('hidden', hiddenByLimit);
    });

    root.querySelectorAll('[data-recent-chat-empty-state="filtered"]').forEach((emptyState) => {
        emptyState.classList.toggle('displayNone', filter === 'all' || matchingCount > 0 || chatItems.length === 0);
    });

    root.querySelectorAll('button.showMoreChats').forEach((button) => {
        const hasMoreChats = matchingCount > collapsedDisplayed;
        const expandedAndVisible = filterExpanded && hasMoreChats;
        button.classList.toggle('displayNone', !hasMoreChats);
        button.classList.toggle('rotated', expandedAndVisible);
        button.setAttribute('aria-expanded', String(expandedAndVisible));
        button.setAttribute('title', expandedAndVisible ? t`Show less recent chats` : t`Show more recent chats`);
    });
}

function setRecentChatFilter(root, filter) {
    root.dataset.recentChatFilter = filter;
    root.querySelectorAll('[data-recent-chat-filter]').forEach((button) => {
        const active = button.getAttribute('data-recent-chat-filter') === filter;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    updateRecentChatFilterView(root);
}

function handleLinearNavigation(event, buttons, activeButton, activate) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || buttons.length === 0) {
        return;
    }

    event.preventDefault();
    const currentIndex = Math.max(0, buttons.indexOf(activeButton));
    const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
            ? buttons.length - 1
            : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    const nextButton = buttons[nextIndex];
    nextButton.focus();
    activate(nextButton);
}

function openShellTab(route) {
    // SillyBunny: accept historical launcher routes while opening relocated
    // World Info in the Characters panel instead of the old left shell.
    const normalizedRoute = route === 'left:world-info' ? 'characters:world-info' : route;
    const [shellKey, tabId] = String(normalizedRoute || '').split(':');

    if (!shellKey || !tabId) {
        return false;
    }

    if (globalThis.SillyBunnyShell?.openTab) {
        globalThis.SillyBunnyShell.openTab(shellKey, tabId);
        return true;
    }

    const fallbackRoute = {
        'left:presets': { selector: '#ai-config-button > .drawer-toggle', shellRoot: '#left-nav-panel' },
        'left:sampling': { selector: '#ai-config-button > .drawer-toggle', shellRoot: '#left-nav-panel', tabId: 'sampling' },
        'left:api': { selector: '#sys-settings-button > .drawer-toggle', shellRoot: '#left-nav-panel' },
        'left:agents': { selector: '#ai-config-button > .drawer-toggle', shellRoot: '#left-nav-panel', tabId: 'agents' },
        'characters:world-info': { selector: '#WI-SP-button > .drawer-toggle' },
        'right:settings': { selector: '#user-settings-button > .drawer-toggle', shellRoot: '#user-settings-block' },
        'right:extensions': { selector: '#extensions-settings-button > .drawer-toggle', shellRoot: '#user-settings-block' },
        'characters:persona': { selector: '#persona-management-button > .drawer-toggle' },
        'right:background': { selector: '#backgrounds-button > .drawer-toggle', shellRoot: '#user-settings-block' },
    }[normalizedRoute];

    if (!fallbackRoute) {
        return false;
    }

    const fallback = document.querySelector(fallbackRoute.selector);
    const shellRoot = fallbackRoute.shellRoot ? document.querySelector(fallbackRoute.shellRoot) : null;
    if (!(shellRoot instanceof HTMLElement) || !shellRoot.classList.contains('openDrawer')) {
        fallback?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    if (fallback && fallbackRoute.tabId) {
        window.requestAnimationFrame(() => {
            document.querySelector(`.sb-shell-tab[data-sb-tab="${fallbackRoute.tabId}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    }
    return Boolean(fallback);
}

function focusSendTextarea(sendTextArea, { skipIOS = false } = {}) {
    if (skipIOS && isIOSWebKitPlatform()) {
        return;
    }

    if (sendTextArea instanceof HTMLTextAreaElement) {
        sendTextArea.focus({ preventScroll: true });
    }
}

function prefillSendTextarea(sendTextArea, value, { skipIOSFocus = false } = {}) {
    if (!(sendTextArea instanceof HTMLTextAreaElement)) {
        return;
    }

    sendTextArea.value = value;
    sendTextArea.dispatchEvent(new Event('input', { bubbles: true }));
    focusSendTextarea(sendTextArea, { skipIOS: skipIOSFocus });
}

// SillyBunny divergence: suppress the legacy chat shell briefly while Conversation Mode takes over from welcome-screen recent-chat entry points.
const conversationWelcomeOpeningVisibilityKey = 'sbConversationWelcomeOpeningVisibility';

function setConversationWelcomeOpeningSuppressed(suppressed) {
    [document.getElementById('chat'), document.getElementById('form_sheld')].forEach((element) => {
        if (!(element instanceof HTMLElement)) {
            return;
        }

        if (suppressed) {
            if (!(conversationWelcomeOpeningVisibilityKey in element.dataset)) {
                element.dataset[conversationWelcomeOpeningVisibilityKey] = element.style.visibility || 'default';
            }
            element.style.visibility = 'hidden';
            return;
        }

        if (!(conversationWelcomeOpeningVisibilityKey in element.dataset)) {
            return;
        }

        const previousVisibility = element.dataset[conversationWelcomeOpeningVisibilityKey] || 'default';
        element.style.visibility = previousVisibility === 'default' ? '' : previousVisibility;
        delete element.dataset[conversationWelcomeOpeningVisibilityKey];
    });
}

function clearConversationWelcomeOpeningSuppressionAfterRender() {
    const clearSuppression = () => setConversationWelcomeOpeningSuppressed(false);
    if (typeof requestAnimationFrame !== 'function') {
        setTimeout(clearSuppression, 0);
        return;
    }

    requestAnimationFrame(() => requestAnimationFrame(clearSuppression));
}

async function refreshCharacterAvatarCache(avatar) {
    if (!avatar) {
        return;
    }

    const thumbnailUrl = getThumbnailUrl('avatar', avatar);

    try {
        await fetch(thumbnailUrl, { method: 'GET', cache: 'reload' });
        await fetch(`/characters/${encodeURIComponent(avatar)}`, { method: 'GET', cache: 'reload' });
    } catch (error) {
        console.warn(`Failed to refresh avatar cache for ${avatar}.`, error);
    }

    const cacheBustedThumbnailUrl = getThumbnailUrl('avatar', avatar, true);
    const avatarImages = document.querySelectorAll(`img[src^="${thumbnailUrl}"]`);

    for (const img of avatarImages) {
        if (img instanceof HTMLImageElement) {
            img.src = cacheBustedThumbnailUrl;
        }
    }
}

function setWelcomeDeckView(root, view, { persist = true } = {}) {
    if (!(root instanceof HTMLElement)) {
        return;
    }

    const safeView = isWelcomeDeckView(view) ? view : getInitialDeckView();

    root.dataset.activeDeckView = safeView;

    root.querySelectorAll('.welcomeDeckTab').forEach((button) => {
        const active = button.getAttribute('data-deck-target') === safeView;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
        button.setAttribute('tabindex', active ? '0' : '-1');
    });

    root.querySelectorAll('.welcomeDeckPanel').forEach((panel) => {
        const active = panel.getAttribute('data-deck-panel') === safeView;
        panel.classList.toggle('is-active', active);
        panel.toggleAttribute('hidden', !active);
        panel.setAttribute('aria-hidden', String(!active));
    });

    if (persist) {
        setWelcomeUiPreference(welcomeDeckViewKey, safeView);
    }
}

function setWelcomePanelMode(root, mode, { persist = true } = {}) {
    if (!(root instanceof HTMLElement)) {
        return;
    }

    const safeMode = isWelcomePanelMode(mode) ? mode : WELCOME_PANEL_MODES.full;

    root.dataset.homePanelMode = safeMode;
    root.classList.toggle('welcomePanel--compact', safeMode === WELCOME_PANEL_MODES.compact);
    root.classList.toggle('welcomePanel--listOnly', safeMode === WELCOME_PANEL_MODES.list);

    root.querySelectorAll('[data-welcome-panel-mode-target]').forEach((button) => {
        const isActive = button.getAttribute('data-welcome-panel-mode-target') === safeMode;
        button.classList.toggle('is-active', isActive);

        if (button instanceof HTMLButtonElement) {
            button.setAttribute('aria-pressed', String(isActive));
        }
    });

    if (persist) {
        setWelcomeUiPreference(welcomePanelModeKey, safeMode);
    }
}

async function applyOpenAiPreset(name) {
    if (main_api !== 'openai') {
        openShellTab('left:api');
        return false;
    }

    const presetManager = getPresetManager('openai');
    const presetValue = presetManager?.findPreset(name);

    if (!presetManager || !presetValue) {
        openShellTab('left:presets');
        return false;
    }

    await presetManager.selectPreset(presetValue);
    saveSettingsDebounced();
    return true;
}

async function installStarterPackExtension(extensionName, global) {
    const extensionConfig = getStarterPackExtensionConfig(extensionName);
    if (!extensionConfig) {
        return false;
    }

    try {
        const installed = await installExtension(extensionConfig.repoUrl, global && isAdmin());
        if (!installed) {
            return false;
        }

        const installedExtension = findExtension(extensionName);
        if (!installedExtension) {
            return false;
        }

        if (!installedExtension.enabled) {
            await enableExtension(installedExtension.name, false);
        }

        location.reload();
        return true;
    } catch (error) {
        console.error(`Failed to install starter pack extension "${extensionName}".`, error);
        return false;
    }
}

async function removeStarterPackExtension(extensionName) {
    const extension = findExtension(extensionName);
    if (!extension) {
        toastr.warning(t`Extension is no longer installed.`);
        return;
    }

    if (getExtensionType(extension.name) === 'global' && !isAdmin()) {
        toastr.error(t`You don't have permission to delete global extensions.`);
        return;
    }

    const confirmed = await callGenericPopup(
        t`Are you sure you want to remove ${extension.name}?`,
        POPUP_TYPE.CONFIRM,
    );
    if (!confirmed) {
        return;
    }

    await deleteExtension(extension.name);
}

function setTutorialUiState(panel, index, expanded, { persist = true } = {}) {
    if (!(panel instanceof HTMLElement)) {
        return;
    }

    const steps = Array.from(panel.querySelectorAll('.welcomeTourStep'));
    const progressButtons = Array.from(panel.querySelectorAll('.welcomeTourProgressButton'));
    const safeIndex = Math.max(0, Math.min(index, steps.length - 1));
    const nextButton = panel.querySelector('.tutorialNext');
    const previousButton = panel.querySelector('.tutorialPrev');
    const nextLabel = nextButton?.querySelector('span');

    panel.dataset.tutorialIndex = String(safeIndex);
    panel.dataset.tutorialExpanded = String(expanded);
    panel.classList.toggle('tutorialCollapsed', !expanded);
    if (persist) {
        setWelcomeUiPreference(tutorialIndexKey, String(safeIndex));
    }

    steps.forEach((step, stepIndex) => {
        const active = stepIndex === safeIndex;
        step.classList.toggle('is-active', active);
        step.toggleAttribute('hidden', !active);
        step.setAttribute('aria-hidden', String(!active));
    });

    progressButtons.forEach((button, buttonIndex) => {
        const active = buttonIndex === safeIndex;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
        if (active) {
            button.setAttribute('aria-current', 'step');
        } else {
            button.removeAttribute('aria-current');
        }
    });

    if (previousButton instanceof HTMLButtonElement) {
        previousButton.disabled = safeIndex === 0;
    }

    if (nextLabel) {
        nextLabel.textContent = safeIndex >= steps.length - 1 ? 'Finish tour' : 'Next';
    }
}

async function openRoleplayWorkspaceFromWelcome() {
    const conversationModule = await import('./sillybunny-conversation.js');
    const avatar = conversationModule.getRoleplayAvatarForWelcome?.();
    const characterId = avatar ? characters.findIndex(character => character?.avatar === avatar) : -1;
    if (characterId === -1) {
        toastr.warning('Pick or import a character before opening Roleplay Mode.');
        return false;
    }

    if (!await selectCharacterById(characterId, { switchMenu: false })) {
        return false;
    }

    conversationModule.disableConversationModeForCurrentCharacter?.({ focusRoleplay: false });
    document.getElementById('send_textarea')?.focus?.({ preventScroll: false });
    return true;
}

function dismissTutorial(panel, status) {
    if (status) {
        setWelcomeUiPreference(tutorialStatusKey, status);
    }

    const currentIndex = Number.parseInt(panel.dataset.tutorialIndex || '0', 10) || 0;
    setTutorialUiState(panel, currentIndex, false);
}

async function handleWelcomeAction(button, sendTextArea) {
    const action = button.dataset.action || '';
    const value = button.dataset.actionValue || '';
    const assistantId = button.dataset.assistantId || DEFAULT_BUNDLED_ASSISTANT_ID;
    const welcomePanel = button.closest('.welcomePanel') || document.querySelector('.welcomePanel');
    const tutorialPanel = button.closest('.welcomeTourPanel') || document.querySelector('.welcomeTourPanel');

    switch (action) {
        case 'open-tab':
            openShellTab(value);
            break;
        case 'open-deck-view':
            if (welcomePanel instanceof HTMLElement) {
                setWelcomeDeckView(welcomePanel, value);
            }
            break;
        case 'enable-extension':
            await enableExtension(value);
            break;
        case 'remove-starter-extension':
            await removeStarterPackExtension(value);
            break;
        case 'install-starter-extension-global':
            await installStarterPackExtension(value, true);
            break;
        case 'install-starter-extension-user':
            await installStarterPackExtension(value, false);
            break;
        case 'apply-preset':
            if (await applyOpenAiPreset(value)) {
                await refreshWelcomeScreen();
            }
            break;
        case 'assistant-prompt':
            focusSendTextarea(sendTextArea);
            await openBundledAssistantCard(assistantId);
            prefillSendTextarea(sendTextArea, value, { skipIOSFocus: true });
            break;
        case 'open-assistant':
            focusSendTextarea(sendTextArea);
            await openBundledAssistantCard(assistantId);
            focusSendTextarea(sendTextArea, { skipIOS: true });
            break;
        case 'open-temporary-chat':
            focusSendTextarea(sendTextArea);
            await newAssistantChat({ temporary: true });
            focusSendTextarea(sendTextArea, { skipIOS: true });
            break;
        case 'open-roleplay':
            await openRoleplayWorkspaceFromWelcome();
            break;
        case 'open-conversation': {
            const conversationModule = await import('./sillybunny-conversation.js');
            conversationModule.openConversationWorkspaceFromWelcome?.();
            break;
        }
        case 'open-characters-menu':
            globalThis.SillyBunnyShell?.openCharacters?.();
            break;
        case 'open-global-search':
            globalThis.SillyBunnyShell?.openGlobalSearch?.({ focusInput: true });
            break;
        case 'open-import-characters': {
            globalThis.SillyBunnyShell?.openCharacters?.();
            const importButton = document.getElementById('character_import_button')
                || document.getElementById('character_import_paste_button')
                || document.querySelector('.open_characters_library');
            importButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            break;
        }
        case 'open-sample-characters':
            document.querySelector('.open_characters_library')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            break;
        case 'replay-tutorial':
            setWelcomeUiPreference(tutorialStatusKey, '');
            if (welcomePanel instanceof HTMLElement) {
                setWelcomeDeckView(welcomePanel, 'tour');
            }
            if (tutorialPanel instanceof HTMLElement) {
                setTutorialUiState(tutorialPanel, 0, true);
            }
            break;
        case 'open-link':
            if (value) {
                window.open(value, '_blank', 'noopener,noreferrer');
            }
            break;
    }
}

/**
 * Opens a welcome screen if no chat is currently active.
 * @param {object} param Additional parameters
 * @param {boolean} [param.force] If true, forces clearing of the welcome screen.
 * @param {boolean} [param.expand] If true, expands the recent chats section.
 * @returns {Promise<void>}
 */
export async function openWelcomeScreen({ force = false, expand = false } = {}) {
    const currentChatId = getCurrentChatId();
    if (currentChatId !== undefined || (chat.length > 0 && !force)) {
        return;
    }

    const recentChats = await getRecentChats();
    const chatAfterFetch = getCurrentChatId();
    if (chatAfterFetch !== currentChatId) {
        console.debug('Chat changed while fetching recent chats.');
        return;
    }

    if (chatAfterFetch === undefined && force) {
        console.debug('Forcing welcome screen open.');
        chat.splice(0, chat.length);
        $('#chat').empty();
    }

    await sendWelcomePanel(recentChats, expand);
}

/**
 * Sends the welcome panel to the chat.
 * @param {RecentChat[]} chats List of recent chats
 * @param {boolean} [expand=false] If true, expands the recent chats section
 */
async function sendWelcomePanel(chats, expand = false) {
    try {
        const chatElement = document.getElementById('chat');
        const sendTextArea = document.getElementById('send_textarea');
        if (!chatElement) {
            console.error('Chat element not found');
            return;
        }
        const templateData = buildWelcomeTemplateData(chats);
        const template = await renderTemplateAsync('/scripts/templates/welcomePanelOnboarding.html?v=20260805p', templateData, true, true, true);
        const fragment = document.createRange().createContextualFragment(template);
        const nextPanel = fragment.querySelector('.welcomePanel');
        fragment.querySelectorAll('.welcomePanel').forEach((root) => {
            root.querySelectorAll('[data-welcome-panel-mode-target]').forEach((button) => {
                button.addEventListener('click', () => {
                    setWelcomePanelMode(root, button.getAttribute('data-welcome-panel-mode-target') || WELCOME_PANEL_MODES.full);
                });
            });
            root.querySelectorAll('[data-recent-chat-filter]').forEach((button) => {
                button.addEventListener('click', () => {
                    const filter = button.getAttribute('data-recent-chat-filter') || 'all';
                    setRecentChatFilter(root, filter);
                });
            });
            root.querySelectorAll('.recentChatsSettings').forEach((button) => {
                button.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    await openRecentChatsSettingsPopup();
                });
            });

            const tutorialPanel = root.querySelector('.welcomeTourPanel');
            setWelcomePanelMode(root, root.dataset.homePanelMode || getWelcomePanelMode(), { persist: false });
            setWelcomeDeckView(root, root.dataset.activeDeckView || getInitialDeckView(), { persist: false });
            root.querySelectorAll('.welcomeDeckTab').forEach((button) => {
                const activateDeckTab = () => {
                    const targetView = button.getAttribute('data-deck-target') || '';
                    setWelcomeDeckView(root, targetView);

                    if (targetView === 'tour' && tutorialPanel instanceof HTMLElement) {
                        setWelcomeUiPreference(tutorialStatusKey, '');
                        const currentIndex = Number.parseInt(tutorialPanel.dataset.tutorialIndex || '0', 10) || 0;
                        setTutorialUiState(tutorialPanel, currentIndex, true);
                    }
                };
                button.addEventListener('click', activateDeckTab);
                button.addEventListener('keydown', (event) => {
                    const tabs = Array.from(root.querySelectorAll('.welcomeDeckTab'));
                    handleLinearNavigation(event, tabs, button, nextButton => nextButton.click());
                });
            });

            if (tutorialPanel instanceof HTMLElement) {
                setTutorialUiState(
                    tutorialPanel,
                    Number.parseInt(tutorialPanel.dataset.tutorialIndex || '0', 10) || 0,
                    tutorialPanel.dataset.tutorialExpanded !== 'false',
                    { persist: false },
                );

                tutorialPanel.querySelectorAll('.welcomeTourProgressButton').forEach((button) => {
                    const activateTutorialStep = () => {
                        const targetIndex = Number.parseInt(button.getAttribute('data-step-target') || '0', 10) || 0;
                        setTutorialUiState(tutorialPanel, targetIndex, true);
                    };
                    button.addEventListener('click', activateTutorialStep);
                    button.addEventListener('keydown', (event) => {
                        const buttons = Array.from(tutorialPanel.querySelectorAll('.welcomeTourProgressButton'));
                        handleLinearNavigation(event, buttons, button, nextButton => nextButton.click());
                    });
                });

                tutorialPanel.querySelector('.tutorialPrev')?.addEventListener('click', () => {
                    const currentIndex = Number.parseInt(tutorialPanel.dataset.tutorialIndex || '0', 10) || 0;
                    setTutorialUiState(tutorialPanel, currentIndex - 1, true);
                });

                tutorialPanel.querySelector('.tutorialNext')?.addEventListener('click', () => {
                    const currentIndex = Number.parseInt(tutorialPanel.dataset.tutorialIndex || '0', 10) || 0;
                    const lastIndex = tutorialPanel.querySelectorAll('.welcomeTourStep').length - 1;

                    if (currentIndex >= lastIndex) {
                        dismissTutorial(tutorialPanel, 'completed');
                        return;
                    }

                    setTutorialUiState(tutorialPanel, currentIndex + 1, true);
                });
            }
        });
        fragment.querySelectorAll('.welcomeActionButton').forEach((button) => {
            button.addEventListener('click', async (event) => {
                event.preventDefault();
                const isInstallAction = button.dataset.action === 'install-starter-extension-global'
                    || button.dataset.action === 'install-starter-extension-user';
                const starterCard = button.closest('.welcomeStarterPackCard');
                const installButtons = isInstallAction && starterCard
                    ? Array.from(starterCard.querySelectorAll('[data-action="install-starter-extension-global"], [data-action="install-starter-extension-user"]'))
                    : [];
                if (isInstallAction && button instanceof HTMLButtonElement) {
                    if (installButtons.some(installButton => installButton instanceof HTMLButtonElement && installButton.disabled)) {
                        return;
                    }
                    starterCard?.setAttribute('aria-busy', 'true');
                    installButtons.forEach((installButton) => {
                        if (installButton instanceof HTMLButtonElement) {
                            installButton.disabled = true;
                            installButton.classList.add('is-pending');
                        }
                    });
                }

                try {
                    await handleWelcomeAction(button, sendTextArea);
                } finally {
                    if (isInstallAction && button instanceof HTMLButtonElement && document.contains(button)) {
                        starterCard?.removeAttribute('aria-busy');
                        installButtons.forEach((installButton) => {
                            if (installButton instanceof HTMLButtonElement) {
                                installButton.disabled = false;
                                installButton.classList.remove('is-pending');
                            }
                        });
                    }
                }
            });
        });
        fragment.querySelectorAll('.recentChatOpen').forEach((button) => {
            button.addEventListener('click', () => {
                const item = button.closest('.recentChat');
                if (!(item instanceof HTMLElement)) {
                    return;
                }
                const avatarId = item.getAttribute('data-avatar');
                const groupId = item.getAttribute('data-group');
                const fileName = item.getAttribute('data-file');
                const isConversation = item.getAttribute('data-recent-chat-type') === 'conversation';
                if (isConversation && avatarId) {
                    const branchId = item.getAttribute('data-conversation-branch-id');
                    void openRecentConversationChat(avatarId, groupId, branchId);
                    return;
                }
                if (avatarId && fileName) {
                    void openRecentCharacterChat(avatarId, fileName);
                }
                if (groupId && fileName) {
                    void openRecentGroupChat(groupId, fileName);
                }
            });
        });
        fragment.querySelectorAll('button.showMoreChats').forEach((button) => {
            const showRecentChatsTitle = t`Show more recent chats`;
            const hideRecentChatsTitle = t`Show less recent chats`;

            button.setAttribute('title', button.classList.contains('rotated') ? hideRecentChatsTitle : showRecentChatsTitle);
            button.addEventListener('click', () => {
                const rotate = button.classList.contains('rotated');
                const root = button.closest('.welcomePanel');
                if (root instanceof HTMLElement) {
                    updateRecentChatFilterView(root, { expanded: !rotate });
                }
                button.setAttribute('title', rotate ? showRecentChatsTitle : hideRecentChatsTitle);
            });
        });
        fragment.querySelectorAll('button.openTemporaryChat').forEach((button) => {
            button.addEventListener('click', async () => {
                focusSendTextarea(sendTextArea);
                await newAssistantChat({ temporary: true });
                focusSendTextarea(sendTextArea, { skipIOS: true });
            });
        });
        fragment.querySelectorAll('.recentChat.group').forEach((groupChat) => {
            const groupId = groupChat.getAttribute('data-group');
            const group = groups.find(x => x.id === groupId);
            if (group) {
                const avatar = groupChat.querySelector('.avatar');
                if (!avatar) {
                    return;
                }
                const groupAvatar = getGroupAvatar(group);
                $(avatar).replaceWith(groupAvatar);
            }
        });
        fragment.querySelectorAll('.recentChat .renameChat').forEach((renameButton) => {
            renameButton.addEventListener('click', (event) => {
                event.stopPropagation();
                const chatItem = renameButton.closest('.recentChat');
                if (!chatItem) {
                    return;
                }
                const avatarId = chatItem.getAttribute('data-avatar');
                const groupId = chatItem.getAttribute('data-group');
                const fileName = chatItem.getAttribute('data-file');
                const branchId = chatItem.getAttribute('data-conversation-branch-id');
                const branchName = chatItem.getAttribute('data-conversation-branch-name');
                if (chatItem.getAttribute('data-recent-chat-type') === 'conversation') {
                    if (avatarId && branchId && branchName) {
                        const recentChat = chats.find(chat => chat.is_conversation
                            && chat.avatar === avatarId
                            && String(chat.group || '') === String(groupId || '')
                            && chat.conversation_branch_id === branchId);
                        void renameRecentConversationChat(avatarId, groupId, branchId, branchName, recentChat);
                    }
                    return;
                }
                if (avatarId && fileName) {
                    void renameRecentCharacterChat(avatarId, fileName);
                }
                if (groupId && fileName) {
                    void renameRecentGroupChat(groupId, fileName);
                }
            });
        });
        fragment.querySelectorAll('.recentChat .deleteChat').forEach((deleteButton) => {
            deleteButton.addEventListener('click', (event) => {
                event.stopPropagation();
                const chatItem = deleteButton.closest('.recentChat');
                if (!chatItem) {
                    return;
                }
                const avatarId = chatItem.getAttribute('data-avatar');
                const groupId = chatItem.getAttribute('data-group');
                const fileName = chatItem.getAttribute('data-file');
                const branchId = chatItem.getAttribute('data-conversation-branch-id');
                if (chatItem.getAttribute('data-recent-chat-type') === 'conversation') {
                    if (avatarId && branchId) {
                        const recentChat = chats.find(chat => chat.is_conversation
                            && chat.avatar === avatarId
                            && String(chat.group || '') === String(groupId || '')
                            && chat.conversation_branch_id === branchId);
                        void deleteRecentConversationChat(avatarId, groupId, branchId, recentChat);
                    }
                    return;
                }
                if (avatarId && fileName) {
                    void deleteRecentCharacterChat(avatarId, fileName);
                }
                if (groupId && fileName) {
                    void deleteRecentGroupChat(groupId, fileName);
                }
            });
        });
        fragment.querySelectorAll('.recentChat .pinChat').forEach((pinButton) => {
            pinButton.addEventListener('click', async (event) => {
                event.stopPropagation();
                const chatItem = pinButton.closest('.recentChat');
                if (!chatItem) {
                    return;
                }
                const avatarId = chatItem.getAttribute('data-avatar');
                const groupId = chatItem.getAttribute('data-group');
                const fileName = chatItem.getAttribute('data-file');
                const branchId = chatItem.getAttribute('data-conversation-branch-id');
                const isConversation = chatItem.getAttribute('data-recent-chat-type') === 'conversation';
                const recentChat = chats.find(c => isConversation
                    ? c.is_conversation && c.avatar === avatarId && String(c.group || '') === String(groupId || '') && c.conversation_branch_id === branchId
                    : c.chat_name === fileName && ((c.is_group && c.group === groupId) || (!c.is_group && c.avatar === avatarId)));
                if (!recentChat) {
                    console.error('Recent chat not found for pinning.');
                    return;
                }
                const currentlyPinned = PinnedChatsManager.isPinned(recentChat);
                PinnedChatsManager.toggle(recentChat, !currentlyPinned);
                await refreshWelcomeScreen({ flashChat: recentChat });
            });
        });
        const existingPanel = chatElement.querySelector('.welcomePanel');
        if (existingPanel && nextPanel) {
            existingPanel.replaceWith(nextPanel);
        } else if (nextPanel) {
            chatElement.append(nextPanel);
        }
        chatElement.querySelectorAll('.welcomePanel').forEach((root) => {
            if (root instanceof HTMLElement) {
                updateRecentChatFilterView(root);
            }
        });
        window.SillyBunnyFrontendIcon?.apply?.();
        if (expand) {
            chatElement.querySelectorAll('button.showMoreChats').forEach((button) => {
                if (button instanceof HTMLButtonElement) {
                    button.click();
                }
            });
        }
    } catch (error) {
        console.error('Welcome screen error:', error);
    }
}

/**
 * Opens a recent character chat.
 * @param {string} avatarId Avatar file name
 * @param {string} fileName Chat file name
 */
async function openRecentCharacterChat(avatarId, fileName) {
    const characterId = characters.findIndex(x => x.avatar === avatarId);
    if (characterId === -1) {
        console.error(`Character not found for avatar ID: ${avatarId}`);
        return;
    }

    try {
        const selected = await selectCharacterById(characterId);
        if (!selected) {
            toastr.warning(t`Failed to open recent chat. See console for details.`);
            return;
        }
        setActiveCharacter(avatarId);
        saveSettingsDebounced();
        const currentChatId = getCurrentChatId();
        if (currentChatId === fileName) {
            console.debug(`Chat ${fileName} is already open.`);
            return;
        }
        await openCharacterChat(fileName);
    } catch (error) {
        console.error('Error opening recent chat:', error);
        toastr.error(t`Failed to open recent chat. See console for details.`);
    }
}

/**
 * Opens a character in Conversation Mode from the welcome page.
 * @param {string} avatarId Avatar file name
 * @param {string} groupId Group ID, when opening a group-scoped Conversation
 * @param {string} branchId Conversation branch ID
 */
async function openRecentConversationChat(avatarId, groupId = '', branchId = '') {
    const characterId = characters.findIndex(x => x.avatar === avatarId);
    if (characterId === -1) {
        console.error(`Character not found for avatar ID: ${avatarId}`);
        return;
    }

    try {
        setConversationWelcomeOpeningSuppressed(true);
        const conversationModule = await import('./sillybunny-conversation.js');
        const opened = conversationModule.openConversationWorkspaceForAvatar?.(avatarId, {
            branchId,
            groupId: groupId || null,
            showToast: false,
        });
        if (!opened) {
            setConversationWelcomeOpeningSuppressed(false);
            toastr.warning(t`Failed to open Conversation Mode for this chat.`);
            return;
        }
        clearConversationWelcomeOpeningSuppressionAfterRender();
    } catch (error) {
        setConversationWelcomeOpeningSuppressed(false);
        console.error('Error opening conversation chat:', error);
        toastr.error(t`Failed to open conversation chat. See console for details.`);
    }
}

/**
 * Renames a Conversation Mode branch from the welcome page.
 * @param {string} avatarId Avatar file name
 * @param {string} groupId Group ID, when renaming a group-scoped Conversation
 * @param {string} branchId Conversation branch ID
 * @param {string} branchName Current branch name
 * @param {RecentChat|undefined} recentChat Recent chat record
 */
async function renameRecentConversationChat(avatarId, groupId, branchId, branchName, recentChat) {
    try {
        const popupText = await renderTemplateAsync('chatRename');
        const newName = await callGenericPopup(popupText, POPUP_TYPE.INPUT, branchName);
        if (!newName || typeof newName !== 'string' || newName === branchName) {
            return;
        }

        const conversationModule = await import('./sillybunny-conversation.js');
        const renamed = conversationModule.renameConversationBranch?.(avatarId, branchId, newName, { groupId });
        if (!renamed) {
            toastr.warning(t`Failed to rename Conversation chat.`);
            return;
        }

        if (recentChat && !groupId) {
            PinnedChatsManager.rename(recentChat, newName.trim());
        }
        await refreshWelcomeScreen();
        toastr.success(t`Chat renamed.`);
    } catch (error) {
        console.error('Error renaming recent Conversation chat:', error);
        toastr.error(t`Failed to rename Conversation chat. See console for details.`);
    }
}

/**
 * Deletes a Conversation Mode branch from the welcome page.
 * @param {string} avatarId Avatar file name
 * @param {string} groupId Group ID, when deleting a group-scoped Conversation
 * @param {string} branchId Conversation branch ID
 * @param {RecentChat|undefined} recentChat Recent chat record
 */
async function deleteRecentConversationChat(avatarId, groupId, branchId, recentChat) {
    try {
        const confirm = await callGenericPopup(t`Delete the Chat File?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            return;
        }

        const conversationModule = await import('./sillybunny-conversation.js');
        const result = conversationModule.deleteConversationWelcomeBranch?.(avatarId, branchId, { groupId });
        const deleted = Boolean(result?.deleted);
        if (!deleted) {
            toastr.warning(t`Failed to delete Conversation chat.`);
            return;
        }

        if (recentChat) {
            PinnedChatsManager.remove(recentChat);
        }
        await refreshWelcomeScreen();
        if (!result.reset) {
            toastr.success(t`Chat deleted.`);
        }
    } catch (error) {
        console.error('Error deleting recent Conversation chat:', error);
        toastr.error(t`Failed to delete Conversation chat. See console for details.`);
    }
}

/**
 * Opens a recent group chat.
 * @param {string} groupId Group ID
 * @param {string} fileName Chat file name
 */
async function openRecentGroupChat(groupId, fileName) {
    const group = groups.find(x => x.id === groupId);
    if (!group) {
        console.error(`Group not found for ID: ${groupId}`);
        return;
    }

    try {
        const selected = await openGroupById(groupId);
        if (!selected) {
            toastr.warning(t`Failed to open recent group chat. See console for details.`);
            return;
        }
        setActiveGroup(groupId);
        saveSettingsDebounced();
        const currentChatId = getCurrentChatId();
        if (currentChatId === fileName) {
            console.debug(`Chat ${fileName} is already open.`);
            return;
        }
        await openGroupChat(groupId, fileName);
    } catch (error) {
        console.error('Error opening recent group chat:', error);
        toastr.error(t`Failed to open recent group chat. See console for details.`);
    }
}

/**
 * Renames a recent character chat.
 * @param {string} avatarId Avatar file name
 * @param {string} fileName Chat file name
 */
async function renameRecentCharacterChat(avatarId, fileName) {
    const characterId = characters.findIndex(x => x.avatar === avatarId);
    if (characterId === -1) {
        console.error(`Character not found for avatar ID: ${avatarId}`);
        return;
    }
    try {
        const popupText = await renderTemplateAsync('chatRename');
        const newName = await callGenericPopup(popupText, POPUP_TYPE.INPUT, fileName);
        if (!newName || typeof newName !== 'string' || newName === fileName) {
            console.log('No new name provided, aborting');
            return;
        }
        await renameGroupOrCharacterChat({
            characterId: String(characterId),
            oldFileName: fileName,
            newFileName: newName,
            loader: false,
        });
        await refreshWelcomeScreen();
        toastr.success(t`Chat renamed.`);
    } catch (error) {
        console.error('Error renaming recent character chat:', error);
        toastr.error(t`Failed to rename recent chat. See console for details.`);
    }
}

/**
 * Renames a recent group chat.
 * @param {string} groupId Group ID
 * @param {string} fileName Chat file name
 */
async function renameRecentGroupChat(groupId, fileName) {
    const group = groups.find(x => x.id === groupId);
    if (!group) {
        console.error(`Group not found for ID: ${groupId}`);
        return;
    }
    try {
        const popupText = await renderTemplateAsync('chatRename');
        const newName = await callGenericPopup(popupText, POPUP_TYPE.INPUT, fileName);
        if (!newName || newName === fileName) {
            console.log('No new name provided, aborting');
            return;
        }
        await renameGroupOrCharacterChat({
            groupId: String(groupId),
            oldFileName: fileName,
            newFileName: String(newName),
            loader: false,
        });
        await refreshWelcomeScreen();
        toastr.success(t`Group chat renamed.`);
    } catch (error) {
        console.error('Error renaming recent group chat:', error);
        toastr.error(t`Failed to rename recent group chat. See console for details.`);
    }
}

/**
 * Deletes a recent character chat.
 * @param {string} avatarId Avatar file name
 * @param {string} fileName Chat file name
 */
async function deleteRecentCharacterChat(avatarId, fileName) {
    const characterId = characters.findIndex(x => x.avatar === avatarId);
    if (characterId === -1) {
        console.error(`Character not found for avatar ID: ${avatarId}`);
        return;
    }
    try {
        const confirm = await callGenericPopup(t`Delete the Chat File?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            console.log('Deletion cancelled by user');
            return;
        }
        const deleted = await deleteCharacterChatByName(String(characterId), fileName);
        if (!deleted) {
            return;
        }
        PinnedChatsManager.removeDeleted({ avatar: avatarId, fileName });
        await refreshWelcomeScreen();
        toastr.success(t`Chat deleted.`);
    } catch (error) {
        console.error('Error deleting recent character chat:', error);
        toastr.error(t`Failed to delete recent chat. See console for details.`);
    }
}

/**
 * Deletes a recent group chat.
 * @param {string} groupId Group ID
 * @param {string} fileName Chat file name
 */
async function deleteRecentGroupChat(groupId, fileName) {
    const group = groups.find(x => x.id === groupId);
    if (!group) {
        console.error(`Group not found for ID: ${groupId}`);
        return;
    }
    try {
        const confirm = await callGenericPopup(t`Delete the Chat File?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            console.log('Deletion cancelled by user');
            return;
        }
        const deleted = await deleteGroupChatByName(groupId, fileName);
        if (!deleted) {
            return;
        }
        PinnedChatsManager.removeDeleted({ group: groupId, fileName });
        await refreshWelcomeScreen();
        toastr.success(t`Group chat deleted.`);
    } catch (error) {
        console.error('Error deleting recent group chat:', error);
        toastr.error(t`Failed to delete recent group chat. See console for details.`);
    }
}

/**
 * Reopens the welcome screen and restores the scroll position.
 * @param {object} param Additional parameters
 * @param {RecentChat} [param.flashChat] Recent chat to flash (if any)
 * @returns {Promise<void>}
 */
async function refreshWelcomeScreen({ flashChat = null } = {}) {
    const chatElement = document.getElementById('chat');
    if (!chatElement) {
        console.error('Chat element not found');
        return;
    }

    const scrollTop = chatElement.scrollTop;
    const scrollHeight = chatElement.scrollHeight;
    const currentPanel = chatElement.querySelector('.welcomePanel');
    const recentChatFilter = currentPanel instanceof HTMLElement ? currentPanel.dataset.recentChatFilter || 'all' : 'all';
    const expandedRecentChatFilters = currentPanel instanceof HTMLElement ? currentPanel.dataset.expandedRecentChatFilters || '' : '';

    await openWelcomeScreen({ force: true });

    const nextPanel = chatElement.querySelector('.welcomePanel');
    if (nextPanel instanceof HTMLElement) {
        nextPanel.dataset.recentChatFilter = recentChatFilter;
        nextPanel.dataset.expandedRecentChatFilters = expandedRecentChatFilters;
        nextPanel.querySelectorAll('[data-recent-chat-filter]').forEach((button) => {
            const active = button.getAttribute('data-recent-chat-filter') === recentChatFilter;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        updateRecentChatFilterView(nextPanel);
    }

    // Restore scroll position or flash specific chat
    if (flashChat) {
        const recentChats = Array.from(chatElement.querySelectorAll('.recentChat'));
        const chatToFlash = recentChats.find(el => {
            const file = el.getAttribute('data-file');
            const group = el.getAttribute('data-group');
            const avatar = el.getAttribute('data-avatar');
            return file === flashChat.chat_name &&
                ((flashChat.is_group && group === flashChat.group) || (!flashChat.is_group && avatar === flashChat.avatar));
        });
        if (chatToFlash instanceof HTMLElement) {
            if (!isElementInViewport(chatToFlash)) {
                chatElement.scrollTop = chatToFlash.offsetTop - chatElement.offsetTop - (chatToFlash.clientHeight / 2);
            }
            flashHighlight($(chatToFlash), 1000);
        }
    } else {
        // Restore scroll position
        chatElement.scrollTop = scrollTop + (chatElement.scrollHeight - scrollHeight);
    }
}

/**
 * Opens a popup to configure recent chats settings.
 */
async function openRecentChatsSettingsPopup() {
    const settings = getRecentChatsSettings();

    const MIN_CHATS = 1;
    const MAX_CHATS = 1000;

    /** @type {import('./popup.js').CustomPopupInput} */
    const maxRecentChatsInput = {
        id: 'maxRecentChats',
        type: 'number',
        label: t`Max recent chats`,
        tooltip: t`${MIN_CHATS} - ${MAX_CHATS}`,
        defaultState: String(settings.maxDisplayed),
        min: MIN_CHATS,
        max: MAX_CHATS,
        step: 1,
    };

    /** @type {import('./popup.js').CustomPopupInput} */
    const collapsedRecentChatsInput = {
        id: 'collapsedRecentChats',
        type: 'number',
        label: t`Collapsed recent chats`,
        tooltip: t`${MIN_CHATS} - ${MAX_CHATS}`,
        defaultState: String(settings.collapsedDisplayed),
        min: MIN_CHATS,
        max: MAX_CHATS,
        step: 1,
    };

    await callGenericPopup(t`Recent Chats Settings`, POPUP_TYPE.CONFIRM, null, {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        customInputs: [maxRecentChatsInput, collapsedRecentChatsInput],
        onClose: (popup) => {
            if (!popup.result) {
                return;
            }

            const maxInputValue = popup.inputResults.get(maxRecentChatsInput.id)?.toString() ?? String(DEFAULT_MAX_DISPLAYED);
            const collapsedInputValue = popup.inputResults.get(collapsedRecentChatsInput.id)?.toString() ?? String(DEFAULT_COLLAPSED_DISPLAYED);

            const newMax = clamp(parseInt(maxInputValue) || DEFAULT_MAX_DISPLAYED, maxRecentChatsInput.min, maxRecentChatsInput.max);
            const newCollapsed = clamp(parseInt(collapsedInputValue) || DEFAULT_COLLAPSED_DISPLAYED, collapsedRecentChatsInput.min, newMax);

            saveRecentChatsSettings({ maxDisplayed: newMax, collapsedDisplayed: newCollapsed });
        },
    });

    await refreshWelcomeScreen();
}

/**
 * Gets the list of recent chats from the server.
 * @returns {Promise<RecentChat[]>} List of recent chats
 *
 * @typedef {object} RecentChat
 * @property {string} file_name Name of the chat file
 * @property {string} chat_name Name of the chat (without extension)
 * @property {string} file_size Size of the chat file
 * @property {number} chat_items Number of items in the chat
 * @property {string} mes Last message content
 * @property {string} last_mes Timestamp of the last message
 * @property {string} avatar Avatar URL
 * @property {string} char_thumbnail Thumbnail URL
 * @property {string} char_name Character or group name
 * @property {string} date_short Date in short format
 * @property {string} date_long Date in long format
 * @property {string} group Group ID (if applicable)
 * @property {boolean} is_group Indicates if the chat is a group chat
 * @property {boolean} hidden Chat will be hidden by default
 * @property {boolean} pinned Indicates if the chat is pinned
 * @property {boolean} is_agent Indicates if the chat contains Agent-authored edits or transform history
 * @property {boolean} [is_conversation] Indicates if the chat is a Conversation Mode branch
 * @property {string} [conversation_branch_id] Conversation Mode branch ID
 * @property {string} [conversation_branch_name] Conversation Mode branch name
 */
function shouldSeparateAgentRecentChats() {
    return Boolean(extension_settings?.inChatAgents?.globalSettings?.separateRecentChats);
}

function isAgentRecentChat(chatData) {
    const metadata = chatData?.chat_metadata;
    if (metadata?.inChatAgents || metadata?.agentChat || metadata?.isAgentChat) {
        return true;
    }

    const messages = Array.isArray(chatData?.preview_messages) ? chatData.preview_messages : [];
    return messages.some(message => Boolean(
        message?.extra?.[AGENT_MESSAGE_EXTRA_KEY] ||
        message?.extra?.[AGENT_PROMPT_TRANSFORM_HISTORY_KEY],
    ));
}

async function getRecentChats() {
    const settings = getRecentChatsSettings();
    const finalizeRecentChats = chats => chats
        .slice(0, settings.maxDisplayed)
        .map((recentChat, index) => ({
            ...recentChat,
            hidden: index >= settings.collapsedDisplayed,
            pinned: PinnedChatsManager.isPinned(recentChat),
        }));
    const getConversationChats = async () => {
        try {
            const conversationModule = await import('./sillybunny-conversation.js');
            const conversationChats = conversationModule.getConversationWelcomeChats?.({ max: settings.maxDisplayed }) || [];
            return conversationChats;
        } catch (error) {
            console.warn('Failed to load Conversation Mode recent chats', error);
            return [];
        }
    };
    const response = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ max: settings.maxDisplayed, pinned: PinnedChatsManager.getAll(), metadata: shouldSeparateAgentRecentChats(), previewMessages: shouldSeparateAgentRecentChats() ? 8 : 0 }),
        cache: 'no-cache',
    });

    if (!response.ok) {
        console.warn('Failed to fetch recent character chats');
        return finalizeRecentChats(await getConversationChats());
    }

    /** @type {RecentChat[]} */
    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
        return finalizeRecentChats(await getConversationChats());
    }

    const dataWithEntities = data
        .map(chat => ({ chat, character: characters.find(x => x.avatar === chat.avatar), group: groups.find(x => x.id === chat.group) }))
        .filter(t => t.character || t.group)
        .sort((a, b) => {
            const isAPinned = PinnedChatsManager.isPinned(a.chat);
            const isBPinned = PinnedChatsManager.isPinned(b.chat);
            const momentComparison = sortMoments(timestampToMoment(a.chat.last_mes), timestampToMoment(b.chat.last_mes));

            if (isAPinned && !isBPinned) {
                return -1;
            }
            if (!isAPinned && isBPinned) {
                return 1;
            }

            return momentComparison;
        });

    dataWithEntities.forEach(({ chat, character, group }) => {
        const chatTimestamp = timestampToMoment(chat.last_mes);
        chat.char_name = character?.name || group?.name || '';
        chat.date_short = chatTimestamp.format('l');
        chat.date_long = chatTimestamp.format('LL LT');
        chat.chat_name = chat.file_name.replace('.jsonl', '');
        chat.char_thumbnail = character ? getThumbnailUrl('avatar', character.avatar) : system_avatar;
        chat.is_group = !!group;
        chat.hidden = false;
        chat.avatar = chat.avatar || '';
        chat.group = chat.group || '';
        chat.pinned = PinnedChatsManager.isPinned(chat);
        chat.is_agent = shouldSeparateAgentRecentChats() && isAgentRecentChat(chat);
        chat.recent_chat_type = getRecentChatType(chat);
    });

    const roleplayChats = dataWithEntities.map(t => t.chat);
    const conversationChats = await getConversationChats();
    const mergedChats = [...roleplayChats, ...conversationChats].sort((first, second) => {
        const firstPinned = PinnedChatsManager.isPinned(first);
        const secondPinned = PinnedChatsManager.isPinned(second);

        if (firstPinned && !secondPinned) {
            return -1;
        }
        if (!firstPinned && secondPinned) {
            return 1;
        }

        return sortMoments(timestampToMoment(first.last_mes), timestampToMoment(second.last_mes));
    });
    return finalizeRecentChats(mergedChats);
}

export async function openPermanentAssistantChat({ tryCreate = true, created = false } = {}) {
    try {
        const assistantConfig = getBundledAssistantConfig(DEFAULT_BUNDLED_ASSISTANT_ID);
        const assistant = await ensureBundledAssistantCharacter(assistantConfig, { tryCreate, created, forceCreate: tryCreate });
        if (!assistant) {
            return;
        }

        await refreshCharacterAvatarCache(assistant.avatar);
        await selectCharacterById(assistant.characterId);
        if (!assistant.created) {
            await doNewChat({ deleteCurrentChat: false });
        }
        console.log(`Opened bundled assistant chat for ${assistantConfig.characterName}.`, getCurrentChatId());
    } catch (error) {
        console.error('Error opening permanent assistant chat:', error);
        toastr.error(t`Failed to open permanent assistant chat. See console for details.`);
    }
}

async function createBundledAssistant(config) {
    if (is_group_generating || is_send_press) {
        throw new Error(t`Cannot create while generating.`);
    }

    if (config.cardAsset) {
        const formData = new FormData();
        formData.append('file_type', 'png');
        formData.append('preserved_name', config.fileName);

        const cardResponse = await fetch(config.cardAsset, { cache: 'no-store' });
        if (!cardResponse.ok) {
            throw new Error(`Failed to fetch bundled assistant card for "${config.id}".`);
        }

        const cardBlob = await cardResponse.blob();
        formData.append('avatar', cardBlob, config.defaultAvatar);

        const importResult = await fetch('/api/characters/import', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
            cache: 'no-cache',
        });

        if (!importResult.ok) {
            throw new Error(t`Import request did not succeed.`);
        }

        const importPayload = await importResult.json();
        if (importPayload?.error) {
            throw new Error(`Assistant card import failed for "${config.id}".`);
        }

        const importedAvatar = typeof importPayload?.file_name === 'string' && importPayload.file_name.trim()
            ? `${importPayload.file_name.trim()}.png`
            : config.defaultAvatar;

        await getCharacters();
        const createdCharacterId = findBundledAssistantCharacterId(config, importedAvatar);

        if (createdCharacterId === -1) {
            throw new Error(`Assistant character ${importedAvatar} was not registered after import.`);
        }

        const resolvedAvatar = characters[createdCharacterId]?.avatar;
        setBundledAssistantStoredAvatar(config, resolvedAvatar || '');
        setBundledAssistantIdentityAvatar(config, resolvedAvatar || config.defaultAvatar);
        return;
    }

    const formData = new FormData();
    formData.append('ch_name', config.characterName);
    formData.append('file_name', config.fileName);
    formData.append('creator_notes', config.creatorNotes);
    formData.append('description', config.description);
    formData.append('personality', config.personality);
    formData.append('scenario', config.scenario);
    formData.append('first_mes', config.firstMessage);
    formData.append('creator', config.creator);
    formData.append('tags', [...(config.chips ?? []), 'assistant', 'bundled'].join(', '));

    try {
        const avatarResponse = await fetch(config.portrait);
        const avatarBlob = await avatarResponse.blob();
        formData.append('avatar', avatarBlob, config.defaultAvatar);
    } catch (error) {
        console.warn(`Error fetching bundled assistant portrait for "${config.id}". Fallback image will be used.`, error);
    }

    const fetchResult = await fetch('/api/characters/create', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
        cache: 'no-cache',
    });

    if (!fetchResult.ok) {
        throw new Error(t`Creation request did not succeed.`);
    }

    const createdAvatar = (await fetchResult.text()).trim() || config.defaultAvatar;
    await getCharacters();
    const createdCharacterId = findBundledAssistantCharacterId(config, createdAvatar);

    if (createdCharacterId === -1) {
        throw new Error(`Assistant character ${createdAvatar} was not registered after creation.`);
    }

    const resolvedAvatar = characters[createdCharacterId]?.avatar;
    setBundledAssistantStoredAvatar(config, resolvedAvatar || '');
    setBundledAssistantIdentityAvatar(config, resolvedAvatar || config.defaultAvatar);
}

async function openBundledAssistantCard(assistantId = DEFAULT_BUNDLED_ASSISTANT_ID) {
    const assistantConfig = getBundledAssistantConfig(assistantId);
    const assistant = await ensureBundledAssistantCharacter(assistantConfig, { forceCreate: true });
    if (!assistant) {
        return;
    }

    await refreshCharacterAvatarCache(assistant.avatar);
    await selectCharacterById(assistant.characterId);
}

export async function openPermanentAssistantCard() {
    await openBundledAssistantCard(DEFAULT_BUNDLED_ASSISTANT_ID);
}

/**
 * Assigns a character as the assistant.
 * @param {string?} characterId Character ID
 */
export function assignCharacterAsAssistant(characterId) {
    if (characterId === undefined) {
        return;
    }
    /** @type {Character} */
    const character = characters[characterId];
    if (!character) {
        return;
    }

    const currentAssistantAvatar = getPermanentAssistantAvatar();
    if (currentAssistantAvatar === character.avatar) {
        if (character.avatar === getBundledAssistantConfig(DEFAULT_BUNDLED_ASSISTANT_ID).defaultAvatar) {
            toastr.info(t`${character.name} is a system assistant. Choose another character.`);
            return;
        }

        toastr.info(t`${character.name} is no longer your assistant.`);
        accountStorage.removeItem(assistantAvatarKey);
        return;
    }

    accountStorage.setItem(assistantAvatarKey, character.avatar);
    printCharactersDebounced();
    toastr.success(t`Set ${character.name} as your assistant.`);
}

export function initWelcomeScreen() {
    PinnedChatsManager.init();

    // Ensure all bundled assistants exist in the character list on startup
    eventSource.on(event_types.APP_READY, async () => {
        for (const assistant of WELCOME_BUNDLED_ASSISTANTS) {
            await ensureBundledAssistantCharacter(assistant, { tryCreate: true });
        }

        if (getCurrentChatId() === undefined && chat.length === 0) {
            await openWelcomeScreen({ force: true });
        }
    });

    eventSource.makeFirst(event_types.CHAT_CHANGED, openWelcomeScreen);

    eventSource.on(event_types.CHARACTER_MANAGEMENT_DROPDOWN, (target) => {
        if (target !== 'set_as_assistant') {
            return;
        }
        assignCharacterAsAssistant(this_chid);
    });

    eventSource.on(event_types.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        for (const assistant of WELCOME_BUNDLED_ASSISTANTS) {
            const storedAvatar = accountStorage.getItem(assistant.avatarStorageKey);
            const identityAvatar = getBundledAssistantIdentityAvatar(assistant);
            if (identityAvatar === oldAvatar || assistant.defaultAvatar === oldAvatar) {
                setBundledAssistantIdentityAvatar(assistant, newAvatar);
            }

            if (storedAvatar === oldAvatar || (!storedAvatar && assistant.defaultAvatar === oldAvatar)) {
                setBundledAssistantStoredAvatar(assistant, newAvatar);
            }
        }
    });

    eventSource.on(event_types.CHARACTER_DELETED, (event) => {
        const deletedCharacter = event?.character;
        for (const assistant of WELCOME_BUNDLED_ASSISTANTS) {
            if (isBundledAssistantCharacter(assistant, deletedCharacter)) {
                markBundledAssistantDeleted(assistant, deletedCharacter?.avatar || '');
            }
        }
    });

    eventSource.on(event_types.CHAT_RENAMED, async ({ avatarId, groupId, oldFileName, newFileName }) => {
        PinnedChatsManager.rename({ avatar: avatarId, group: groupId, file_name: oldFileName }, newFileName);
    });
}
