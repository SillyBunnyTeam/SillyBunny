export function normalizeConversationUnreadCount(value) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getUnreadBranches(store) {
    const characters = store?.characters && typeof store.characters === 'object' ? store.characters : {};
    return Object.entries(characters).flatMap(([threadKey, threadStore]) => {
        const branches = threadStore?.branches && typeof threadStore.branches === 'object' ? threadStore.branches : {};
        return Object.values(branches)
            .filter(branch => branch && typeof branch === 'object')
            .map(branch => ({ threadKey, threadStore, branch }));
    });
}

export function clearConversationUnreadStore(store) {
    let changed = false;
    let cleared = 0;

    for (const { branch } of getUnreadBranches(store)) {
        const unread = normalizeConversationUnreadCount(branch.unread);
        if (unread > 0) {
            cleared += unread;
        }
        if (branch.unread !== 0) {
            branch.unread = 0;
            changed = true;
        }
    }

    return { changed, cleared };
}

export function sanitizeConversationUnreadStore(store, isThreadCountable) {
    let changed = false;
    let cleared = 0;

    for (const { threadKey, threadStore, branch } of getUnreadBranches(store)) {
        const unread = normalizeConversationUnreadCount(branch.unread);
        const countable = typeof isThreadCountable === 'function' ? Boolean(isThreadCountable(threadKey, threadStore)) : true;

        if (branch.unread !== unread) {
            branch.unread = unread;
            changed = true;
        }
        if (!countable && unread > 0) {
            branch.unread = 0;
            cleared += unread;
            changed = true;
        }
    }

    return { changed, cleared };
}
