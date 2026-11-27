/**
 * The related memories of a conversation. Each source is one conversation with the summary of its active chat:
 * `{ groupId, avatar, members, summary, updatedAt }`, where `groupId` is empty for a direct conversation.
 */

function toUpdatedAt(value) {
    const updatedAt = Number(value || 0);
    return Number.isFinite(updatedAt) ? updatedAt : 0;
}

export function collectSoloConversationMemorySummary(sources, avatar) {
    if (!avatar || !Array.isArray(sources)) {
        return null;
    }

    const source = sources.find(item => !item.groupId && item.avatar === avatar);
    const summary = String(source?.summary || '').trim();
    if (!summary) {
        return null;
    }

    return { avatar, summary, updatedAt: toUpdatedAt(source.updatedAt) };
}

export function collectGroupConversationMemorySummaries(sources, avatar, { excludeGroupId = '', getGroupName = () => '', max = 4 } = {}) {
    if (!avatar || !Array.isArray(sources)) {
        return [];
    }

    const items = [];
    for (const source of sources) {
        if (!source.groupId || !source.members?.includes(avatar) || (excludeGroupId && source.groupId === String(excludeGroupId))) {
            continue;
        }

        const summary = String(source.summary || '').trim();
        if (!summary) {
            continue;
        }

        items.push({
            groupId: source.groupId,
            groupName: String(getGroupName(source.groupId) || '').trim(),
            summary,
            updatedAt: toUpdatedAt(source.updatedAt),
        });
    }

    const parsedMax = Number(max);
    const limit = Number.isFinite(parsedMax) ? Math.max(0, parsedMax) : undefined;
    return items
        .sort((first, second) => Number(second.updatedAt || 0) - Number(first.updatedAt || 0))
        .slice(0, limit);
}
