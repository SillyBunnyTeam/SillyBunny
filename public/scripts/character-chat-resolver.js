export function normalizeCharacterChatName(chatName) {
    return String(chatName || '').trim().replace(/\.jsonl$/i, '');
}

export function resolveCharacterChatNameForLoad({ persistedChat, existingChats = [], allowCreate = false, allowMissingPersisted = false, newChatName = '' } = {}) {
    const normalizedPersistedChat = normalizeCharacterChatName(persistedChat);

    if (normalizedPersistedChat && allowMissingPersisted) {
        return { chatName: normalizedPersistedChat, created: true };
    }

    const existingChatNames = existingChats
        .map(chatInfo => normalizeCharacterChatName(chatInfo?.file_name))
        .filter(Boolean);

    if (normalizedPersistedChat && existingChatNames.includes(normalizedPersistedChat)) {
        return { chatName: normalizedPersistedChat, created: false };
    }

    const latestChat = existingChatNames[0] || '';
    const nextChatName = latestChat || (allowCreate ? normalizeCharacterChatName(newChatName) : '');

    return {
        chatName: nextChatName,
        created: Boolean(!latestChat && allowCreate && nextChatName),
    };
}
