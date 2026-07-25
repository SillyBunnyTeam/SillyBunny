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
import {
    getObject,
    getOwnRecord,
    getSafeRecord,
    hasOwn,
    parsePositiveInt,
    isObject,
    isSafeConversationPropertyKey,
    isSafeConversationMessageId,
    normalizeConversationAttachments,
} from './conversation-utils.js';
import { getConversationThreadKey } from './conversation-store.js';

const ORIGINAL_CONVERSATION_MESSAGE_ID = Symbol('originalConversationMessageId');

function getSafeBranchId(value, fallback = DEFAULT_BRANCH_ID) {
    const branchId = String(value || '').trim();
    return branchId && branchId.length <= 256 && isSafeConversationPropertyKey(branchId) ? branchId : fallback;
}

/**
 * Create a new conversation branch
 */
export function createConversationBranch(name = 'Main', id = DEFAULT_BRANCH_ID) {
    const now = Date.now();
    const safeId = getSafeBranchId(id);
    return {
        id: safeId,
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
    const safeId = getSafeBranchId(id);
    const target = isObject(branch)
        ? getOwnRecord(branch)
        : createConversationBranch(safeId === DEFAULT_BRANCH_ID ? 'Main' : 'Conversation', safeId);

    target.id = safeId;
    target.name = target.name || (safeId === DEFAULT_BRANCH_ID ? 'Main' : 'Conversation');
    const messages = Array.isArray(target.messages)
        ? target.messages.map(message => {
            if (!isObject(message)) {
                return message;
            }
            const normalizedMessage = { ...getOwnRecord(message), extra: normalizeConversationAttachments(message.extra) };
            normalizedMessage[ORIGINAL_CONVERSATION_MESSAGE_ID] = message.id;
            return normalizedMessage;
        })
        : target.messages;
    target.messages = repairConversationMessageIds(safeParseThread(messages));
    target.preview = typeof target.preview === 'string' ? target.preview : 'Conversation ready';
    target.unread = parsePositiveInt(target.unread, 0, 0);
    target.lastActivity = parsePositiveInt(target.lastActivity, now, 0);
    target.followupCount = parsePositiveInt(target.followupCount, 0, 0);
    target.lastAutoMessageAt = parsePositiveInt(target.lastAutoMessageAt, 0, 0);
    target.scheduleTriggers = getSafeRecord(target.scheduleTriggers);
    target.sessionMarkers = getSafeRecord(target.sessionMarkers);
    target.memorySummary = typeof target.memorySummary === 'string' ? target.memorySummary : '';
    target.memoryMessageCount = parsePositiveInt(target.memoryMessageCount, 0, 0);
    target.memoryUpdatedAt = parsePositiveInt(target.memoryUpdatedAt, 0, 0);
    target.createdAt = parsePositiveInt(target.createdAt, now, 0);
    target.updatedAt = parsePositiveInt(target.updatedAt, target.createdAt, 0);
    return target;
}

function repairConversationMessageIds(messages) {
    const reservedSafeIds = new Set(messages
        .map(message => typeof message[ORIGINAL_CONVERSATION_MESSAGE_ID] === 'string'
            ? message[ORIGINAL_CONVERSATION_MESSAGE_ID]
            : '')
        .filter(isSafeConversationMessageId));
    const usedIds = new Set(reservedSafeIds);
    const retainedSafeIds = new Set();
    const remappedIds = new Map();
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        const originalValue = message[ORIGINAL_CONVERSATION_MESSAGE_ID];
        delete message[ORIGINAL_CONVERSATION_MESSAGE_ID];
        const originalId = typeof originalValue === 'string' ? originalValue : String(originalValue ?? '');
        const originalIdIsSafe = typeof originalValue === 'string' && isSafeConversationMessageId(originalId);
        if (originalIdIsSafe && !retainedSafeIds.has(originalId)) {
            message.id = originalId;
            retainedSafeIds.add(originalId);
            continue;
        }

        const timestamp = Number(message.created_at);
        const createdAt = Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : index;
        const baseId = `legacy-${createdAt}-${index}`;
        let nextId = baseId;
        let suffix = 1;
        while (usedIds.has(nextId)) {
            nextId = `${baseId}-${suffix}`;
            suffix += 1;
        }
        message.id = nextId;
        usedIds.add(nextId);
        if (originalId && !originalIdIsSafe && !remappedIds.has(originalId)) {
            remappedIds.set(originalId, nextId);
        }
    }

    if (!remappedIds.size) {
        return messages;
    }
    for (const message of messages) {
        const extra = getObject(message.extra);
        const replyReference = getObject(extra.conversation_reply_to);
        const nextReplyId = remappedIds.get(String(replyReference.messageId || ''));
        if (nextReplyId) {
            message.extra = {
                ...extra,
                conversation_reply_to: {
                    ...replyReference,
                    messageId: nextReplyId,
                },
            };
        }
    }
    return messages;
}

function getLegacyMessageFingerprint(message) {
    const normalizeValue = (value) => {
        if (Array.isArray(value)) {
            return value.map(normalizeValue);
        }
        if (isObject(value)) {
            return Object.keys(value).sort().reduce((result, key) => {
                result[key] = normalizeValue(value[key]);
                return result;
            }, {});
        }
        return value;
    };
    return JSON.stringify(normalizeValue(message));
}

function mergeLegacyMessages(destinationMessages, sourceMessages) {
    const destination = Array.isArray(destinationMessages) ? destinationMessages : [];
    const source = Array.isArray(sourceMessages) ? sourceMessages : [];
    const byId = new Map(destination.map(message => [String(message?.id || ''), message]));
    const fingerprintCounts = destination.reduce((counts, message) => {
        if (!message?.id) {
            const fingerprint = getLegacyMessageFingerprint(message);
            counts.set(fingerprint, (counts.get(fingerprint) || 0) + 1);
        }
        return counts;
    }, new Map());
    const sourceFingerprintCounts = new Map();
    let complete = true;
    let changed = false;

    for (const message of source) {
        const messageId = String(message?.id || '');
        if (!messageId) {
            const fingerprint = getLegacyMessageFingerprint(message);
            const occurrence = (sourceFingerprintCounts.get(fingerprint) || 0) + 1;
            sourceFingerprintCounts.set(fingerprint, occurrence);
            if ((fingerprintCounts.get(fingerprint) || 0) >= occurrence) {
                continue;
            }
            destination.push(message);
            fingerprintCounts.set(fingerprint, occurrence);
            changed = true;
            continue;
        }

        const existing = byId.get(messageId);
        if (!existing) {
            destination.push(message);
            byId.set(messageId, message);
            changed = true;
        } else if (JSON.stringify(existing) !== JSON.stringify(message)) {
            complete = false;
        }
    }

    destination.sort((left, right) => Number(left?.created_at || 0) - Number(right?.created_at || 0));
    return { messages: destination, complete, changed };
}

function mergeLegacyThreadStore(destination, source) {
    let changed = false;
    let complete = true;
    for (const [key, value] of Object.entries(source)) {
        if (key === 'branches' || key === 'settings') {
            continue;
        }
        if (destination[key] === undefined || destination[key] === null || destination[key] === '') {
            destination[key] = value;
            changed = true;
        } else if (JSON.stringify(destination[key]) !== JSON.stringify(value)) {
            complete = false;
        }
    }

    const sourceSettings = getObject(source.settings);
    const destinationSettings = getObject(destination.settings);
    const mergedSettings = { ...sourceSettings, ...destinationSettings };
    for (const [key, value] of Object.entries(sourceSettings)) {
        if (hasOwn(destinationSettings, key) && JSON.stringify(destinationSettings[key]) !== JSON.stringify(value)) {
            complete = false;
        }
    }
    if (JSON.stringify(mergedSettings) !== JSON.stringify(destinationSettings)) {
        destination.settings = mergedSettings;
        changed = true;
    }

    const sourceBranches = getObject(source.branches);
    destination.branches = getSafeRecord(destination.branches);
    for (const [branchId, sourceBranch] of Object.entries(sourceBranches)) {
        const destinationBranch = destination.branches[branchId];
        if (!destinationBranch) {
            destination.branches[branchId] = sourceBranch;
            changed = true;
            continue;
        }
        for (const [key, value] of Object.entries(getObject(sourceBranch))) {
            if (key === 'messages') {
                continue;
            }
            if (destinationBranch[key] === undefined || destinationBranch[key] === null || destinationBranch[key] === '') {
                destinationBranch[key] = value;
                changed = true;
            } else if (JSON.stringify(destinationBranch[key]) !== JSON.stringify(value)) {
                complete = false;
            }
        }
        const mergedMessages = mergeLegacyMessages(destinationBranch.messages, sourceBranch?.messages);
        destinationBranch.messages = mergedMessages.messages;
        complete = complete && mergedMessages.complete;
        changed = changed || mergedMessages.changed;
    }
    return { complete, changed };
}

function migrateLegacyThreadStore(store, avatar, groupId, personaId, scopedKey) {
    if (!personaId) {
        return;
    }
    const legacyKey = getConversationThreadKey(avatar, groupId, '');
    if (!legacyKey || legacyKey === scopedKey || !hasOwn(store.characters, legacyKey) || !isObject(store.characters[legacyKey])) {
        return;
    }

    store.legacyThreadPersonaAssignments = getSafeRecord(store.legacyThreadPersonaAssignments);
    const assignment = String(store.legacyThreadPersonaAssignments[legacyKey] || '').trim();
    if (assignment && assignment !== personaId) {
        return;
    }
    if (!hasOwn(store.characters, scopedKey) || !isObject(store.characters[scopedKey])) {
        store.characters[scopedKey] = store.characters[legacyKey];
        delete store.characters[legacyKey];
        delete store.legacyThreadPersonaAssignments[legacyKey];
        return;
    }

    const merged = mergeLegacyThreadStore(store.characters[scopedKey], store.characters[legacyKey]);
    if (merged.complete) {
        delete store.characters[legacyKey];
        delete store.legacyThreadPersonaAssignments[legacyKey];
    } else {
        store.legacyThreadPersonaAssignments[legacyKey] = personaId;
    }
}

function mergeGroupMessages(destinationMessages, sourceMessages) {
    const destination = Array.isArray(destinationMessages) ? destinationMessages : [];
    const fingerprintCounts = destination.reduce((counts, message) => {
        const fingerprint = getLegacyMessageFingerprint(message);
        counts.set(fingerprint, (counts.get(fingerprint) || 0) + 1);
        return counts;
    }, new Map());
    const sourceCounts = new Map();
    for (const message of Array.isArray(sourceMessages) ? sourceMessages : []) {
        const fingerprint = getLegacyMessageFingerprint(message);
        const occurrence = (sourceCounts.get(fingerprint) || 0) + 1;
        sourceCounts.set(fingerprint, occurrence);
        if ((fingerprintCounts.get(fingerprint) || 0) >= occurrence) {
            continue;
        }
        destination.push(message);
        fingerprintCounts.set(fingerprint, occurrence);
    }
    destination.sort((left, right) => Number(left?.created_at || 0) - Number(right?.created_at || 0));
    return destination;
}

function getMergedBranchId(branchId, avatar, branches) {
    const safeAvatar = String(avatar || 'member').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'member';
    const stem = `${branchId}-merged-${safeAvatar}`.slice(0, 240);
    let candidate = stem;
    let suffix = 2;
    while (hasOwn(branches, candidate)) {
        candidate = `${stem.slice(0, 250 - String(suffix).length)}-${suffix}`;
        suffix += 1;
    }
    return candidate;
}

function mergeGroupBranch(destination, source) {
    const destinationUpdatedAt = Number(destination.updatedAt || destination.lastActivity || 0);
    const sourceUpdatedAt = Number(source.updatedAt || source.lastActivity || 0);
    for (const [key, value] of Object.entries(source)) {
        if (['messages', 'unread', 'scheduleTriggers', 'sessionMarkers'].includes(key)) {
            continue;
        }
        if (destination[key] === undefined || destination[key] === null || destination[key] === '') {
            destination[key] = value;
        }
    }
    destination.messages = mergeGroupMessages(destination.messages, source.messages);
    destination.unread = Math.min(
        Number.MAX_SAFE_INTEGER,
        parsePositiveInt(destination.unread, 0, 0) + parsePositiveInt(source.unread, 0, 0),
    );
    destination.scheduleTriggers = { ...getObject(source.scheduleTriggers), ...getObject(destination.scheduleTriggers) };
    destination.sessionMarkers = { ...getObject(source.sessionMarkers), ...getObject(destination.sessionMarkers) };
    for (const field of ['lastActivity', 'lastAutoMessageAt', 'updatedAt', 'memoryUpdatedAt', 'memoryMessageCount']) {
        destination[field] = Math.max(Number(destination[field] || 0), Number(source[field] || 0));
    }
    if (sourceUpdatedAt > destinationUpdatedAt && source.preview) {
        destination.preview = source.preview;
    }
}

function mergeGroupThreadStore(destination, source, sourceAvatar) {
    for (const [key, value] of Object.entries(source)) {
        if (['branches', 'settings', 'threadAvatar', 'groupId'].includes(key)) {
            continue;
        }
        if (destination[key] === undefined || destination[key] === null || destination[key] === '') {
            destination[key] = value;
        }
    }
    destination.settings = { ...getObject(source.settings), ...getObject(destination.settings) };
    destination.branches = getSafeRecord(destination.branches);
    for (const [branchId, sourceBranchValue] of Object.entries(getObject(source.branches))) {
        const sourceBranch = getOwnRecord(sourceBranchValue);
        const destinationBranch = destination.branches[branchId];
        if (!isObject(destinationBranch)) {
            destination.branches[branchId] = sourceBranch;
            continue;
        }

        const mergedMessages = mergeGroupMessages([...(destinationBranch.messages || [])], sourceBranch.messages);
        if (mergedMessages.length > MAX_THREAD_MESSAGES) {
            // Keep overflow history as a branch instead of silently dropping either alias.
            const mergedBranchId = getMergedBranchId(branchId, sourceAvatar, destination.branches);
            sourceBranch.id = mergedBranchId;
            destination.branches[mergedBranchId] = sourceBranch;
            continue;
        }
        mergeGroupBranch(destinationBranch, sourceBranch);
    }
}

function getGroupThreadRank(threadStore) {
    const branches = Object.values(getObject(threadStore?.branches));
    const hasHistory = branches.some(branch => (
        (Array.isArray(branch?.messages) && branch.messages.length)
        || parsePositiveInt(branch?.unread, 0, 0) > 0
        || (branch?.preview && branch.preview !== 'Conversation ready')
    ));
    const updatedAt = branches.reduce((latest, branch) => Math.max(
        latest,
        Number(branch?.updatedAt || branch?.lastActivity || branch?.createdAt || 0),
    ), 0);
    return { hasHistory, updatedAt };
}

/**
 * Merge active member aliases into one deterministic group thread anchor.
 */
export function canonicalizeConversationGroupThread(store, group, groupId, personaId = '') {
    const safeGroupId = String(groupId || group?.id || '').trim();
    if (!safeGroupId || !Array.isArray(group?.members)) {
        return null;
    }

    const disabledMembers = new Set((Array.isArray(group.disabled_members) ? group.disabled_members : []).map(member => String(member).trim()));
    const activeMembers = Array.from(new Set(group.members
        .map(member => typeof member === 'string' ? member.trim() : '')
        .filter(member => (
            member
            && !disabledMembers.has(member)
            && getConversationThreadKey(member, safeGroupId, personaId)
        ))));
    if (!activeMembers.length) {
        return null;
    }

    store.characters = getSafeRecord(store.characters);
    for (const member of activeMembers) {
        const scopedKey = getConversationThreadKey(member, safeGroupId, personaId);
        migrateLegacyThreadStore(store, member, safeGroupId, personaId, scopedKey);
    }

    const candidates = activeMembers.map((avatar, index) => {
        const threadKey = getConversationThreadKey(avatar, safeGroupId, personaId);
        const threadStore = store.characters[threadKey];
        return {
            avatar,
            index,
            threadKey,
            threadStore,
            rank: isObject(threadStore) ? getGroupThreadRank(threadStore) : { hasHistory: false, updatedAt: 0 },
        };
    });
    candidates.sort((left, right) => (
        Number(right.rank.hasHistory) - Number(left.rank.hasHistory)
        || right.rank.updatedAt - left.rank.updatedAt
        || left.index - right.index
    ));
    const canonical = candidates[0];
    if (!isObject(store.characters[canonical.threadKey])) {
        const persistedCandidate = candidates.find(candidate => isObject(candidate.threadStore));
        if (persistedCandidate) {
            canonical.avatar = persistedCandidate.avatar;
            canonical.threadKey = persistedCandidate.threadKey;
            canonical.threadStore = persistedCandidate.threadStore;
        }
    }

    const canonicalStore = store.characters[canonical.threadKey];
    if (isObject(canonicalStore)) {
        for (const candidate of candidates) {
            if (candidate.threadKey === canonical.threadKey || !isObject(store.characters[candidate.threadKey])) {
                continue;
            }
            mergeGroupThreadStore(canonicalStore, store.characters[candidate.threadKey], candidate.avatar);
            delete store.characters[candidate.threadKey];
        }
        canonicalStore.threadAvatar = canonical.avatar;
        canonicalStore.groupId = safeGroupId;
    }

    return { avatar: canonical.avatar, threadKey: canonical.threadKey };
}

/**
 * Get or create a thread store for an avatar
 */
export function getConversationThreadStore(store, avatar, groupId = '', { create = true, personaId = '' } = {}) {
    const threadKey = getConversationThreadKey(avatar, groupId, personaId);
    if (!threadKey) {
        return null;
    }

    store.characters = getSafeRecord(store.characters);
    migrateLegacyThreadStore(store, avatar, groupId, personaId, threadKey);
    if (!hasOwn(store.characters, threadKey) || !isObject(store.characters[threadKey])) {
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

    const threadStore = getOwnRecord(store.characters[threadKey]);
    store.characters[threadKey] = threadStore;
    threadStore.settings = getObject(threadStore.settings);
    threadStore.branches = getSafeRecord(threadStore.branches);
    for (const [branchId, branch] of Object.entries(threadStore.branches)) {
        const safeBranchId = getSafeBranchId(branchId);
        if (safeBranchId !== branchId) {
            if (!hasOwn(threadStore.branches, safeBranchId)) {
                threadStore.branches[safeBranchId] = normalizeConversationBranch(branch, safeBranchId);
            }
            delete threadStore.branches[branchId];
            continue;
        }
        threadStore.branches[branchId] = normalizeConversationBranch(branch, branchId);
    }
    threadStore.activeBranchId = getSafeBranchId(threadStore.activeBranchId);
    if (!hasOwn(threadStore.branches, threadStore.activeBranchId)) {
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

    const branchId = getSafeBranchId(threadStore.activeBranchId);
    threadStore.branches[branchId] = normalizeConversationBranch(threadStore.branches[branchId], branchId);
    return threadStore.branches[branchId];
}
