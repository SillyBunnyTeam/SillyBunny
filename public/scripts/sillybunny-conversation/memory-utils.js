import { DEFAULT_BRANCH_ID, GROUP_CONVERSATION_STORE_PREFIX } from './constants.js';

function parseGroupConversationStoreKey(storeKey) {
    const value = String(storeKey || '');
    if (!value.startsWith(GROUP_CONVERSATION_STORE_PREFIX)) {
        return null;
    }

    const withoutPrefix = value.slice(GROUP_CONVERSATION_STORE_PREFIX.length);
    const separatorIndex = withoutPrefix.indexOf(':');
    if (separatorIndex < 0) {
        return null;
    }

    const groupId = withoutPrefix.slice(0, separatorIndex);
    const avatar = withoutPrefix.slice(separatorIndex + 1);
    return groupId && avatar ? { groupId, avatar } : null;
}

function getActiveMemoryBranch(threadStore) {
    const branches = threadStore?.branches && typeof threadStore.branches === 'object' ? threadStore.branches : {};
    const branchId = threadStore?.activeBranchId || DEFAULT_BRANCH_ID;
    return branches[branchId] || branches[DEFAULT_BRANCH_ID] || null;
}

export function collectSoloConversationMemorySummary(charactersStore, avatar) {
    if (!avatar || !charactersStore || typeof charactersStore !== 'object') {
        return null;
    }

    const threadStore = charactersStore[avatar];
    const branch = getActiveMemoryBranch(threadStore);
    const summary = String(threadStore?.memorySummary || branch?.memorySummary || '').trim();
    if (!summary) {
        return null;
    }

    const updatedAt = Number(threadStore?.memoryUpdatedAt || branch?.updatedAt || branch?.createdAt || 0);
    return {
        avatar,
        summary,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    };
}

export function collectGroupConversationMemorySummaries(charactersStore, avatar, { excludeGroupId = '', getGroupName = () => '', max = 4 } = {}) {
    if (!avatar || !charactersStore || typeof charactersStore !== 'object') {
        return [];
    }

    const items = [];
    Object.entries(charactersStore).forEach(([storeKey, threadStore]) => {
        const parsed = parseGroupConversationStoreKey(storeKey);
        if (!parsed || parsed.avatar !== avatar || (excludeGroupId && parsed.groupId === String(excludeGroupId))) {
            return;
        }

        const branch = getActiveMemoryBranch(threadStore);
        const summary = String(threadStore?.memorySummary || branch?.memorySummary || '').trim();
        if (!summary) {
            return;
        }

        const updatedAt = Number(threadStore?.memoryUpdatedAt || branch?.updatedAt || branch?.createdAt || 0);
        const groupName = String(getGroupName(parsed.groupId) || '').trim();
        items.push({
            groupId: parsed.groupId,
            groupName,
            summary,
            updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
        });
    });

    const parsedMax = Number(max);
    const limit = Number.isFinite(parsedMax) ? Math.max(0, parsedMax) : undefined;
    return items
        .sort((first, second) => Number(second.updatedAt || 0) - Number(first.updatedAt || 0))
        .slice(0, limit);
}
