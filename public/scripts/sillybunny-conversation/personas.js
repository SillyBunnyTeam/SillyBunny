import { name1, saveSettingsDebounced } from '../../script.js';
import { event_types, eventSource } from '../events.js';
import { extension_settings } from '../extensions.js';
import { user_avatar } from '../personas.js';
import { power_user } from '../power-user.js';
import {
    AVAILABILITY_COPY,
    CHROME_IDS,
    PERSONA_APPENDICES_DEFAULT_SCOPE_KEY,
    PERSONA_APPENDICES_SELECTIONS_KEY,
    USER_STATUS_OPTIONS,
    USER_STATUS_STORAGE_KEY,
} from './constants.js';
import {
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationRecord,
    getConversationStore,
    getConversationKey,
    getCurrentCharAvatar,
    isAvatarInConversationGroup,
    persistConversationStore,
} from './context.js';
import { promptConversationText } from './dialogs.js';
import { updateUserFooter } from './pickers.js';

export function getAvailabilityCopy(status) {
    return AVAILABILITY_COPY[status] ?? AVAILABILITY_COPY.online;
}

export function getUserStatus() {
    const status = getConversationStore().userStatus || localStorage.getItem(USER_STATUS_STORAGE_KEY) || 'online';
    return USER_STATUS_OPTIONS.includes(status) ? status : 'online';
}

export function normalizeUserPersonaStatus(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function getUserPersonaStatus() {
    return normalizeUserPersonaStatus(getConversationStore().userPersonaStatus);
}

export function setUserStatus(status) {
    if (USER_STATUS_OPTIONS.includes(status)) {
        getConversationStore().userStatus = status;
        persistConversationStore();
    }
}

export function setUserPersonaStatus(statusText) {
    getConversationStore().userPersonaStatus = normalizeUserPersonaStatus(statusText);
    persistConversationStore();
}

export async function editUserPersonaStatus() {
    const nextStatus = await promptConversationText({
        title: 'Status Message',
        text: 'Leave blank to clear it',
        defaultValue: getUserPersonaStatus(),
    });
    if (typeof nextStatus !== 'string') {
        return;
    }

    setUserPersonaStatus(nextStatus);
    document.getElementById(CHROME_IDS.personaPicker)?.setAttribute('hidden', '');
    document.getElementById(CHROME_IDS.userStatusPicker)?.setAttribute('hidden', '');
    updateUserFooter();
}

export function getConnectionProfiles() {
    return extension_settings.connectionManager?.profiles ?? [];
}

export function getPersonaOptions() {
    const personas = power_user?.personas;
    if (!personas || typeof personas !== 'object') {
        return [];
    }

    return Object.entries(personas).map(([avatarId, personaName]) => ({ avatarId, personaName: String(personaName) }));
}

export function getConversationPersonaName(personaId, fallback = 'User') {
    const targetPersonaId = String(personaId || '').trim();
    const fallbackName = String(fallback || 'User').trim() || 'User';
    const storedName = String(power_user?.personas?.[targetPersonaId] || '').trim();
    if (storedName) {
        return storedName;
    }
    if (targetPersonaId && targetPersonaId === getConversationPersonaId()) {
        return String(name1 || fallbackName).trim() || fallbackName;
    }
    return fallbackName;
}

/**
 * The key under which a persona's Scenario Notes for one conversation are stored: the id of the conversation. A
 * conversation that came from the old store also has its old key, which is read as a fallback.
 */
export function getConversationPersonaAppendixScopeKey({ avatar = getCurrentCharAvatar(), groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const targetGroupId = groupId && isAvatarInConversationGroup(avatar, groupId, { personaId }) ? groupId : '';
    const key = getConversationKey(avatar, targetGroupId, { personaId });
    return key && !key.startsWith('pending:') ? key : PERSONA_APPENDICES_DEFAULT_SCOPE_KEY;
}

function getLegacyConversationPersonaAppendixScopeKeys({ avatar = getCurrentCharAvatar(), groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const targetGroupId = groupId && isAvatarInConversationGroup(avatar, groupId, { personaId }) ? groupId : '';
    const record = getConversationRecord(avatar, { groupId: targetGroupId, personaId });
    return [record?.legacyKey, targetGroupId ? `group:${targetGroupId}:${avatar}` : avatar].filter(Boolean);
}

function normalizeConversationPersonaAppendixSelections(descriptor) {
    const source = descriptor?.[PERSONA_APPENDICES_SELECTIONS_KEY];
    if (Array.isArray(source)) {
        const selections = { [PERSONA_APPENDICES_DEFAULT_SCOPE_KEY]: [...source] };
        descriptor[PERSONA_APPENDICES_SELECTIONS_KEY] = selections;
        return { selections, changed: true };
    }
    if (source && typeof source === 'object') {
        return { selections: source, changed: false };
    }

    const selections = {};
    if (descriptor) {
        descriptor[PERSONA_APPENDICES_SELECTIONS_KEY] = selections;
    }
    return { selections, changed: Boolean(descriptor && typeof source !== 'undefined') };
}

export function getConversationPersonaAppendices(avatarId) {
    const descriptor = power_user?.persona_descriptions?.[avatarId];
    if (!descriptor || !Array.isArray(descriptor.appendices)) {
        return [];
    }

    return descriptor.appendices.map((appendix, index) => {
        const name = String(appendix?.name || `Scenario Note ${index + 1}`).trim() || `Scenario Note ${index + 1}`;
        const id = String(appendix?.id || `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index}`).trim();
        return {
            id,
            name,
            description: String(appendix?.description ?? ''),
        };
    }).filter(appendix => appendix.id);
}

export function getActiveConversationPersonaAppendixIds(avatarId, options = {}) {
    const descriptor = power_user?.persona_descriptions?.[avatarId];
    const appendices = getConversationPersonaAppendices(avatarId);
    const appendixIds = new Set(appendices.map(appendix => appendix.id));
    const normalized = normalizeConversationPersonaAppendixSelections(descriptor);
    const selections = normalized.selections;
    const scopeKey = getConversationPersonaAppendixScopeKey(options);
    let changed = normalized.changed;
    if (!Object.prototype.hasOwnProperty.call(selections, scopeKey)) {
        const legacyScopeKey = getLegacyConversationPersonaAppendixScopeKeys(options).find(key => Object.prototype.hasOwnProperty.call(selections, key));
        const legacyIds = (legacyScopeKey ? selections[legacyScopeKey] : undefined) ?? selections[PERSONA_APPENDICES_DEFAULT_SCOPE_KEY];
        if (Array.isArray(legacyIds)) {
            selections[scopeKey] = [...legacyIds];
            changed = true;
        }
    }
    if (changed) {
        saveSettingsDebounced();
    }
    const activeIds = selections[scopeKey] ?? selections[PERSONA_APPENDICES_DEFAULT_SCOPE_KEY] ?? [];
    return Array.isArray(activeIds)
        ? activeIds.map(String).filter((id, index, array) => appendixIds.has(id) && array.indexOf(id) === index)
        : [];
}

export function composeConversationPersonaDescription(avatarId, options = {}) {
    const descriptor = power_user?.persona_descriptions?.[avatarId];
    const chunks = [];
    const baseDescription = String(descriptor?.description ?? '').trim();

    if (baseDescription) {
        chunks.push(baseDescription);
    }

    const activeIds = new Set(getActiveConversationPersonaAppendixIds(avatarId, options));
    for (const appendix of getConversationPersonaAppendices(avatarId)) {
        if (activeIds.has(appendix.id) && appendix.description.trim()) {
            // SillyBunny: wrap the appendix label in parentheses instead of square brackets.
            // Square brackets collide with Conversation Mode's reply command grammar
            // ([selfie], [schedule_update:], [reminder:]); echoing them in a reply caused
            // the strip pass to blank it entirely.
            chunks.push(`(${appendix.name})\n${appendix.description.trim()}`);
        }
    }

    return chunks.join('\n\n');
}

export function setActiveConversationPersonaAppendixIds(avatarId, ids, options = {}) {
    const descriptor = power_user?.persona_descriptions?.[avatarId];
    if (!descriptor) {
        return;
    }

    const availableIds = new Set(getConversationPersonaAppendices(avatarId).map(appendix => appendix.id));
    const cleanIds = ids.map(String).filter((id, index, array) => availableIds.has(id) && array.indexOf(id) === index);
    const selections = normalizeConversationPersonaAppendixSelections(descriptor).selections;
    selections[getConversationPersonaAppendixScopeKey(options)] = cleanIds;
    descriptor[PERSONA_APPENDICES_SELECTIONS_KEY] = selections;

    if (avatarId === user_avatar) {
        power_user.persona_description = composeConversationPersonaDescription(avatarId, options);
    }

    saveSettingsDebounced();
    void eventSource.emit(event_types.PERSONA_UPDATED, avatarId);
}
