export function getDebouncedChatSaveAbortReason({
    scheduledGroupId,
    currentGroupId,
    scheduledCharacterId,
    currentCharacterId,
    scheduledChatId,
    currentChatId,
    scheduledGeneration,
    currentGeneration,
} = {}) {
    if (scheduledGroupId !== currentGroupId) {
        return 'group';
    }

    if (scheduledCharacterId !== currentCharacterId) {
        return 'character';
    }

    if (scheduledChatId !== currentChatId) {
        return 'chat';
    }

    if (scheduledGeneration !== currentGeneration) {
        return 'chat generation';
    }

    return '';
}

export function getQueuedChatSaveAbortReason({
    scheduledGroupId,
    currentGroupId,
    scheduledCharacterId,
    currentCharacterId,
    scheduledChatId,
    currentChatId,
    scheduledGeneration,
    currentGeneration,
} = {}) {
    if (scheduledGroupId !== undefined && scheduledGroupId !== currentGroupId) {
        return 'group';
    }

    if (scheduledCharacterId !== undefined && scheduledCharacterId !== currentCharacterId) {
        return 'character';
    }

    if (scheduledChatId !== undefined && scheduledChatId !== currentChatId) {
        return 'chat';
    }

    if (scheduledGeneration !== undefined && scheduledGeneration !== currentGeneration) {
        return 'chat generation';
    }

    return '';
}

