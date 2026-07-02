/**
 * Conversation Mode REST API - Thread Management
 *
 * Functions for managing conversation threads and branches.
 */

import {
    DEFAULT_BRANCH_ID,
    DEFAULT_SETTINGS,
    MAX_THREAD_MESSAGES,
} from '../../public/scripts/sillybunny-conversation/constants.js';
import { safeParseThread } from '../../public/scripts/sillybunny-conversation/thread-store-utils.js';
import { getObject, parsePositiveInt, isObject } from './conversation-utils.js';
import { getConversationThreadKey } from './conversation-store.js';

/**
 * Create a new conversation branch
 */
export function createConversationBranch(name = 'Main', id = DEFAULT_BRANCH_ID) {
    const now = Date.now();
    return {
        id,
        name,
        messages: [],
        preview: 'Conversation ready',
        unread: 0,
        lastActivity: now,
        followupCount: 0,
        lastAutoMessageAt: 0,
        scheduleTriggers: {},
        sessionMarkers: {},
        memorySummary: '',
        memoryMessageCount: 0,
        memoryUpdatedAt: 0,
        createdAt: now,
        updatedAt: now,
    };
}

/**
 * Normalize a conversation branch
 */
export function normalizeConversationBranch(branch, id = DEFAULT_BRANCH_ID) {
    const now = Date.now();
    const target = isObject(branch)
        ? branch
        : createConversationBranch(id === DEFAULT_BRANCH_ID ? 'Main' : 'Conversation', id);

    target.id = target.id || id;
    target.name = target.name || (id === DEFAULT_BRANCH_ID ? 'Main' : 'Conversation');
    target.messages = safeParseThread(target.messages).slice(-MAX_THREAD_MESSAGES);
    target.preview = typeof target.preview === 'string' ? target.preview : 'Conversation ready';
    target.unread = parsePositiveInt(target.unread, 0, 0);
    target.lastActivity = parsePositiveInt(target.lastActivity, now, 0);
    target.followupCount = parsePositiveInt(target.followupCount, 0, 0);
    target.lastAutoMessageAt = parsePositiveInt(target.lastAutoMessageAt, 0, 0);
    target.scheduleTriggers = getObject(target.scheduleTriggers);
    target.sessionMarkers = getObject(target.sessionMarkers);
    target.memorySummary = typeof target.memorySummary === 'string' ? target.memorySummary : '';
    target.memoryMessageCount = parsePositiveInt(target.memoryMessageCount, 0, 0);
    target.memoryUpdatedAt = parsePositiveInt(target.memoryUpdatedAt, 0, 0);
    target.createdAt = parsePositiveInt(target.createdAt, now, 0);
    target.updatedAt = parsePositiveInt(target.updatedAt, target.createdAt, 0);
    return target;
}

/**
 * Get or create a thread store for an avatar
 */
export function getConversationThreadStore(store, avatar, groupId = '', { create = true, personaId = '' } = {}) {
    const threadKey = getConversationThreadKey(avatar, groupId, personaId);
    if (!threadKey) {
        return null;
    }

    store.characters = getObject(store.characters);
    if (!store.characters[threadKey]) {
        if (!create) {
            return null;
        }

        store.characters[threadKey] = {
            settings: { ...DEFAULT_SETTINGS },
            schedule: null,
            activeBranchId: DEFAULT_BRANCH_ID,
            branches: {
                [DEFAULT_BRANCH_ID]: createConversationBranch('Main', DEFAULT_BRANCH_ID),
            },
        };
    }

    const threadStore = store.characters[threadKey];
    threadStore.settings = getObject(threadStore.settings);
    threadStore.branches = getObject(threadStore.branches);
    threadStore.activeBranchId = threadStore.activeBranchId || DEFAULT_BRANCH_ID;
    if (!threadStore.branches[threadStore.activeBranchId]) {
        threadStore.branches[threadStore.activeBranchId] = createConversationBranch(
            threadStore.activeBranchId === DEFAULT_BRANCH_ID ? 'Main' : 'Conversation',
            threadStore.activeBranchId,
        );
    }
    threadStore.branches[threadStore.activeBranchId] = normalizeConversationBranch(
        threadStore.branches[threadStore.activeBranchId],
        threadStore.activeBranchId,
    );
    threadStore.threadAvatar = avatar;
    threadStore.groupId = groupId || '';
    return threadStore;
}

/**
 * Get the active branch for a thread
 */
export function getActiveConversationBranch(store, avatar, groupId = '', { create = true, personaId = '' } = {}) {
    const threadStore = getConversationThreadStore(store, avatar, groupId, { create, personaId });
    if (!threadStore) {
        return null;
    }

    const branchId = threadStore.activeBranchId || DEFAULT_BRANCH_ID;
    threadStore.branches[branchId] = normalizeConversationBranch(threadStore.branches[branchId], branchId);
    return threadStore.branches[branchId];
}
