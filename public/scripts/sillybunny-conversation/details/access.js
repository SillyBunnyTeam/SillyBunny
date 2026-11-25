/**
 * The seam between the details window and the rest of the mode. The pages read and write through these functions and
 * import nothing else from the mode's state, so that what a page needs from the mode is listed in one file.
 */

import { characters, getThumbnailUrl } from '../../../script.js';
import { AVAILABILITY_COPY, DEFAULT_SETTINGS, GEECHAN_DEFAULT_PROMPT } from '../constants.js';
import { getConversationStore, persistConversationStore } from '../context.js';
import { conversationData } from '../conversation-data-browser.js';
import { getCharacterForAvatar } from '../media.js';
import { getCharacterStatus } from '../schedule.js';
import { getGlobalConversationSettings, mergeConversationSettingsLayers } from '../settings-store.js';
import { describeSettingWrite } from './details-logic.js';

export { conversationData, GEECHAN_DEFAULT_PROMPT };

/** The conversation as the data module holds it, or null when it is gone. Read it; change it through `conversationData`. */
export function getView(conversationId) {
    return conversationId ? conversationData.get(conversationId) : null;
}

/** @throws {Error} When the conversation is gone, which the window reports as a page that could not be opened. */
export function requireView(conversationId) {
    const view = getView(conversationId);
    if (!view) {
        throw new Error(`The conversation ${conversationId} is not there.`);
    }
    return view;
}

// ---------------------------------------------------------------------------------------------------------------------
// Characters

export function getCard(avatar) {
    return avatar ? getCharacterForAvatar(avatar) : null;
}

/** The name on the card; a card that is gone shows the file name without its extension. */
export function getCardName(avatar) {
    return getCard(avatar)?.name || String(avatar ?? '').replace(/\.[a-z0-9]+$/i, '') || 'Character';
}

/** The thumbnail of a card, or an empty text for a card that is gone. */
export function getThumbnailUrlFor(avatar) {
    return getCard(avatar) ? getThumbnailUrl('avatar', avatar) : '';
}

/** The full picture of a card, which the profile page opens as a page of the window. */
export function getFullPictureUrl(avatar) {
    return getCard(avatar) ? `/characters/${encodeURIComponent(avatar)}` : '';
}

/** The picture that a group uploaded. The conversation's `updatedAt` is in the address so that a new picture replaces the cached one. */
export function getGroupAvatarUrl(view) {
    return `/api/sillybunny-conversation/avatar?id=${encodeURIComponent(view.id)}&v=${encodeURIComponent(view.updatedAt ?? 0)}`;
}

/** Every character that has a card, for the Add Member page. */
export function listCards() {
    return (Array.isArray(characters) ? characters : []).filter(card => card?.avatar);
}

/**
 * What a character is doing now, as one line: "Online", or "Busy · working".
 * @returns {{ status: string, label: string, line: string }}
 */
export function describeCharacterStatus(avatar) {
    const { status, activity } = getCharacterStatus(avatar);
    const label = AVAILABILITY_COPY[status]?.label ?? AVAILABILITY_COPY.online.label;
    return { status, label, line: activity ? `${label} · ${activity}` : label };
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings

/** The settings of a conversation as the mode reads them: the defaults, then its own, then the mode-wide ones. */
export function readSettings(view) {
    const settings = mergeConversationSettingsLayers(DEFAULT_SETTINGS, view.settings, getGlobalConversationSettings());
    if (typeof view.settings?.system_prompt === 'string') {
        settings.geechan_chatroom_prompt = view.settings.system_prompt;
    }
    return settings;
}

export function readModeSettings() {
    return mergeConversationSettingsLayers(DEFAULT_SETTINGS, getGlobalConversationSettings());
}

/** Saves the mode-wide key of one row to `settings.json`. */
function writeModeSetting(name, value) {
    const store = getConversationStore();
    store.settings = { ...store.settings, [name]: value };
    persistConversationStore();
}

/**
 * Saves one row. A row never saves anything but its own key, so a page that is open on a conversation cannot undo a
 * change that the mode made to another key in the meantime.
 */
export function writeSetting(view, key, value) {
    const write = describeSettingWrite(key, value);
    if (write.scope === 'mode') {
        writeModeSetting(write.name, write.value);
        return;
    }
    conversationData.patchConversation(view.id, { settings: { [write.name]: write.value } });
}

export function writeModeKey(key, value) {
    const write = describeSettingWrite(key, value);
    if (write.scope !== 'mode') {
        throw new RangeError(`"${key}" belongs to a conversation, not to the mode.`);
    }
    writeModeSetting(write.name, write.value);
}
