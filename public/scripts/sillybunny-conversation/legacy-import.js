/**
 * The one-time move of the data that the first versions of Conversation Mode kept in `localStorage`.
 *
 * Only the browser can read those keys, so the page collects them into threads and posts them to
 * `/api/sillybunny-conversation/import-legacy`, which writes them as conversations. A thread here has the shape of the
 * store that the server migration reads (`branches`, `activeBranchId`, the role `partner`), not the shape of the
 * conversations that the rest of the mode uses; this file is excluded from the rename of the stored names for that reason.
 */

import {
    CONVERSATION_KEY_PREFIX,
    DEFAULT_CHAT_ID,
    FOLLOWUP_COUNT_PREFIX,
    LAST_AUTO_MESSAGE_PREFIX,
    LAST_PREVIEW_PREFIX,
    LAST_SCHEDULE_TRIGGER_PREFIX,
    LAST_USER_ACTIVITY_PREFIX,
    SCHEDULE_PREFIX,
    SETTINGS_KEY_PREFIX,
    UNREAD_PREFIX,
} from './constants.js';
import {
    clearLegacyConversationUnreadStorage,
    getConversationPersonaId,
    getConversationStore,
    parsePositiveInt,
    safeParseSettings,
} from './context.js';
import { conversationData, reloadPageOnce } from './conversation-data-browser.js';
import { safeParseMessages } from './conversation-store-utils.js';
import { getScheduleStorageKey } from './schedule.js';

const IMPORT_RELOAD_FLAG = 'sb_conversation_reloaded_after_import';
const LEGACY_PREFIXES = Object.freeze([
    SETTINGS_KEY_PREFIX,
    CONVERSATION_KEY_PREFIX,
    SCHEDULE_PREFIX,
    LAST_USER_ACTIVITY_PREFIX,
    FOLLOWUP_COUNT_PREFIX,
    UNREAD_PREFIX,
    LAST_PREVIEW_PREFIX,
    LAST_AUTO_MESSAGE_PREFIX,
    LAST_SCHEDULE_TRIGGER_PREFIX,
]);

function getLegacyAvatars() {
    const avatars = new Set();
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || '';
        const prefix = LEGACY_PREFIXES.find(value => key.startsWith(value));
        if (prefix) {
            avatars.add(key.slice(prefix.length));
        }
    }
    return [...avatars].filter(Boolean);
}

function readJson(key) {
    try {
        return JSON.parse(localStorage.getItem(key));
    } catch {
        return null;
    }
}

/**
 * @param {string} avatar
 * @returns {object} A thread of the old store: what `localStorage` held for one character.
 */
export function buildLegacyThread(avatar) {
    const now = Date.now();
    const settingsRaw = localStorage.getItem(`${SETTINGS_KEY_PREFIX}${avatar}`);
    const conversationRaw = localStorage.getItem(`${CONVERSATION_KEY_PREFIX}${avatar}`);
    const messages = conversationRaw ? safeParseMessages(conversationRaw) : [];
    const lastActivity = parsePositiveInt(localStorage.getItem(`${LAST_USER_ACTIVITY_PREFIX}${avatar}`), now, 1);
    const scheduleTriggers = readJson(`${LAST_SCHEDULE_TRIGGER_PREFIX}${avatar}`);
    const schedule = readJson(getScheduleStorageKey(avatar));
    return {
        settings: settingsRaw ? safeParseSettings(settingsRaw) : {},
        schedule: schedule && typeof schedule === 'object' ? schedule : null,
        activeBranchId: DEFAULT_CHAT_ID,
        branches: {
            [DEFAULT_CHAT_ID]: {
                id: DEFAULT_CHAT_ID,
                name: 'Main',
                messages,
                preview: localStorage.getItem(`${LAST_PREVIEW_PREFIX}${avatar}`) || 'Conversation ready',
                unread: parsePositiveInt(localStorage.getItem(`${UNREAD_PREFIX}${avatar}`), 0, 0),
                lastActivity,
                followupCount: parsePositiveInt(localStorage.getItem(`${FOLLOWUP_COUNT_PREFIX}${avatar}`), 0, 0),
                lastAutoMessageAt: parsePositiveInt(localStorage.getItem(`${LAST_AUTO_MESSAGE_PREFIX}${avatar}`), 0, 0),
                scheduleTriggers: scheduleTriggers && typeof scheduleTriggers === 'object' ? scheduleTriggers : {},
                sessionMarkers: {},
                createdAt: lastActivity,
                updatedAt: lastActivity,
            },
        },
    };
}

/**
 * Moves the old `localStorage` data into conversations, once. Nothing is sent when the page has none of it or has moved
 * it before. After an import the page reloads once, because the server changed `settings.json` and the settings that
 * this page holds are older.
 * @returns {Promise<'none'|'imported'|'already_imported'>}
 */
export async function importLegacyLocalStorage() {
    if (typeof localStorage === 'undefined') {
        return 'none';
    }
    const store = getConversationStore();
    if (store.localStorageMigrated) {
        clearLegacyConversationUnreadStorage();
        return 'none';
    }

    const avatars = getLegacyAvatars();
    if (!avatars.length) {
        return 'none';
    }

    const answer = await conversationData.importLegacy({
        personaId: getConversationPersonaId(),
        characters: Object.fromEntries(avatars.map(avatar => [avatar, buildLegacyThread(avatar)])),
    });
    // The legacy keys stay in `localStorage` as a copy of what was moved; the server has set the flag in `settings.json`.
    store.localStorageMigrated = true;
    clearLegacyConversationUnreadStorage();
    if (answer.state === 'imported') {
        reloadPageOnce(IMPORT_RELOAD_FLAG);
    }
    return answer.state;
}
