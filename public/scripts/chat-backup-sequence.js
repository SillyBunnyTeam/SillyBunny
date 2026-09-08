let activeSequence = null;

export function resetChatBackupSequence() {
    activeSequence = null;
}

export function getChatBackupSaveOptions(options, contextKey, createId) {
    if (typeof options.deferSequenceId === 'string' && options.deferSequenceId.trim()) {
        return options;
    }

    if (options.deferBackup === true) {
        if (activeSequence?.contextKey !== contextKey) {
            activeSequence = { contextKey, id: createId() };
        }
        return { ...options, deferSequenceId: activeSequence.id };
    }

    // Only an explicit closing save belongs to the agent run. Ordinary edits keep their own backup.
    const deferSequenceId = options.deferBackup === false && options.completeDeferredBackup === true && activeSequence?.contextKey === contextKey
        ? activeSequence.id
        : undefined;
    resetChatBackupSequence();
    return deferSequenceId ? { ...options, deferSequenceId } : options;
}
