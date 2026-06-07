export function getDebouncedChatSaveAbortReason({
    scheduledGroupId,
    currentGroupId,
    scheduledCharacterId,
    currentCharacterId,
    scheduledChatId,
    currentChatId,
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

    return '';
}
