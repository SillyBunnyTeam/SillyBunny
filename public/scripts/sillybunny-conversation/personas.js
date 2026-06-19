import { saveSettingsDebounced } from '../../script.js';
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
import { getConversationStore, getConversationThreadKey, getCurrentCharAvatar, persistConversationStore } from './context.js';
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

export function editUserPersonaStatus() {
    const nextStatus = globalThis.prompt?.('Set your Conversation persona status. Leave blank to clear it.', getUserPersonaStatus());
    if (typeof nextStatus !== 'string') {
        return;
    }

    setUserPersonaStatus(nextStatus);
    document.getElementById(CHROME_IDS.personaPicker)?.setAttribute('hidden', '');
    document.getElementById(CHROME_IDS.userStatusPicker)?.setAttribute('hidden', '');
    updateUserFooter();
}

export function safeParseWeeklySchedule(value) {
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
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

export function getConversationPersonaAppendixScopeKey() {
    const avatar = getCurrentCharAvatar();
    return String(getConversationThreadKey(avatar) || PERSONA_APPENDICES_DEFAULT_SCOPE_KEY);
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

export function getActiveConversationPersonaAppendixIds(avatarId) {
    const descriptor = power_user?.persona_descriptions?.[avatarId];
    const appendices = getConversationPersonaAppendices(avatarId);
    const appendixIds = new Set(appendices.map(appendix => appendix.id));
    const selections = descriptor?.[PERSONA_APPENDICES_SELECTIONS_KEY];
    const scopeKey = getConversationPersonaAppendixScopeKey();
    const activeIds = selections && typeof selections === 'object' && !Array.isArray(selections)
        ? selections[scopeKey] ?? selections[PERSONA_APPENDICES_DEFAULT_SCOPE_KEY] ?? []
        : [];
    return Array.isArray(activeIds)
        ? activeIds.map(String).filter((id, index, array) => appendixIds.has(id) && array.indexOf(id) === index)
        : [];
}

export function composeConversationPersonaDescription(avatarId) {
    const descriptor = power_user?.persona_descriptions?.[avatarId];
    const chunks = [];
    const baseDescription = String(descriptor?.description ?? '').trim();

    if (baseDescription) {
        chunks.push(baseDescription);
    }

    const activeIds = new Set(getActiveConversationPersonaAppendixIds(avatarId));
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

export function setActiveConversationPersonaAppendixIds(avatarId, ids) {
    const descriptor = power_user?.persona_descriptions?.[avatarId];
    if (!descriptor) {
        return;
    }

    const availableIds = new Set(getConversationPersonaAppendices(avatarId).map(appendix => appendix.id));
    const cleanIds = ids.map(String).filter((id, index, array) => availableIds.has(id) && array.indexOf(id) === index);
    const selections = descriptor[PERSONA_APPENDICES_SELECTIONS_KEY]
        && typeof descriptor[PERSONA_APPENDICES_SELECTIONS_KEY] === 'object'
        && !Array.isArray(descriptor[PERSONA_APPENDICES_SELECTIONS_KEY])
        ? descriptor[PERSONA_APPENDICES_SELECTIONS_KEY]
        : {};
    selections[getConversationPersonaAppendixScopeKey()] = cleanIds;
    descriptor[PERSONA_APPENDICES_SELECTIONS_KEY] = selections;

    if (avatarId === user_avatar) {
        power_user.persona_description = composeConversationPersonaDescription(avatarId);
    }

    saveSettingsDebounced();
    void eventSource.emit(event_types.PERSONA_UPDATED, avatarId);
}
