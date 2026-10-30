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
import { extension_settings } from './extensions.js';
import { t } from './i18n.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { renderTemplateAsync } from './templates.js';
import { accountStorage } from './util/AccountStorage.js';
import { clamp, flashHighlight, isElementInViewport, sortMoments, timestampToMoment } from './utils.js';
// SillyBunny: adopt Recent Chats custom inputs into shared spin rows.
import { utilityFormOptions } from './sillybunny-editor/adapters/utility-dialogs.js';
// SillyBunny: Home sections live in their own modules and mount into the rendered template.
import { applyDisplayMode, mountHome } from './sillybunny-home/mount.js';
import { parseDisplayMode } from './sillybunny-home/modes.js';
import { captureHomeFocus, restoreHomeFocus } from './sillybunny-home/focus.js';
import { openChatMenu } from './sillybunny-home/menu.js';
import { resolveRecentChatTarget } from './sillybunny-home/recent-chat.js';

const assistantAvatarKey = 'assistant';
const pinnedChatsKey = 'pinnedChats';

const welcomePanelModeKey = 'WelcomePage_PanelMode';
const DEFAULT_BUNDLED_ASSISTANT_ID = 'guide';
const bundledAssistantNahidaAvatarKey = 'bundledAssistantNahidaAvatar';
const DEFAULT_NEUTRAL_ASSISTANT_NAME = 'Assistant';

const AGENT_MESSAGE_EXTRA_KEY = 'inChatAgents';
const AGENT_PROMPT_TRANSFORM_HISTORY_KEY = 'inChatAgentTransformHistory';

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

// SillyBunny: parseDisplayMode turns a missing or unknown stored value into Full, so no caller handles a bad mode.
function getWelcomePanelMode() {
    return parseDisplayMode(getWelcomeUiPreference(welcomePanelModeKey));
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

// SillyBunny: the Home template reads only these fields. welcomePanelMode seeds data-home-panel-mode for the first paint, and mountHome then applies the mode to the regions.
function buildWelcomeTemplateData(chats) {
    return {
        chats,
        empty: !chats.length,
        more: chats.length > getRecentChatsSettings().collapsedDisplayed,
        welcomePanelMode: getWelcomePanelMode(),
        separateAgentRecentChats: shouldSeparateAgentRecentChats(),
    };
}

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

// SillyBunny: applyDisplayMode switches the visible regions in place, so a mode change neither fetches Recent Chats again nor renders the panel again.
function setWelcomePanelMode(root, mode, { persist = true } = {}) {
    if (!(root instanceof HTMLElement)) {
        return;
    }

    const safeMode = applyDisplayMode(root, mode);

    if (persist) {
        setWelcomeUiPreference(welcomePanelModeKey, safeMode);
    }
}

/** @type {import('./sillybunny-home/focus.js').HomeFocusTarget|null} */
let rememberedHomeFocus = null;

function getHomePanel() {
    const panel = document.querySelector('#chat > .welcomePanel');
    return panel instanceof HTMLElement ? panel : null;
}

// SillyBunny: an action that opens a popup records its control first, because the popup returns focus to a control of the old panel, and the new panel then replaces that control. Safari does not focus a button on click, so the control is passed in instead of read from document.activeElement.
function rememberHomeFocus(control) {
    rememberedHomeFocus = captureHomeFocus(getHomePanel(), control);
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
        // SillyBunny: keep a shown Home panel attached until its replacement is ready, so the Home state does not turn off and on.
        $('#chat').children().not('.welcomePanel').remove();
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
        if (!chatElement) {
            console.error('Chat element not found');
            return;
        }
        const templateData = buildWelcomeTemplateData(chats);
        // SillyBunny: Home has its own template. The template cache and the browser cache both key on the full path, so ?v= changes with every template edit.
        const template = await renderTemplateAsync('/scripts/templates/sillybunnyHome.html?v=20261031d', templateData, true, true, true);
        // SillyBunny: the first template request is not cached, and a chat can open while it is pending. Adding the panel then would cover that chat.
        if (getCurrentChatId() !== undefined) {
            return;
        }
        const fragment = document.createRange().createContextualFragment(template);
        const nextPanel = fragment.querySelector('.welcomePanel');
        fragment.querySelectorAll('.welcomePanel').forEach((root) => {
            if (!(root instanceof HTMLElement)) {
                return;
            }

            root.querySelectorAll('[data-recent-chat-filter]').forEach((button) => {
                button.addEventListener('click', () => {
                    const filter = button.getAttribute('data-recent-chat-filter') || 'all';
                    setRecentChatFilter(root, filter);
                });
            });
            // SillyBunny: the Home header, menu and empty states are built by sillybunny-home/.
            mountHome(root, {
                version: displayVersion,
                getDisplayMode: getWelcomePanelMode,
                setDisplayMode: mode => setWelcomePanelMode(root, mode),
                openRecentChatsSettings: () => {
                    rememberHomeFocus(root.querySelector('.sbHomeMenuButton'));
                    return openRecentChatsSettingsPopup();
                },
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
        // SillyBunny: a Recent Chats row holds two controls, Pin and a menu with Rename and Delete.
        fragment.querySelectorAll('.recentChat .chatMenu').forEach((menuButton) => {
            menuButton.addEventListener('click', (event) => {
                event.stopPropagation();
                const chatItem = menuButton.closest('.recentChat');
                if (!(menuButton instanceof HTMLElement) || !chatItem) {
                    return;
                }
                const target = resolveRecentChatTarget(chatItem, chats);
                const startAction = action => () => {
                    rememberHomeFocus(menuButton);
                    action(target);
                };
                openChatMenu(
                    menuButton,
                    { rename: startAction(renameRecentChat), remove: startAction(deleteRecentChat) },
                    { keyboard: event.detail === 0, bounds: menuButton.closest('.welcomePanel') },
                );
            });
        });
        fragment.querySelectorAll('.recentChat .pinChat').forEach((pinButton) => {
            pinButton.addEventListener('click', async (event) => {
                event.stopPropagation();
                const chatItem = pinButton.closest('.recentChat');
                if (!chatItem) {
                    return;
                }
                const { recentChat } = resolveRecentChatTarget(chatItem, chats);
                if (!recentChat) {
                    console.error('Recent chat not found for pinning.');
                    return;
                }
                rememberHomeFocus(pinButton);
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
 * @param {import('./sillybunny-home/recent-chat.js').RecentChatTarget} target
 */
function renameRecentChat(target) {
    if (target.isConversation) {
        if (target.avatarId && target.branchId && target.branchName) {
            void renameRecentConversationChat(target.avatarId, target.groupId, target.branchId, target.branchName, target.recentChat);
        }
        return;
    }
    if (target.avatarId && target.fileName) {
        void renameRecentCharacterChat(target.avatarId, target.fileName);
    }
    if (target.groupId && target.fileName) {
        void renameRecentGroupChat(target.groupId, target.fileName);
    }
}

/**
 * @param {import('./sillybunny-home/recent-chat.js').RecentChatTarget} target
 */
function deleteRecentChat(target) {
    if (target.isConversation) {
        if (target.avatarId && target.branchId) {
            void deleteRecentConversationChat(target.avatarId, target.groupId, target.branchId, target.recentChat);
        }
        return;
    }
    if (target.avatarId && target.fileName) {
        void deleteRecentCharacterChat(target.avatarId, target.fileName);
    }
    if (target.groupId && target.fileName) {
        void deleteRecentGroupChat(target.groupId, target.fileName);
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

// SillyBunny: the Home mode switcher resumes the newest Roleplay chat, so pins must not decide which one that is.
/**
 * Opens the character or group chat with the newest last message.
 * @param {object} [options]
 * @param {() => boolean} [options.canOpen] Checked after the request; nothing opens when it returns false.
 * @returns {Promise<boolean>} True if a chat is open afterwards.
 */
export async function resumeLatestRoleplayChat({ canOpen = () => true } = {}) {
    try {
        const response = await fetch('/api/chats/recent', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ max: getRecentChatsSettings().maxDisplayed, pinned: [], metadata: false, previewMessages: 0 }),
            cache: 'no-cache',
        });
        if (!response.ok) {
            console.warn(`Failed to fetch recent chats to resume (status ${response.status})`);
            return false;
        }

        /** @type {RecentChat[]} */
        const recentChats = await response.json();
        const [latest] = (Array.isArray(recentChats) ? recentChats : [])
            .filter(chat => chat.file_name && (characters.some(x => x.avatar === chat.avatar) || groups.some(x => x.id === chat.group)))
            .sort((a, b) => sortMoments(timestampToMoment(a.last_mes), timestampToMoment(b.last_mes)));
        if (latest && canOpen()) {
            const chatName = latest.file_name.replace('.jsonl', '');
            if (latest.group) {
                await openRecentGroupChat(latest.group, chatName);
            } else {
                await openRecentCharacterChat(latest.avatar, chatName);
            }
        }
        return getCurrentChatId() !== undefined;
    } catch (error) {
        console.warn('Failed to resume the latest Roleplay chat', error);
        return false;
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
    // SillyBunny: the new panel replaces the focused control, so the control is recorded before the render and focused again after it.
    const focusTarget = captureHomeFocus(currentPanel instanceof HTMLElement ? currentPanel : null) ?? rememberedHomeFocus;
    rememberedHomeFocus = null;

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

    // SillyBunny: focus returns only while nothing else holds it, so a popup or a control the user moved to keeps focus.
    const focusIsFree = !document.activeElement || document.activeElement === document.body || document.activeElement === document.documentElement;
    if (focusTarget && focusIsFree && nextPanel instanceof HTMLElement) {
        restoreHomeFocus(nextPanel, focusTarget);
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

    // SillyBunny: retain Popup's numeric validation, inputResults collection and row cleanup.
    const dialogOptions = utilityFormOptions({ title: t`Recent Chats Settings`, clearContent: true });
    await callGenericPopup(t`Recent Chats Settings`, POPUP_TYPE.CONFIRM, null, {
        ...dialogOptions,
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        customInputs: [maxRecentChatsInput, collapsedRecentChatsInput],
        onClose: (popup) => {
            // SillyBunny: release adopted row IDs before the original persistence callback.
            dialogOptions.onClose(popup);
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
