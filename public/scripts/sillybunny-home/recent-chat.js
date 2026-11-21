/**
 * @typedef {object} RecentChatIdentity
 * @property {string} file
 * @property {string} avatar
 * @property {string} group
 * @property {string} branchId
 */

/**
 * @typedef {object} RecentChatTarget
 * @property {string} avatarId
 * @property {string} groupId
 * @property {string} fileName
 * @property {string} branchId
 * @property {string} branchName
 * @property {boolean} isConversation
 * @property {object|undefined} recentChat The matching entry of the recent chats list, if the list has one.
 */

/**
 * @param {Element} row A rendered `.recentChat` element.
 * @returns {RecentChatIdentity}
 */
export function readRecentChatIdentity(row) {
    return {
        file: row.getAttribute('data-file') ?? '',
        avatar: row.getAttribute('data-avatar') ?? '',
        group: row.getAttribute('data-group') ?? '',
        branchId: row.getAttribute('data-conversation-branch-id') ?? '',
    };
}

/**
 * Finds the row that stands for the same chat in a panel that was rendered again.
 * @param {ParentNode} root
 * @param {RecentChatIdentity} identity
 * @returns {HTMLElement|null}
 */
export function findRecentChatRow(root, identity) {
    const rows = /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('.recentChat'));
    return Array.from(rows).find((row) => {
        const candidate = readRecentChatIdentity(row);
        return candidate.file === identity.file
            && candidate.avatar === identity.avatar
            && candidate.group === identity.group
            && candidate.branchId === identity.branchId;
    }) ?? null;
}

/**
 * Reads what pin, rename and delete need from one row, so the three actions share one lookup.
 * @param {Element} row A rendered `.recentChat` element.
 * @param {Array<object>} chats The recent chats list the panel was rendered from.
 * @returns {RecentChatTarget}
 */
export function resolveRecentChatTarget(row, chats) {
    const { file: fileName, avatar: avatarId, group: groupId, branchId } = readRecentChatIdentity(row);
    const isConversation = row.getAttribute('data-recent-chat-type') === 'conversation';
    const recentChat = chats.find(chat => isConversation
        ? chat.is_conversation && chat.avatar === avatarId && String(chat.group || '') === groupId && chat.conversation_branch_id === branchId
        : chat.chat_name === fileName && ((chat.is_group && chat.group === groupId) || (!chat.is_group && chat.avatar === avatarId)));

    return {
        avatarId,
        groupId,
        fileName,
        branchId,
        branchName: row.getAttribute('data-conversation-branch-name') ?? '',
        isConversation,
        recentChat,
    };
}
