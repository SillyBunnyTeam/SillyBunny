import {
    characters,
    chat,
    deleteCharacterChatByName,
    displayVersion,
    doNewChat,
    event_types,
    eventSource,
    firstRun,
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
    updateRemoteChatName,
} from '../script.js';
import { deleteGroupChatByName, getGroupAvatar, groups, is_group_generating, openGroupById, openGroupChat } from './group-chats.js';
import { enableExtension, extension_settings, findExtension, installExtension } from './extensions.js';
import { t } from './i18n.js';
import { getPresetManager } from './preset-manager.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { renderTemplateAsync } from './templates.js';
import { isAdmin } from './user.js';
import { accountStorage } from './util/AccountStorage.js';
import { clamp, flashHighlight, isElementInViewport, sortMoments, timestampToMoment } from './utils.js';

const assistantAvatarKey = 'assistant';
const pinnedChatsKey = 'pinnedChats';

const tutorialStatusKey = 'WelcomePage_TutorialStatus';
const welcomeDeckViewKey = 'WelcomePage_DeckView';
const welcomeDeckCollapsedKey = 'WelcomePage_DeckCollapsed';
const welcomePanelModeKey = 'WelcomePage_PanelMode';
const DEFAULT_BUNDLED_ASSISTANT_ID = 'guide';
const bundledAssistantNahidaAvatarKey = 'bundledAssistantNahidaAvatar';
const DEFAULT_NEUTRAL_ASSISTANT_NAME = 'Assistant';

const AGENT_MESSAGE_EXTRA_KEY = 'inChatAgents';
const AGENT_PROMPT_TRANSFORM_HISTORY_KEY = 'inChatAgentTransformHistory';
const STARTER_PACK_PRESET_NAME_SILLYBUNNY = 'Pura\'s Director Preset (SillyBunny)';
const STARTER_PACK_PRESET_TITLE = 'Pura\'s Director Preset';
const STARTER_PACK_CREATOR_NAME = 'purachina';
const STARTER_PACK_SITE_URL = 'https://platberlitz.github.io/';
const GEECHAN_PRESET_NAME = 'Geechan - Universal Roleplay (Chat Completions) (v5.2)';
const GEECHAN_SITE_URL = 'https://rentry.org/geechan';
const TLD_CHUB_URL = 'https://chub.ai/users/thelonelydevil';
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
        repoUrl: 'https://github.com/platberlitz/SillyBunny-CssSnippets',
    }),
    moonlitEchoes: Object.freeze({
        id: 'third-party/SillyBunny-MoonlitEchoesTheme',
        repoUrl: 'https://github.com/platberlitz/SillyBunny-MoonlitEchoesTheme',
    }),
    groupUtilities: Object.freeze({
        id: 'third-party/SB-GroupUtilities',
        repoUrl: 'https://github.com/DrMortum/SB-GroupUtilities',
    }),
    laLib: Object.freeze({
        id: 'third-party/SillyTavern-LALib',
        repoUrl: 'https://github.com/LenAnderson/SillyTavern-LALib',
    }),
    tooltips: Object.freeze({
        id: 'third-party/SillyTavern-Tooltips',
        repoUrl: 'https://github.com/LenAnderson/SillyTavern-Tooltips',
    }),
    adhdBunnyUi: Object.freeze({
        id: 'third-party/ADHDBunny-UI',
        repoUrl: 'https://github.com/OnlyJimmy/ADHDBunny-UI',
    }),
});

const WELCOME_TUTORIAL_STEPS = Object.freeze([
    {
        title: 'Start from home',
        body: 'The Home Page is your personal starting point. You can start a Temporary Chat, open one of our built-in assistants, or access a few essential quick-settings right away.',
        hint: 'If you just want to directly chat with your chosen model, clicking Temporary Chat will get you started.',
        chips: ['Temporary Chat', 'Open Assistant', 'Import Characters'],
        actionLabel: 'Open Assistant',
        actionType: 'open-assistant',
        actionValue: '',
    },
    {
        title: 'Connect a model',
        body: 'Clicking the API button will bring you to a screen to connect a provider, and choose an LLM of your choice. You will need to connect a model before you can begin chatting.',
        hint: 'Not sure what provider to use? OpenRouter is a good place to start. SillyBunny needs at least one working connection before you can chat.',
        chips: ['API', 'Providers', 'Models', 'Connection'],
        actionLabel: 'Open API',
        actionType: 'open-tab',
        actionValue: 'left:api',
    },
    {
        title: 'Choose a preset',
        body: 'First, select a preset of your choice: this helps dictate model responses. Chat and Text Completions formatting lives with the presets tab, and World Info helps the model remember lore and setting details.',
        hint: 'You only really need to start with a preset! We recommend using our bundled Geechan or Director preset. Access the other workspace sections once you feel more comfortable.',
        chips: ['Presets', 'Formatting', 'World Info', 'Context'],
        actionLabel: 'Open Presets',
        actionType: 'open-tab',
        actionValue: 'left:presets',
    },
    {
        title: 'Personalize your workspace',
        body: 'The Customize menu in the top bar handles your theming and customization needs. You can optionally enable extra extensions, then manage personas from Characters.',
        hint: 'Customization and extensions are optional, but recommended. While we ship a starter pack, nothing turns itself on without your permission.',
        chips: ['Settings', 'Extensions', 'Background'],
        actionLabel: 'Open Extensions',
        actionType: 'open-tab',
        actionValue: 'right:extensions',
    },
    {
        title: 'Ask our assistants when stuck',
        body: 'Our built-in assistants can help explain LLM basics and SillyBunny concepts and terminology without assuming you already know the jargon.',
        hint: 'Make sure you have a model connected first! You can really ask our assistants anything and they will help explain more abstract concepts.',
        chips: ['LLM basics', 'SillyBunny tips', 'SillyTavern terms'],
        actionLabel: 'Prefill a beginner question',
        actionType: 'assistant-prompt',
        actionValue: 'Explain the difference between providers, models, presets, personas, and world info in simple terms.',
    },
]);

const WELCOME_GUIDE_CARDS = Object.freeze([
    {
        title: 'Workspace Menu',
        body: 'Open the Workspace button in the top bar when you want to change how the AI behaves: connecting APIs, swapping presets, tuning sampling or formatting, and loading lore and agent helpers.',
        chips: ['Presets', 'API', 'Sampling', 'World Info', 'Agents'],
        icon: 'fa-compass-drafting',
        actionLabel: 'Open the Workspace menu',
        actionType: 'open-tab',
        actionValue: 'left:presets',
    },
    {
        title: 'Customize Menu',
        body: 'Open the Customize button in the top bar when you want to change your workspace setup: app settings, extensions, backgrounds, and the visual feel of SillyBunny.',
        chips: ['Settings', 'Extensions', 'Background'],
        icon: 'fa-screwdriver-wrench',
        actionLabel: 'Open the Customize menu',
        actionType: 'open-tab',
        actionValue: 'right:settings',
    },
    {
        title: 'Characters Menu',
        body: 'Open the Characters button in the top bar when you want to access characters, edit personas, or create character cards. We have a few characters bundled for you to give you an idea of how to create them!',
        chips: ['Character Cards', 'Persona', 'Create Character', 'Open Character'],
        icon: 'fa-solid fa-id-card',
        actionLabel: 'Open the Characters menu',
        actionType: 'open-characters-menu',
        actionValue: '',
    },
    {
        title: 'Global Search',
        body: 'Open the search icon in the top bar to do a global search across all settings pages to quickly find the setting you are looking for!',
        chips: ['Global Search', 'Fuzzy Search', 'Settings', 'Top Bar'],
        icon: 'fa-search',
        actionLabel: 'Open the Search bar',
        actionType: 'open-global-search',
        actionValue: '',
        isSearchTrigger: true,
    },
    {
        title: 'Quick-access Buttons',
        body: 'We have a few quick access buttons for your convenience in the home screen. Temporary Chat opens a quick burner chat. Open Assistant brings up one of our built-in assistants. Import Characters lets you bring in a character of your choosing.',
        chips: ['Temporary Chat', 'Open Assistant', 'Import Characters'],
        icon: 'fa-hand-pointer',
        actionLabel: 'Import a character',
        actionType: 'open-import-characters',
        actionValue: '',
    },
    {
        title: 'Confused?',
        body: 'If you are ever confused, check through our launchpad documentation or ask one of our assistants a question. It is not necessary to memorize the whole interface to start using it!',
        chips: ['Open Launchpad', 'Bunny guide', 'Docs', 'Start small'],
        icon: 'fa-life-ring',
        actionLabel: 'Open Launchpad',
        actionType: 'replay-tutorial',
        actionValue: '',
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
        chips: Object.freeze(['LLM basics', 'SillyBunny help', 'Plain English', 'purachina']),
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
        chips: Object.freeze(['LLM basics', 'SillyBunny help', 'Philosophical', 'Geechan']),
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
        title: 'First Steps',
        summary: 'A guided five-step tour for brand-new users.',
        icon: 'fa-route',
    },
    {
        id: 'basics',
        title: 'Core Buttons',
        summary: 'A plain-English guide on our graphical shell.',
        icon: 'fa-compass-drafting',
    },
    {
        id: 'guide',
        title: 'Bunny Guide + Assistant Nahida',
        summary: 'Two bundled helpers for plain-English setup help.',
        icon: 'fa-user-graduate',
    },
    {
        id: 'starter',
        title: 'Bundled Extras',
        summary: 'Optional bundled extras, presets, and creator picks.',
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
 * @typedef {Pick<RecentChat, 'group' | 'avatar' | 'file_name'>} PinnedChat
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
            };
        } else {
            delete pinState[pinKey];
        }
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
            group: recentChat.group,
            avatar: recentChat.avatar,
            file_name: newFileName,
        };
        delete pinState[oldKey];
        this.#saveState(pinState);
    }

    /**
     * Gets all pinned chats.
     * @returns {PinnedChat[]}
     */
    static getAll() {
        const pinState = this.getState();
        return Object.values(pinState);
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

function isWelcomeDeckCollapsed() {
    const stored = getWelcomeUiPreference(welcomeDeckCollapsedKey);
    if (stored === null) {
        // Check if this is first run - if so, default to expanded (false)
        // Otherwise default to collapsed (true)
        return !firstRun;
    }
    return stored === 'true';
}

function isWelcomePanelMode(mode) {
    return Object.values(WELCOME_PANEL_MODES).includes(mode);
}

function getWelcomePanelMode() {
    const storedMode = getWelcomeUiPreference(welcomePanelModeKey) || WELCOME_PANEL_MODES.full;
    return isWelcomePanelMode(storedMode) ? storedMode : WELCOME_PANEL_MODES.full;
}

function getWelcomeUiPreference(key) {
    try {
        const localValue = globalThis.localStorage?.getItem(key) ?? null;

        if (localValue !== null) {
            if (accountStorage.getItem(key) !== localValue) {
                accountStorage.setItem(key, localValue);
            }

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
        chips: [...card.chips],
        chipColumnCount: Math.max(2, Math.min(card.chips.length || 1, 4)),
        isSearchTrigger: card.isSearchTrigger || false,
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
        chips: [...assistant.chips],
        chipColumnCount: Math.max(2, Math.min(assistant.chips.length || 1, 4)),
        questions: [...assistant.questions],
        hasQuestions: assistant.questions.length > 0,
    }));
}

function buildTutorialSteps() {
    return WELCOME_TUTORIAL_STEPS.map((step, index) => ({
        ...step,
        chips: [...step.chips],
        stepNumber: index + 1,
        active: index === 0,
    }));
}

function getStarterPackExtensionConfig(extensionName) {
    return Object.values(STARTER_PACK_EXTENSIONS).find(extension => extension.id === extensionName) ?? null;
}

function buildExtensionStarterPackItem({ title, body, icon, chips, extensionName }) {
    const extension = findExtension(extensionName);
    const extensionConfig = getStarterPackExtensionConfig(extensionName);
    const chipColumnCount = Math.max(2, Math.min(chips.length || 1, 4));

    if (!extension && extensionConfig) {
        return {
            title,
            body,
            icon,
            chips: [...chips],
            chipColumnCount,
            statusLabel: 'Git install',
            statusTone: 'warm',
            actionIcon: 'fa-download',
            actionLabel: isAdmin() ? 'Install for all users' : 'Install for me',
            actionType: 'install-starter-extension',
            actionValue: extensionName,
        };
    }

    if (!extension) {
        return {
            title,
            body,
            icon,
            chips: [...chips],
            chipColumnCount,
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
            chips: [...chips],
            chipColumnCount,
            statusLabel: 'Enabled',
            statusTone: 'good',
            actionIcon: 'fa-arrow-up-right-from-square',
            actionLabel: 'Manage in Extensions',
            actionType: 'open-tab',
            actionValue: 'right:extensions',
        };
    }

    return {
        title,
        body,
        icon,
        chips: [...chips],
        chipColumnCount,
        statusLabel: 'Installed',
        statusTone: 'warm',
        actionLabel: 'Enable and reload',
        actionIcon: 'fa-wand-magic-sparkles',
        actionType: 'enable-extension',
        actionValue: extension.name,
    };
}

function buildPresetStarterPackItem() {
    const presetManager = getPresetManager('openai');
    const sillyBunnyPreset = presetManager?.findPreset(STARTER_PACK_PRESET_NAME_SILLYBUNNY);
    const isOpenAiStyleApi = main_api === 'openai';
    const selectedPresetName = isOpenAiStyleApi ? presetManager?.getSelectedPresetName() : '';
    const isSelected = selectedPresetName === STARTER_PACK_PRESET_NAME_SILLYBUNNY;
    const hasBundledPreset = Boolean(sillyBunnyPreset);
    const chips = ['Chat Completions', 'Bundled', 'Agent-aware', STARTER_PACK_CREATOR_NAME];
    const chipColumnCount = Math.max(2, Math.min(chips.length, 4));
    const body = 'purachina\'s website contains his character cards, presets, and other projects. A SillyBunny-tuned version of his Director Preset ships included and is ready to use for Chat Completions.';

    if (!isOpenAiStyleApi) {
        return {
            title: STARTER_PACK_PRESET_TITLE,
            body: `${body} Switch to an OpenAI-compatible chat-completions setup first, then you can apply it here.`,
            icon: 'fa-sliders',
            chips,
            chipColumnCount,
            statusLabel: 'Chat Completions',
            statusTone: 'neutral',
            actionIcon: 'fa-arrow-up-right-from-square',
            actionLabel: 'Open API',
            actionType: 'open-tab',
            actionValue: 'left:api',
        };
    }

    if (hasBundledPreset) {
        return {
            title: STARTER_PACK_PRESET_TITLE,
            body: isSelected
                ? `${body} It is selected right now.`
                : `${body} It is bundled and ready to apply without importing files by hand.`,
            icon: 'fa-sliders',
            chips,
            chipColumnCount,
            statusLabel: isSelected ? 'Selected' : 'Bundled',
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
        body: `${body} Open the preset panel if you need to check what is available.`,
        icon: 'fa-sliders',
        chips,
        chipColumnCount,
        statusLabel: 'Open Presets',
        statusTone: 'warm',
        actionIcon: 'fa-arrow-up-right-from-square',
        actionLabel: 'Open Presets',
        actionType: 'open-tab',
        actionValue: 'left:presets',
    };
}

function buildLinkStarterPackItem({
    title,
    body,
    icon,
    chips,
    actionLabel,
    actionValue,
    secondaryActionLabel = '',
    secondaryActionValue = '',
    statusLabel = 'Bundled',
    statusTone = 'warm',
}) {
    return {
        title,
        body,
        icon,
        chips: [...chips],
        chipColumnCount: Math.max(2, Math.min(chips.length || 1, 4)),
        statusLabel,
        statusTone,
        actionLabel,
        actionIcon: 'fa-arrow-up-right-from-square',
        actionType: 'open-link',
        actionValue,
        secondaryActionLabel,
        secondaryActionIcon: 'fa-arrow-up-right-from-square',
        secondaryActionType: 'open-link',
        secondaryActionValue,
    };
}

function buildGeechanStarterPackItem() {
    const presetManager = getPresetManager('openai');
    const isOpenAiStyleApi = main_api === 'openai';
    const isSelected = isOpenAiStyleApi && presetManager?.getSelectedPresetName() === GEECHAN_PRESET_NAME;
    const body = 'Geechan\'s Rentry highlights his well-written character cards and guides alongside his prompts and presets. SillyBunny includes his Universal Roleplay v5.2 preset across Chat Completions, plus the matching Text Completions variant for context, system prompt, and instruct pieces. He also made our bundled Assistant Nahida card and Prose Polisher agent.';

    return {
        title: 'Geechan',
        body: isSelected ? `${body} This preset is selected right now.` : body,
        icon: 'fa-leaf',
        chips: ['Chat Completions', 'Text Completions', 'Prose Polisher', 'Assistant Nahida'],
        chipColumnCount: 4,
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
    return buildLinkStarterPackItem({
        title: 'TheLonelyDevil',
        body: 'SillyBunny bundles the TLD Card Conversion Preset for character card conversions and generations, and the Memory Sharding Quick Reply set for compressing chat history into structured memory shards. We also recommend his Discord Pals program to run LLM characters inside Discord!',
        icon: 'fa-shoe-prints',
        chips: ['Card converter', 'Memory shards', 'Discord Pals', 'Chub'],
        statusLabel: 'Card Converter',
        statusTone: 'warm',
        actionLabel: 'Visit site',
        actionValue: TLD_CHUB_URL,
        secondaryActionLabel: 'Discord Pals',
        secondaryActionValue: TLD_DISCORD_PALS_URL,
    });
}

function buildStarterPackItems() {
    return {
        preInstalled: [
            buildPresetStarterPackItem(),
            buildGeechanStarterPackItem(),
            buildTldStarterPackItem(),
        ],
        optional: [
            buildExtensionStarterPackItem({
                title: 'Summary Sharder',
                body: 'A recommended way to add persistent memory to your chats. Summary Sharder keeps a rolling summary of your conversation so the AI remembers key events, characters, and context across long sessions.',
                icon: 'fa-brain',
                chips: ['Extension', 'Memory', 'Recommended'],
                extensionName: STARTER_PACK_EXTENSIONS.summarySharder.id,
            }),
            buildExtensionStarterPackItem({
                title: 'Dialogue Colors',
                body: `${STARTER_PACK_CREATOR_NAME}'s dialogue coloring add-on helps visually busy or emotionally dense chats stay readable, with optional regex setup if you want finer control.`,
                icon: 'fa-palette',
                chips: ['Extension', 'Readable chats', 'Opt-in'],
                extensionName: STARTER_PACK_EXTENSIONS.dialogueColors.id,
            }),
            buildExtensionStarterPackItem({
                title: 'CSS Snippets',
                body: 'Manage custom CSS snippets from User Settings. Link snippets to specific themes or chats for per-character styling.',
                icon: 'fa-palette',
                chips: ['Extension', 'Styling', 'Opt-in'],
                extensionName: STARTER_PACK_EXTENSIONS.cssSnippets.id,
            }),
            buildExtensionStarterPackItem({
                title: 'Moonlit Echoes Theme',
                body: 'A SillyBunny-specific fork of Moonlit Echoes that keeps its theme CSS, mobile layout fixes, and Moonlit chat styles isolated from SillyBunny core.',
                icon: 'fa-moon',
                chips: ['Extension', 'Theme', 'SillyBunny fork'],
                extensionName: STARTER_PACK_EXTENSIONS.moonlitEchoes.id,
            }),
            buildExtensionStarterPackItem({
                title: 'Group Utilities',
                body: 'A SillyBunny-focused group-chat bundle with presence tracking, group greetings, shared group context utilities, and quick SendAs controls in one optional install.',
                icon: 'fa-users',
                chips: ['Extension', 'Groups', 'Presence', 'SendAs'],
                extensionName: STARTER_PACK_EXTENSIONS.groupUtilities.id,
            }),
            buildExtensionStarterPackItem({
                title: 'LALib',
                body: 'LenAnderson\'s shared helper library powers several other extensions, so having it in the Starter Pack makes later installs smoother and reduces dependency hunting.',
                icon: 'fa-toolbox',
                chips: ['Extension', 'Recommended', 'Utility'],
                extensionName: STARTER_PACK_EXTENSIONS.laLib.id,
            }),
            buildExtensionStarterPackItem({
                title: 'Tooltips',
                body: 'Adds richer hover help across supported UI pieces so confusing controls are easier to understand without leaving the screen or digging through docs first.',
                icon: 'fa-circle-info',
                chips: ['Extension', 'Recommended', 'Help'],
                extensionName: STARTER_PACK_EXTENSIONS.tooltips.id,
            }),
            buildExtensionStarterPackItem({
                title: 'ADHDBunny UI',
                body: 'A desktop-first SillyBunny UI overhaul designed to keep chat central while making common tools easier to reach and reducing workspace distractions.',
                icon: 'fa-rabbit',
                chips: ['Extension', 'Workspace', 'Desktop-first', 'Opt-in'],
                extensionName: STARTER_PACK_EXTENSIONS.adhdBunnyUi.id,
            }),
        ],
    };
}

function buildWelcomeTemplateData(chats) {
    const activeDeckView = getInitialDeckView();
    const deckCollapsed = isWelcomeDeckCollapsed();
    const welcomePanelMode = getWelcomePanelMode();

    return {
        chats,
        empty: !chats.length,
        version: displayVersion,
        more: chats.length > getRecentChatsSettings().collapsedDisplayed,
        activeDeckView,
        deckCollapsed,
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
        tutorialExpanded: true,
        tutorialIndex: 0,
        tutorialSteps: buildTutorialSteps(),
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
    setWelcomeDeckCollapsed(welcomePanel, false);

    const selector = `.welcomeStarterPackCard[data-launchpad-extension="${CSS.escape(extensionId)}"]`;
    const card = welcomePanel.querySelector(selector);
    if (!(card instanceof HTMLElement)) {
        return false;
    }

    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
function updateRecentChatFilterView(root, { expanded = false } = {}) {
    const filter = root.dataset.recentChatFilter || 'all';
    const chatItems = Array.from(root.querySelectorAll('.recentChat'));
    const { collapsedDisplayed } = getRecentChatsSettings();
    let matchingCount = 0;

    chatItems.forEach((chatItem) => {
        const chatType = getRecentChatItemType(chatItem);
        const matchesFilter = filter === 'all' || chatType === filter;
        const hiddenByLimit = matchesFilter && !expanded && matchingCount >= collapsedDisplayed;

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
        button.classList.toggle('displayNone', !hasMoreChats);
        button.classList.toggle('rotated', expanded && hasMoreChats);
        button.setAttribute('aria-expanded', String(expanded && hasMoreChats));
    });
}

function openShellTab(route) {
    // SillyBunny: accept historical launcher routes while opening relocated
    // World Info in the Characters panel instead of the old left shell.
    const normalizedRoute = route === 'left:world-info' ? 'characters:world-info' : route;
    const [shellKey, tabId] = String(normalizedRoute || '').split(':');

    if (!shellKey || !tabId) {
        return;
    }

    if (globalThis.SillyBunnyShell?.openTab) {
        globalThis.SillyBunnyShell.openTab(shellKey, tabId);
        return;
    }

    const fallbackSelector = {
        'left:presets': '#ai-config-button > .drawer-toggle',
        'left:api': '#sys-settings-button > .drawer-toggle',
        'characters:world-info': '#WI-SP-button > .drawer-toggle',
        'right:settings': '#user-settings-button > .drawer-toggle',
        'right:extensions': '#extensions-settings-button > .drawer-toggle',
        'characters:persona': '#persona-management-button > .drawer-toggle',
        'right:background': '#backgrounds-button > .drawer-toggle',
    }[normalizedRoute];

    if (!fallbackSelector) {
        return;
    }

    document.querySelector(fallbackSelector)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function prefillSendTextarea(sendTextArea, value) {
    if (!(sendTextArea instanceof HTMLTextAreaElement)) {
        return;
    }

    sendTextArea.value = value;
    sendTextArea.dispatchEvent(new Event('input', { bubbles: true }));
    sendTextArea.focus();
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
        button.classList.toggle('is-active', button.getAttribute('data-deck-target') === safeView);
    });

    root.querySelectorAll('.welcomeDeckPanel').forEach((panel) => {
        panel.classList.toggle('is-active', panel.getAttribute('data-deck-panel') === safeView);
    });

    if (persist) {
        setWelcomeUiPreference(welcomeDeckViewKey, safeView);
    }
}

function setWelcomeDeckCollapsed(root, collapsed, { persist = true } = {}) {
    if (!(root instanceof HTMLElement)) {
        return;
    }

    const deck = root.querySelector('.welcomeDeck');

    if (!(deck instanceof HTMLElement)) {
        return;
    }

    root.dataset.deckCollapsed = String(collapsed);
    deck.dataset.collapsed = String(collapsed);
    deck.classList.toggle('is-collapsed', collapsed);

    const toggleButton = deck.querySelector('.welcomeDeckToggle');

    if (toggleButton instanceof HTMLButtonElement) {
        toggleButton.setAttribute('aria-expanded', String(!collapsed));
        toggleButton.setAttribute('title', collapsed ? 'Open Launchpad' : 'Close Launchpad');
    }

    // Update active state on Open Launchpad button in hero section
    const openLaunchpadButton = root.querySelector('.openLaunchpad');
    if (openLaunchpadButton instanceof HTMLElement) {
        openLaunchpadButton.classList.toggle('is-active', !collapsed);
    }

    if (persist) {
        setWelcomeUiPreference(welcomeDeckCollapsedKey, collapsed ? 'true' : 'false');
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

async function installStarterPackExtension(extensionName) {
    const extensionConfig = getStarterPackExtensionConfig(extensionName);
    if (!extensionConfig) {
        return false;
    }

    await installExtension(extensionConfig.repoUrl, isAdmin());

    const installedExtension = findExtension(extensionName);
    if (!installedExtension) {
        await refreshWelcomeScreen();
        return false;
    }

    if (!installedExtension.enabled) {
        await enableExtension(installedExtension.name, false);
    }

    location.reload();
    return true;
}

function setTutorialUiState(panel, index, expanded) {
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

    steps.forEach((step, stepIndex) => {
        step.classList.toggle('is-active', stepIndex === safeIndex);
    });

    progressButtons.forEach((button, buttonIndex) => {
        button.classList.toggle('is-active', buttonIndex === safeIndex);
    });

    if (previousButton instanceof HTMLButtonElement) {
        previousButton.disabled = safeIndex === 0;
    }

    if (nextLabel) {
        nextLabel.textContent = safeIndex >= steps.length - 1 ? 'Finish tour' : 'Next';
    }
}

function dismissTutorial(panel, status) {
    if (status) {
        setWelcomeUiPreference(tutorialStatusKey, status);
    }

    setTutorialUiState(panel, 0, false);
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
        case 'enable-extension':
            await enableExtension(value);
            break;
        case 'install-starter-extension':
            await installStarterPackExtension(value);
            break;
        case 'apply-preset':
            if (await applyOpenAiPreset(value)) {
                await refreshWelcomeScreen();
            }
            break;
        case 'assistant-prompt':
            await openBundledAssistantCard(assistantId);
            prefillSendTextarea(sendTextArea, value);
            break;
        case 'open-assistant':
            await openBundledAssistantCard(assistantId);
            if (sendTextArea instanceof HTMLTextAreaElement) {
                sendTextArea.focus();
            }
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
            if (welcomePanel instanceof HTMLElement) {
                setWelcomeDeckView(welcomePanel, 'tour');
                setWelcomeDeckCollapsed(welcomePanel, false);
            }
            if (tutorialPanel instanceof HTMLElement) {
                setTutorialUiState(tutorialPanel, 0, true);
            }
            break;
        case 'open-launchpad':
            if (welcomePanel instanceof HTMLElement) {
                const isCurrentlyCollapsed = isWelcomeDeckCollapsed();
                if (isCurrentlyCollapsed) {
                    setWelcomeDeckView(welcomePanel, welcomePanel.dataset.activeDeckView || getInitialDeckView());
                    setWelcomeDeckCollapsed(welcomePanel, false);
                } else {
                    setWelcomeDeckCollapsed(welcomePanel, true);
                }
            }
            break;
        case 'close-guide':
            if (welcomePanel instanceof HTMLElement) {
                setWelcomeDeckCollapsed(welcomePanel, true);
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
        const template = await renderTemplateAsync('/scripts/templates/welcomePanelOnboarding.html?v=20260505a', templateData, true, true, true);
        const fragment = document.createRange().createContextualFragment(template);
        const nextPanel = fragment.querySelector('.welcomePanel');
        fragment.querySelectorAll('.welcomePanel').forEach((root) => {
            const recentHiddenClass = 'recentHidden';
            const recentHiddenKey = 'WelcomePage_RecentChatsHidden';
            const deck = root.querySelector('.welcomeDeck');
            if (getWelcomeUiPreference(recentHiddenKey) === 'true') {
                root.classList.add(recentHiddenClass);
            }
            root.querySelectorAll('.showRecentChats').forEach((button) => {
                button.addEventListener('click', () => {
                    root.classList.remove(recentHiddenClass);
                    setWelcomeUiPreference(recentHiddenKey, 'false');
                });
            });
            root.querySelectorAll('.hideRecentChats').forEach((button) => {
                button.addEventListener('click', () => {
                    root.classList.add(recentHiddenClass);
                    setWelcomeUiPreference(recentHiddenKey, 'true');
                });
            });
            root.querySelectorAll('[data-welcome-panel-mode-target]').forEach((button) => {
                button.addEventListener('click', () => {
                    setWelcomePanelMode(root, button.getAttribute('data-welcome-panel-mode-target') || WELCOME_PANEL_MODES.full);
                });
            });
            root.querySelectorAll('[data-recent-chat-filter]').forEach((button) => {
                button.addEventListener('click', () => {
                    const filter = button.getAttribute('data-recent-chat-filter') || 'all';
                    root.dataset.recentChatFilter = filter;
                    root.querySelectorAll('[data-recent-chat-filter]').forEach((tab) => {
                        const active = tab === button;
                        tab.classList.toggle('active', active);
                        tab.setAttribute('aria-pressed', String(active));
                    });
                    updateRecentChatFilterView(root);
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
            setWelcomeDeckCollapsed(root, deck instanceof HTMLElement ? deck.dataset.collapsed === 'true' : isWelcomeDeckCollapsed(), { persist: false });

            root.querySelectorAll('.welcomeDeckTab').forEach((button) => {
                button.addEventListener('click', () => {
                    const targetView = button.getAttribute('data-deck-target') || '';
                    setWelcomeDeckView(root, targetView);

                    if (targetView === 'tour' && tutorialPanel instanceof HTMLElement) {
                        const currentIndex = Number.parseInt(tutorialPanel.dataset.tutorialIndex || '0', 10) || 0;
                        setTutorialUiState(tutorialPanel, currentIndex, true);
                    }
                });
            });

            if (tutorialPanel instanceof HTMLElement) {
                setTutorialUiState(
                    tutorialPanel,
                    Number.parseInt(tutorialPanel.dataset.tutorialIndex || '0', 10) || 0,
                    tutorialPanel.dataset.tutorialExpanded !== 'false',
                );

                tutorialPanel.querySelectorAll('.welcomeTourProgressButton').forEach((button) => {
                    button.addEventListener('click', () => {
                        const targetIndex = Number.parseInt(button.getAttribute('data-step-target') || '0', 10) || 0;
                        setTutorialUiState(tutorialPanel, targetIndex, true);
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
                await handleWelcomeAction(button, sendTextArea);
            });
        });
        fragment.querySelectorAll('.recentChat').forEach((item) => {
            item.addEventListener('click', () => {
                const avatarId = item.getAttribute('data-avatar');
                const groupId = item.getAttribute('data-group');
                const fileName = item.getAttribute('data-file');
                const isConversation = item.getAttribute('data-recent-chat-type') === 'conversation';
                if (isConversation && avatarId) {
                    void openRecentConversationChat(avatarId, groupId);
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

            button.setAttribute('title', showRecentChatsTitle);
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
                await newAssistantChat({ temporary: true });
                if (sendTextArea instanceof HTMLTextAreaElement) {
                    sendTextArea.focus();
                }
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
                if (chatItem.getAttribute('data-recent-chat-type') === 'conversation') {
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
                if (chatItem.getAttribute('data-recent-chat-type') === 'conversation') {
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
                if (chatItem.getAttribute('data-recent-chat-type') === 'conversation') {
                    return;
                }
                const recentChat = chats.find(c => c.chat_name === fileName && ((c.is_group && c.group === groupId) || (!c.is_group && c.avatar === avatarId)));
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
        await selectCharacterById(characterId);
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
 */
async function openRecentConversationChat(avatarId, groupId = '') {
    const characterId = characters.findIndex(x => x.avatar === avatarId);
    if (characterId === -1) {
        console.error(`Character not found for avatar ID: ${avatarId}`);
        return;
    }

    try {
        const conversationModule = await import('./sillybunny-conversation.js');
        const opened = conversationModule.openConversationWorkspaceForAvatar?.(avatarId, {
            groupId: groupId || null,
            showToast: false,
        });
        if (!opened) {
            toastr.warning(t`Failed to open Conversation Mode for this chat.`);
        }
    } catch (error) {
        console.error('Error opening conversation chat:', error);
        toastr.error(t`Failed to open conversation chat. See console for details.`);
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
        await openGroupById(groupId);
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
        await updateRemoteChatName(characterId, newName);
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
        await deleteCharacterChatByName(String(characterId), fileName);
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
        await deleteGroupChatByName(groupId, fileName);
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
    const expand = chatElement.querySelectorAll('button.showMoreChats.rotated').length > 0;

    await openWelcomeScreen({ force: true, expand });

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
    const getConversationChats = async () => {
        try {
            const conversationModule = await import('./sillybunny-conversation.js');
            const conversationChats = conversationModule.getConversationWelcomeChats?.({ max: settings.maxDisplayed }) || [];
            return conversationChats.map((chat, index) => ({ ...chat, hidden: index >= settings.collapsedDisplayed }));
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
        return getConversationChats();
    }

    /** @type {RecentChat[]} */
    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
        return getConversationChats();
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

    dataWithEntities.forEach(({ chat, character, group }, index) => {
        const chatTimestamp = timestampToMoment(chat.last_mes);
        chat.char_name = character?.name || group?.name || '';
        chat.date_short = chatTimestamp.format('l');
        chat.date_long = chatTimestamp.format('LL LT');
        chat.chat_name = chat.file_name.replace('.jsonl', '');
        chat.char_thumbnail = character ? getThumbnailUrl('avatar', character.avatar) : system_avatar;
        chat.is_group = !!group;
        chat.hidden = index >= settings.collapsedDisplayed;
        chat.avatar = chat.avatar || '';
        chat.group = chat.group || '';
        chat.pinned = PinnedChatsManager.isPinned(chat);
        chat.is_agent = shouldSeparateAgentRecentChats() && isAgentRecentChat(chat);
        chat.recent_chat_type = getRecentChatType(chat);
    });

    const roleplayChats = dataWithEntities.map(t => t.chat);
    const conversationChats = await getConversationChats();
    if (!conversationChats.length) {
        return roleplayChats;
    }

    return [...roleplayChats, ...conversationChats]
        .sort((first, second) => Number(second.last_mes || 0) - Number(first.last_mes || 0))
        .map((chat, index) => ({ ...chat, hidden: index >= settings.collapsedDisplayed }));
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
    formData.append('tags', [...config.chips, 'assistant', 'bundled'].join(', '));

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

    const events = [event_types.CHAT_CHANGED, event_types.APP_READY];
    for (const event of events) {
        eventSource.makeFirst(event, openWelcomeScreen);
    }

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
