export function normalizeConversationUnreadCount(value) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function getConversationUnreadCount(conversationRecord) {
    const branches = conversationRecord?.branches && typeof conversationRecord.branches === 'object' ? conversationRecord.branches : {};
    return Object.values(branches).reduce((total, chat) => total + normalizeConversationUnreadCount(chat?.unread), 0);
}

export function setConversationUnreadCount(conversationRecord, count, { chatId = '' } = {}) {
    const branches = conversationRecord?.branches && typeof conversationRecord.branches === 'object' ? conversationRecord.branches : {};
    const unread = normalizeConversationUnreadCount(count);
    if (chatId) {
        if (!branches[chatId] || typeof branches[chatId] !== 'object') {
            return false;
        }
        branches[chatId].unread = unread;
        return true;
    }

    const activeBranchId = conversationRecord?.activeBranchId;
    if (unread > 0 && activeBranchId && branches[activeBranchId]) {
        branches[activeBranchId].unread = unread;
        return true;
    }
    if (unread === 0) {
        Object.values(branches).forEach((chat) => {
            if (chat && typeof chat === 'object') {
                chat.unread = 0;
            }
        });
        return true;
    }

    return false;
}

function getUnreadChats(store) {
    const characters = store?.characters && typeof store.characters === 'object' ? store.characters : {};
    return Object.entries(characters).flatMap(([conversationKey, conversationRecord]) => {
        const branches = conversationRecord?.branches && typeof conversationRecord.branches === 'object' ? conversationRecord.branches : {};
        return Object.values(branches)
            .filter(chat => chat && typeof chat === 'object')
            .map(chat => ({ conversationKey, conversationRecord, chat }));
    });
}

export function clearConversationUnreadStore(store, shouldClearConversation = () => true) {
    let changed = false;
    let cleared = 0;

    for (const { conversationKey, conversationRecord, chat } of getUnreadChats(store)) {
        if (!shouldClearConversation(conversationKey, conversationRecord)) {
            continue;
        }

        const unread = normalizeConversationUnreadCount(chat.unread);
        if (unread > 0) {
            cleared += unread;
        }
        if (chat.unread !== 0) {
            chat.unread = 0;
            changed = true;
        }
    }

    return { changed, cleared };
}

export function sanitizeConversationUnreadStore(store, isConversationCountable) {
    let changed = false;
    let cleared = 0;

    for (const { conversationKey, conversationRecord, chat } of getUnreadChats(store)) {
        const unread = normalizeConversationUnreadCount(chat.unread);
        const countable = typeof isConversationCountable === 'function' ? Boolean(isConversationCountable(conversationKey, conversationRecord)) : true;

        if (chat.unread !== unread) {
            chat.unread = unread;
            changed = true;
        }
        if (!countable && unread > 0) {
            chat.unread = 0;
            cleared += unread;
            changed = true;
        }
    }

    return { changed, cleared };
}
