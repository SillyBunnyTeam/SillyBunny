/**
 * The plan of the conversation storage migration: from the old object in `settings.json` to what the new files are to
 * hold, worked out without touching a file (plan S2.6, S5.6). `planMigration()` is a pure function of the old object
 * and of what the migration knows about the rest of the user's data, which the caller reads once and hands in as
 * `MigrationInputs`. `conversation-migration.js` writes the plan and checks what it wrote.
 *
 * The old terms (thread, branch, partner) stay in this module on purpose: they are the names of the stored data that it
 * reads. What it returns uses the new terms.
 *
 * A thread that cannot be migrated is not lost: the whole old object is written to a backup file before
 * `settings.json` is changed, and `skipped` in the report counts what stays only there and why.
 */

import crypto from 'node:crypto';

import {
    buildLegacyThreadKey,
    canonicalizeLegacyGroupThread,
    getLegacyThread,
    normalizeLegacyGroupRecord,
    normalizeLegacyStore,
    parseLegacyThreadKey,
} from './conversation-legacy.js';
import {
    chooseQuietHours,
    chooseSimulateReplyDelay,
    chooseStatusOverride,
    getEffectiveLegacySettings,
    hasGlobalIdleToggle,
    mapConversationSettings,
    mapGlobalSettings,
} from './conversation-migration-settings.js';
import { createChatId, createConversationId, isChatId } from './conversation-paths.js';
import {
    isSafeName,
    MAX_GROUP_MEMBERS,
    MAX_NAME_LENGTH,
    MAX_ROUTINE_TEXT_LENGTH,
    readMarkers,
    readReminders,
    readSettings,
    REMINDER_FIELDS,
} from './conversation-schema.js';

export const MIGRATED_STORE_VERSION = 2;

/** Why a thread, a group or a chat stays in the backup file only. */
export const SKIP = Object.freeze({
    hiddenAndEmpty: 'hidden-and-empty',
    characterMissing: 'character-missing',
    personaMissing: 'persona-missing',
    unsafeName: 'unsafe-name',
    unparseableKey: 'unparseable-key',
    groupUnresolved: 'group-record-unresolved',
    groupPersonaMismatch: 'group-persona-mismatch',
    groupStrayAlias: 'group-stray-alias',
    groupNoUsableMember: 'group-no-usable-member',
    legacyNoPersona: 'legacy-unscoped-no-persona',
    legacyUnmergeable: 'legacy-unscoped-unmergeable',
    legacyLeftoverEmpty: 'legacy-unscoped-leftover-empty',
});

const DEFAULT_CHAT_ID = 'main';
const MAX_LEGACY_KEY_LENGTH = 1024;
const MAX_READ_THROUGH_LENGTH = 256;
const MAX_LEGACY_ID_LENGTH = 256;
const PLACEHOLDER_AVATAR_URL = /^img\//;
const OWN_GROUP_AVATAR_URL = /^\/user\/images\/([^/\\]+)$/;
const PINNED_CONVERSATION_KEY = /^conversation_(group|char)_(.*)_branch_(.*)$/;

/**
 * What the migration knows about the user's other data. The caller reads it once; the plan does not touch a file.
 * @typedef {object} MigrationInputs
 * @property {string} activePersona `user_avatar` of `settings.json`, the persona that an old unscoped key belongs to unless an assignment says otherwise.
 * @property {(avatar: string) => boolean} characterExists Whether the character card is in the user's `characters/` folder.
 * @property {(personaId: string) => boolean} personaExists Whether the persona is in `power_user.personas` or `User Avatars/`.
 * @property {(groupId: string) => ({ id: string, name?: string, members: string[], disabled_members?: string[] }|null)} readRoleplayGroup The roleplay group of `groups/<id>.json`, or null.
 * @property {Record<string, any>} pinnedChats The parsed `accountStorage.pinnedChats` of `settings.json`.
 * @property {number} now Milliseconds since the epoch.
 * @property {(time: number) => string} [createId] Makes a conversation id from a time. For tests.
 */

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha1Token(text, length) {
    return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, length);
}

function cleanText(value, maxLength) {
    return String(value ?? '').replaceAll('\0', '').trim().slice(0, maxLength);
}

function messagesOf(branch) {
    return Array.isArray(branch?.messages) ? branch.messages : [];
}

function countThread(thread) {
    const branches = Object.values(isObject(thread?.branches) ? thread.branches : {});
    return { chats: branches.length, messages: branches.reduce((sum, branch) => sum + messagesOf(branch).length, 0) };
}

function countThreads(characters) {
    const counts = { threads: 0, chats: 0, messages: 0 };
    for (const thread of Object.values(isObject(characters) ? characters : {})) {
        const { chats, messages } = countThread(thread);
        counts.threads++;
        counts.chats += chats;
        counts.messages += messages;
    }
    return counts;
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 1: normalise with the legacy reader. Unscoped keys move to their persona, and alias threads merge into the anchor.

function resolvePersona(store, key, activePersona) {
    return String(store.legacyThreadPersonaAssignments[key] || activePersona || '');
}

/** Row 12: the old client moved an unscoped thread to the persona's key on first use; the server has no current persona, so it uses the assignment, then `user_avatar`. */
function moveUnscopedThreads(store, inputs, notes) {
    for (const key of Object.keys(store.characters)) {
        const parsed = parseLegacyThreadKey(key);
        if (!parsed.avatar || parsed.personaId) {
            continue;
        }
        const persona = resolvePersona(store, key, inputs.activePersona);
        if (!persona) {
            notes.unscopedWithoutPersona++;
            continue;
        }
        getLegacyThread(store, parsed.avatar, parsed.groupId, { personaId: persona });
    }
}

/**
 * Merges the alias threads of every group into one anchor thread. Roleplay groups (row 2) are resolved from
 * `groups/<id>.json`; a thread keyed to a group that has no record anywhere cannot be placed.
 * @returns {{ groupById: Map<string, any>, anchors: Map<string, { avatar: string, threadKey: string }> }}
 */
function mergeGroupAliases(store, inputs) {
    const anchors = new Map();
    const groupById = new Map();
    const canonicalize = (group, persona) => {
        groupById.set(group.id, group);
        const anchor = canonicalizeLegacyGroupThread(store, group, group.id, persona);
        if (anchor) {
            anchors.set(`${persona}\0${group.id}`, anchor);
        }
    };

    for (const group of store.groups) {
        const persona = group.personaId || inputs.activePersona;
        if (persona) {
            canonicalize(group, persona);
        } else {
            groupById.set(group.id, group);
        }
    }

    const ownedIds = new Set(store.groups.map(group => group.id));
    const roleplayPairs = new Map();
    for (const key of Object.keys(store.characters)) {
        const parsed = parseLegacyThreadKey(key);
        if (parsed.groupId && parsed.personaId && !ownedIds.has(parsed.groupId)) {
            roleplayPairs.set(`${parsed.personaId}\0${parsed.groupId}`, parsed);
        }
    }
    for (const { groupId, personaId } of roleplayPairs.values()) {
        let group = groupById.get(groupId);
        if (!group) {
            const definition = inputs.readRoleplayGroup(groupId);
            // The record has no persona: several personas can hold a thread of one roleplay group.
            group = definition && normalizeLegacyGroupRecord({ ...definition, id: groupId, personaId: '', createdAt: 0, updatedAt: 0 });
        }
        if (group) {
            canonicalize(group, personaId);
        }
    }
    return { groupById, anchors };
}

/**
 * `getLegacyThread()` is the one place that normalises every branch of a thread, so every thread goes through it.
 * It finds a thread by a key that it builds from the avatar, the group and the persona, so a stored key that it cannot
 * build again from its own parts (an avatar with a colon, a persona that is not encoded) is not normalised.
 * @returns {Set<string>} The keys of the threads that were normalised.
 */
function normalizeAllThreads(store) {
    const normalised = new Set();
    for (const key of Object.keys(store.characters)) {
        const { avatar, groupId, personaId } = parseLegacyThreadKey(key);
        if (avatar && buildLegacyThreadKey(avatar, groupId, personaId) === key && getLegacyThread(store, avatar, groupId, { personaId })) {
            normalised.add(key);
        }
    }
    return normalised;
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 2: decide which threads become conversations.

/** @param {object|null} thread The thread that stays in the backup, or null for a group record that has no thread. */
function addSkip(skipped, reason, thread) {
    const entry = skipped[reason] ?? { threads: 0, groups: 0, chats: 0, messages: 0 };
    if (thread) {
        const { chats, messages } = countThread(thread);
        entry.threads++;
        entry.chats += chats;
        entry.messages += messages;
    } else {
        entry.groups++;
    }
    skipped[reason] = entry;
}

function usableMembers(group, inputs) {
    const disabled = new Set(group.disabled_members);
    return group.members.filter(member => !disabled.has(member) && isSafeName(member) && inputs.characterExists(member));
}

/**
 * Sorts every thread into a conversation to write, a group to convert, a leftover legacy copy, or the backup.
 * @returns {{ candidates: object[], leftovers: object[], skipped: Record<string, { threads: number, groups: number, chats: number, messages: number }> }}
 */
function classifyThreads(store, inputs, { groupById, anchors }, normalisedKeys) {
    const candidates = [];
    const leftovers = [];
    const skipped = {};
    const covered = new Set();

    for (const [key, thread] of Object.entries(store.characters)) {
        const parsed = parseLegacyThreadKey(key);
        if (!parsed.avatar || !normalisedKeys.has(key)) {
            addSkip(skipped, SKIP.unparseableKey, thread);
            continue;
        }

        if (!parsed.personaId) {
            const persona = resolvePersona(store, key, inputs.activePersona);
            if (!persona) {
                addSkip(skipped, SKIP.legacyNoPersona, thread);
            } else if (countThread(thread).messages > 0) {
                leftovers.push({ key, thread, parsed: { ...parsed, personaId: persona } });
            } else {
                addSkip(skipped, SKIP.legacyLeftoverEmpty, thread);
            }
            continue;
        }

        if (!isSafeName(parsed.personaId) || !isSafeName(parsed.avatar)) {
            addSkip(skipped, SKIP.unsafeName, thread);
            continue;
        }
        if (!inputs.personaExists(parsed.personaId)) {
            addSkip(skipped, SKIP.personaMissing, thread);
            continue;
        }

        if (!parsed.groupId) {
            if (!inputs.characterExists(parsed.avatar)) {
                addSkip(skipped, SKIP.characterMissing, thread);
            } else if (!thread.settings.enabled && countThread(thread).messages === 0) {
                // Row 1 and R5-21: opened, or left by "Delete Conversation History"; never listed.
                addSkip(skipped, SKIP.hiddenAndEmpty, thread);
            } else {
                candidates.push({ kind: 'direct', key, parsed, thread });
            }
            continue;
        }

        const group = groupById.get(parsed.groupId);
        if (!group) {
            addSkip(skipped, SKIP.groupUnresolved, thread);
            continue;
        }
        if (group.personaId && group.personaId !== parsed.personaId) {
            addSkip(skipped, SKIP.groupPersonaMismatch, thread);
            continue;
        }
        const anchor = anchors.get(`${parsed.personaId}\0${group.id}`);
        if (!anchor || anchor.threadKey !== key) {
            addSkip(skipped, SKIP.groupStrayAlias, thread);
            continue;
        }
        covered.add(`${parsed.personaId}\0${group.id}`);
        const members = usableMembers(group, inputs);
        if (members.length >= 2) {
            candidates.push({ kind: 'group', key, parsed, thread, group, members });
        } else if (members.length === 1) {
            // Row 16: the rule of S4 for a group that is left with one member.
            candidates.push({ kind: 'convert', key, parsed, thread, group, members });
        } else {
            addSkip(skipped, SKIP.groupNoUsableMember, thread);
        }
    }

    // A group that was made and never written to has a record and no thread. It is still listed today.
    for (const group of store.groups) {
        const persona = group.personaId || inputs.activePersona;
        if (!persona || covered.has(`${persona}\0${group.id}`)) {
            continue;
        }
        const members = usableMembers(group, inputs);
        if (!isSafeName(persona) || !inputs.personaExists(persona)) {
            addSkip(skipped, SKIP.personaMissing, null);
        } else if (members.length >= 2) {
            candidates.push({ kind: 'group', key: '', parsed: { personaId: persona, groupId: group.id, avatar: group.members[0] }, thread: null, group, members });
        } else {
            addSkip(skipped, SKIP.groupNoUsableMember, null);
        }
    }
    return { candidates, leftovers, skipped };
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 3: chats and messages.

function computeReadThrough(messages, unread, stats) {
    const unreadTail = Math.min(Math.max(0, unread), messages.length);
    if (unread > messages.length) {
        stats.unreadClamped++;
    }
    const lastRead = messages[messages.length - 1 - unreadTail];
    const id = lastRead?.id ?? '';
    return id.length <= MAX_READ_THROUGH_LENGTH ? id : '';
}

/** Rows 3 and 19: the new store names a member's line `member`, and stamps who spoke. */
function convertMessage(message, { threadIsGroup, anchorAvatar }) {
    const sourceRole = message.role;
    // `assistant` is the role that the removed REST API wrote.
    const role = sourceRole === 'partner' ? 'member' : sourceRole === 'assistant' ? 'character' : sourceRole;
    const extra = { ...(isObject(message.extra) ? message.extra : {}) };
    if (Object.hasOwn(extra, 'partner_avatar')) {
        extra.member_avatar = extra.partner_avatar;
        delete extra.partner_avatar;
    }
    if (threadIsGroup && role === 'character' && !extra.member_avatar) {
        extra.member_avatar = anchorAvatar;
    }
    if (isObject(extra.conversation_reply_to) && extra.conversation_reply_to.role === 'partner') {
        extra.conversation_reply_to = { ...extra.conversation_reply_to, role: 'member' };
    }
    return {
        name: message.name ?? '',
        is_user: role === 'user',
        is_system: role === 'system',
        send_date: message.send_date,
        mes: message.mes ?? '',
        extra,
        id: message.id,
        role,
        created_at: message.created_at,
    };
}

/** Row 10: one memory summary per chat. The chat's own wins; the active chat takes the thread's when it has none. */
function buildHeader(branch, thread, isActive) {
    const threadSummary = String(thread?.memorySummary || '');
    const ownSummary = String(branch.memorySummary || '');
    const takesThreadSummary = isActive && !ownSummary && threadSummary;
    const summary = takesThreadSummary ? threadSummary : ownSummary;
    const count = Number(takesThreadSummary ? thread.memoryMessageCount : branch.memoryMessageCount) || 0;
    const updatedAt = Number(takesThreadSummary ? thread.memoryUpdatedAt : branch.memoryUpdatedAt) || 0;
    const hasMemory = summary || count || updatedAt;
    return {
        chat_metadata: hasMemory ? { sb_conversation: { memory_summary: summary, memory_message_count: count, memory_updated_at: updatedAt } } : {},
        user_name: 'unused',
        character_name: 'unused',
    };
}

function chooseChatId(branchId, branch, used) {
    const base = isChatId(branchId) ? branchId : createChatId(Number(branch.createdAt) || 0, sha1Token(branchId, 6));
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) {
        id = `${base.slice(0, 60)}_${suffix}`;
    }
    used.add(id);
    return id;
}

function getChatName(branch, { nameAfter, isDefaultName }) {
    const name = cleanText(branch.name || 'Main', MAX_NAME_LENGTH);
    if (!nameAfter) {
        return name;
    }
    return isDefaultName(name) ? nameAfter : cleanText(`${nameAfter} - ${name}`, MAX_NAME_LENGTH);
}

/**
 * Adds the chats of a thread to a conversation under construction.
 * Row 17 and R5-22: an empty chat stays in the backup, except the active chat of the thread that the conversation is
 * made from, because a conversation always has one chat.
 * @param {object} draft The conversation under construction.
 * @param {object} thread A normalised thread.
 * @param {{ primary: boolean, threadIsGroup: boolean, anchorAvatar: string, nameAfter?: string, nameSuffix?: string, stats: object }} options
 */
function appendChats(draft, thread, { primary, threadIsGroup, anchorAvatar, nameAfter = '', nameSuffix = '', stats }) {
    const branches = Object.entries(thread?.branches ?? {})
        .map(([branchId, branch]) => ({ branchId, branch }))
        .sort((left, right) => (Number(left.branch.createdAt) || 0) - (Number(right.branch.createdAt) || 0));
    const kept = branches.filter(({ branchId, branch }) => {
        const keep = messagesOf(branch).length > 0 || (primary && branchId === thread.activeBranchId);
        if (!keep) {
            stats.emptyChatsSkipped++;
        }
        return keep;
    });

    const idMap = new Map();
    for (const { branchId, branch } of kept) {
        idMap.set(branchId, chooseChatId(branchId, branch, draft.usedChatIds));
    }

    for (const { branchId, branch } of kept) {
        const chatId = idMap.get(branchId);
        const messages = messagesOf(branch);
        const isActive = branchId === thread.activeBranchId;
        const markers = Object.fromEntries(Object.entries(branch.sessionMarkers ?? {}).map(([key, value]) => [key, key === 'memory_copied_from' && idMap.has(value) ? idMap.get(value) : value]));
        const sessionMarkers = readMarkers(markers);
        stats.droppedMarkers += Object.keys(markers).length - Object.keys(sessionMarkers).length;
        const entry = {
            id: chatId,
            name: getChatName(branch, { nameAfter, isDefaultName: name => name === 'Main' || !name }) + nameSuffix,
            createdAt: Number(branch.createdAt) || 0,
            readThrough: computeReadThrough(messages, Number(branch.unread) || 0, stats),
            followupCount: Number(branch.followupCount) || 0,
            lastAutoMessageAt: Number(branch.lastAutoMessageAt) || 0,
            lastActivity: Number(branch.lastActivity) || 0,
            sessionMarkers,
        };
        entry.name = cleanText(entry.name, MAX_NAME_LENGTH);
        if (chatId !== branchId && branchId.length <= MAX_LEGACY_ID_LENGTH && !branchId.includes('\0')) {
            entry.legacyId = branchId;
        }
        if (Object.keys(branch.scheduleTriggers ?? {}).length > 0) {
            stats.scheduleTriggersDropped++;
        }
        draft.chats.push({
            ...entry,
            records: [buildHeader(branch, thread, isActive), ...messages.map(message => convertMessage(message, { threadIsGroup, anchorAvatar }))],
        });
        draft.updatedAt = Math.max(draft.updatedAt, Number(branch.updatedAt) || 0);
        if (!draft.branchIds.has(branchId)) {
            draft.branchIds.set(branchId, chatId);
        }
    }
    if (primary) {
        draft.activeChatId = idMap.get(thread.activeBranchId) ?? draft.chats[0].id;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 4: conversations.

function splitAvatarList(value) {
    return String(value || '').split(',').map(part => part.trim()).filter(Boolean);
}

/** Row 19: the extras of a direct conversation are the avatars of `multi_char_names` and of the authors of `partner` lines. */
function collectExtras(owner, effective, thread) {
    const authors = Object.values(thread.branches).flatMap(messagesOf)
        .filter(message => message.role === 'partner')
        .map(message => message.extra?.partner_avatar)
        .filter(avatar => typeof avatar === 'string');
    return [...new Set([...splitAvatarList(effective.multi_char_names), ...authors])]
        .filter(avatar => avatar !== owner && isSafeName(avatar))
        .slice(0, MAX_GROUP_MEMBERS);
}

function newDraft({ kind, personaId, characters, name, legacyKey, groupCreatedAt, groupUpdatedAt, groupAvatarUrl, settings, effective, extras }) {
    return {
        kind,
        personaId,
        characters,
        extras,
        name,
        legacyKey: legacyKey.length <= MAX_LEGACY_KEY_LENGTH ? legacyKey : '',
        groupCreatedAt,
        groupAvatarUrl,
        settings,
        effective,
        chats: [],
        usedChatIds: new Set(),
        branchIds: new Map(),
        groupIds: new Set(),
        activeChatId: '',
        updatedAt: groupUpdatedAt,
        reminders: [],
    };
}

function isOwnAvatarUrl(url) {
    return Boolean(url) && !PLACEHOLDER_AVATAR_URL.test(url) && OWN_GROUP_AVATAR_URL.test(url);
}

function directDraft(candidate, ctx) {
    const { thread, parsed } = candidate;
    const effective = getEffectiveLegacySettings({ kind: 'direct', threadSettings: thread.settings, globalSettings: ctx.store.settings });
    const draft = newDraft({
        kind: 'direct',
        personaId: parsed.personaId,
        characters: [parsed.avatar],
        name: '',
        legacyKey: candidate.key,
        groupCreatedAt: 0,
        groupUpdatedAt: 0,
        groupAvatarUrl: '',
        settings: mapConversationSettings({ kind: 'direct', effective, idleToggleOn: ctx.idleToggleOn }),
        effective,
        extras: collectExtras(parsed.avatar, effective, thread),
    });
    appendChats(draft, thread, { primary: true, threadIsGroup: false, anchorAvatar: parsed.avatar, stats: ctx.stats });
    return draft;
}

function groupDraft(candidate, ctx) {
    const { thread, parsed, group, members } = candidate;
    const effective = getEffectiveLegacySettings({ kind: 'group', threadSettings: thread?.settings, groupSettings: group.conversation_settings, globalSettings: ctx.store.settings });
    const avatarUrl = String(group.avatar_url || '');
    const draft = newDraft({
        kind: 'group',
        personaId: parsed.personaId,
        characters: members,
        name: cleanText(group.name, MAX_NAME_LENGTH),
        legacyKey: candidate.key || `group:${group.id}`,
        groupCreatedAt: group.createdAt,
        groupUpdatedAt: group.updatedAt,
        groupAvatarUrl: isOwnAvatarUrl(avatarUrl) ? avatarUrl : '',
        settings: mapConversationSettings({ kind: 'group', effective, idleToggleOn: ctx.idleToggleOn }),
        effective,
        extras: [],
    });
    if (thread) {
        appendChats(draft, thread, { primary: true, threadIsGroup: true, anchorAvatar: parsed.avatar, stats: ctx.stats });
    } else {
        draft.chats.push({ id: DEFAULT_CHAT_ID, name: 'Main', createdAt: group.createdAt, readThrough: '', followupCount: 0, lastAutoMessageAt: 0, lastActivity: 0, sessionMarkers: {}, records: [buildHeader({}, null, false)] });
        draft.usedChatIds.add(DEFAULT_CHAT_ID);
        draft.activeChatId = DEFAULT_CHAT_ID;
    }
    return draft;
}

/** Row 16: a group with one usable member adds its chats, named after the group, to the direct conversation of that member. */
function addConvertedGroup(candidate, ctx) {
    const { thread, parsed, group, members } = candidate;
    const key = `${parsed.personaId}\0${members[0]}`;
    let draft = ctx.directDrafts.get(key);
    const options = { threadIsGroup: true, anchorAvatar: parsed.avatar, nameAfter: cleanText(group.name, MAX_NAME_LENGTH), stats: ctx.stats };
    if (!draft) {
        const effective = getEffectiveLegacySettings({ kind: 'group', threadSettings: thread.settings, groupSettings: group.conversation_settings, globalSettings: ctx.store.settings });
        draft = newDraft({
            kind: 'direct',
            personaId: parsed.personaId,
            characters: [members[0]],
            name: '',
            legacyKey: candidate.key,
            groupCreatedAt: group.createdAt,
            groupUpdatedAt: group.updatedAt,
            groupAvatarUrl: '',
            settings: mapConversationSettings({ kind: 'group', effective, idleToggleOn: false }),
            effective,
            extras: [],
        });
        ctx.directDrafts.set(key, draft);
        ctx.drafts.push(draft);
        appendChats(draft, thread, { ...options, primary: true });
    } else {
        appendChats(draft, thread, { ...options, primary: false });
    }
    draft.groupIds.add(group.id);
    ctx.converted++;
}

/** Row 12: a legacy copy that the merge could not take in becomes extra chats of its conversation. */
function addLeftoverChats(leftover, ctx) {
    const { thread, parsed } = leftover;
    const draft = parsed.groupId
        ? ctx.groupDrafts.get(`${parsed.personaId}\0${parsed.groupId}`) ?? ctx.directDraftsByGroup.get(`${parsed.personaId}\0${parsed.groupId}`)
        : ctx.directDrafts.get(`${parsed.personaId}\0${parsed.avatar}`);
    if (!draft) {
        addSkip(ctx.skipped, SKIP.legacyUnmergeable, thread);
        return;
    }
    appendChats(draft, thread, { primary: false, threadIsGroup: Boolean(parsed.groupId), anchorAvatar: parsed.avatar, nameSuffix: ' (earlier copy)', stats: ctx.stats });
    ctx.leftoverChats += Object.keys(thread.branches).length;
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 5: reminders, character state, pins and the settings that stay.

function convertReminder(reminder, chatId) {
    const picked = { chatId };
    for (const field of REMINDER_FIELDS) {
        if (field !== 'chatId' && reminder[field] !== undefined) {
            picked[field] = reminder[field];
        }
    }
    return picked;
}

function placeReminders(store, ctx) {
    const byDirect = new Map();
    const byGroup = new Map();
    for (const draft of ctx.drafts) {
        if (draft.kind === 'direct') {
            byDirect.set(`${draft.personaId}\0${draft.characters[0]}`, draft);
        }
    }
    for (const [key, draft] of ctx.groupDrafts) {
        byGroup.set(key, draft);
    }
    for (const [key, draft] of ctx.directDraftsByGroup) {
        byGroup.set(key, draft);
    }

    let unplaced = 0;
    for (const reminder of store.reminders) {
        if (!isObject(reminder)) {
            unplaced++;
            continue;
        }
        const persona = String(reminder.personaId || ctx.inputs.activePersona || '');
        const draft = reminder.groupId ? byGroup.get(`${persona}\0${reminder.groupId}`) : byDirect.get(`${persona}\0${reminder.avatar}`);
        if (!draft) {
            unplaced++;
            continue;
        }
        draft.reminders.push(convertReminder(reminder, draft.branchIds.get(String(reminder.branchId || '')) ?? ''));
    }

    let dropped = 0;
    for (const draft of ctx.drafts) {
        const seen = new Set();
        const unique = draft.reminders.filter(reminder => typeof reminder.id === 'string' && !seen.has(reminder.id) && seen.add(reminder.id));
        // readReminders() keeps the first MAX_REMINDERS_PER_CONVERSATION, so the ones that matter most come first:
        // reminders that have not fired, then the newest.
        const ordered = unique.toSorted((left, right) => Number(Boolean(left.fired)) - Number(Boolean(right.fired)) || (right.triggerAt ?? 0) - (left.triggerAt ?? 0));
        const valid = readReminders(ordered);
        dropped += draft.reminders.length - valid.length;
        draft.reminders = valid;
    }
    ctx.stats.remindersUnplaced = unplaced;
    ctx.stats.remindersDropped = dropped;
}

/** Row 26: the routine is the generated schedule of the newest thread of the character. The manual weekly slots and the text schedule stay in the backup only. */
function buildCharacterState(store, ctx) {
    const routines = new Map();
    for (const [key, thread] of Object.entries(store.characters)) {
        const parsed = parseLegacyThreadKey(key);
        const schedule = thread?.schedule;
        if (!parsed.avatar || parsed.groupId || !isObject(schedule) || !isObject(schedule.days) || !isSafeName(parsed.avatar) || !ctx.inputs.characterExists(parsed.avatar)) {
            continue;
        }
        const generatedAt = Number(schedule.generatedAt) || Number(thread.settings?.schedule_generated_at) || 0;
        const current = routines.get(parsed.avatar);
        if (!current || generatedAt >= current.generatedAt) {
            routines.set(parsed.avatar, { generatedAt, days: schedule.days });
        }
    }

    const availability = new Map();
    for (const { avatar, availability: value } of ctx.sourceThreads) {
        if (isSafeName(avatar) && ctx.inputs.characterExists(avatar)) {
            availability.set(avatar, [...(availability.get(avatar) ?? []), value]);
        }
    }

    const characters = {};
    for (const avatar of new Set([...routines.keys(), ...availability.keys()])) {
        const state = {};
        const routine = routines.get(avatar);
        if (routine) {
            const text = JSON.stringify({ days: routine.days });
            if (text.length <= MAX_ROUTINE_TEXT_LENGTH) {
                state.routine = { enabled: true, text, generatedAt: routine.generatedAt };
            } else {
                ctx.stats.routinesTooLong++;
            }
        }
        const override = chooseStatusOverride(availability.get(avatar) ?? [], { hasRoutine: Boolean(state.routine) });
        if (override) {
            state.statusOverride = override;
        }
        if (Object.keys(state).length > 0) {
            characters[avatar] = state;
        }
    }
    return characters;
}

/**
 * Row 18: a Home pin was keyed by owner and chat id with no persona. It is keyed by the conversation and chat now, as
 * `getConversationBackupName()` names a chat. A pin that names a chat that stays in the backup is dropped.
 */
function rekeyPins(pinnedChats, ctx) {
    const pins = {};
    let rekeyed = 0;
    let dropped = 0;
    for (const [key, value] of Object.entries(isObject(pinnedChats) ? pinnedChats : {})) {
        const match = PINNED_CONVERSATION_KEY.exec(key);
        if (!match) {
            pins[key] = value;
            continue;
        }
        const [, ownerKind, owner, branchId] = match;
        const targets = ctx.drafts.filter(draft => (ownerKind === 'group' ? draft.groupIds.has(owner) : draft.kind === 'direct' && draft.characters[0] === owner));
        const resolved = targets.filter(draft => draft.branchIds.has(branchId));
        if (resolved.length === 0) {
            dropped++;
            continue;
        }
        for (const draft of resolved) {
            const chatId = draft.branchIds.get(branchId);
            const pin = { ...(isObject(value) ? value : {}), is_conversation: true, conversation_id: draft.id, conversation_chat_id: chatId };
            delete pin.conversation_branch_id;
            pins[`conversation_${draft.id}_${chatId}`] = pin;
            rekeyed++;
        }
    }
    return { pins, rekeyed, dropped, changed: rekeyed + dropped > 0 };
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * @param {unknown} rawStore `settings.extension_settings.sillybunny_conversation` as it was read.
 * @param {MigrationInputs} inputs
 * @returns {object} The plan: `conversations` to write (each with the `input` of `createConversation()`), `characterState`,
 * `globalSettings` and `pins` to keep, and a `report` of counts. The plan holds no text that identifies a conversation
 * outside `conversations`.
 */
export function planMigration(rawStore, inputs) {
    const store = normalizeLegacyStore(rawStore);
    const raw = {
        ...countThreads(isObject(rawStore) ? rawStore.characters : {}),
        groups: Array.isArray(rawStore?.groups) ? rawStore.groups.length : 0,
        reminders: Array.isArray(rawStore?.reminders) ? rawStore.reminders.length : 0,
    };
    const notes = { unscopedWithoutPersona: 0 };

    moveUnscopedThreads(store, inputs, notes);
    const aliases = mergeGroupAliases(store, inputs);
    const normalisedKeys = normalizeAllThreads(store);
    const normalised = countThreads(store.characters);
    const { candidates, leftovers, skipped } = classifyThreads(store, inputs, aliases, normalisedKeys);

    const stats = { emptyChatsSkipped: 0, unreadClamped: 0, droppedMarkers: 0, scheduleTriggersDropped: 0, remindersUnplaced: 0, remindersDropped: 0, routinesTooLong: 0 };
    const ctx = {
        store,
        inputs,
        stats,
        skipped,
        idleToggleOn: hasGlobalIdleToggle(store.settings),
        drafts: [],
        directDrafts: new Map(),
        groupDrafts: new Map(),
        directDraftsByGroup: new Map(),
        sourceThreads: [],
        converted: 0,
        leftoverChats: 0,
    };

    const order = (left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    for (const candidate of candidates.filter(item => item.kind !== 'convert').toSorted(order)) {
        const draft = candidate.kind === 'direct' ? directDraft(candidate, ctx) : groupDraft(candidate, ctx);
        if (candidate.group) {
            draft.groupIds.add(candidate.group.id);
        }
        ctx.drafts.push(draft);
        if (candidate.kind === 'direct') {
            ctx.directDrafts.set(`${draft.personaId}\0${draft.characters[0]}`, draft);
        } else {
            ctx.groupDrafts.set(`${draft.personaId}\0${candidate.group.id}`, draft);
        }
        ctx.sourceThreads.push({ avatar: candidate.parsed.avatar, availability: candidate.thread?.settings?.availability ?? 'online' });
    }
    for (const candidate of candidates.filter(item => item.kind === 'convert').toSorted(order)) {
        addConvertedGroup(candidate, ctx);
        const draft = ctx.directDrafts.get(`${candidate.parsed.personaId}\0${candidate.members[0]}`);
        ctx.directDraftsByGroup.set(`${candidate.parsed.personaId}\0${candidate.group.id}`, draft);
        ctx.sourceThreads.push({ avatar: candidate.parsed.avatar, availability: candidate.thread?.settings?.availability ?? 'online' });
    }
    for (const leftover of leftovers.toSorted(order)) {
        addLeftoverChats(leftover, ctx);
    }

    for (const draft of ctx.drafts) {
        const created = [draft.groupCreatedAt, ...draft.chats.map(chat => chat.createdAt)].filter(time => time > 0);
        draft.createdAt = created.length ? Math.min(...created) : inputs.now;
        draft.updatedAt = Math.max(draft.updatedAt, draft.createdAt);
        draft.id = (inputs.createId ?? createConversationId)(draft.createdAt);
    }
    placeReminders(store, ctx);

    const quietHours = chooseQuietHours(ctx.drafts.map(draft => ({ effective: draft.effective, updatedAt: draft.updatedAt })));
    const simulateReplyDelay = chooseSimulateReplyDelay(ctx.drafts.map(draft => draft.effective));
    const globalSettings = mapGlobalSettings(store.settings, { quietHours, simulateReplyDelay });
    const pins = rekeyPins(inputs.pinnedChats, ctx);
    const characterState = buildCharacterState(store, ctx);

    const conversations = ctx.drafts.map(draft => ({
        id: draft.id,
        legacyKey: draft.legacyKey,
        groupAvatarUrl: draft.groupAvatarUrl,
        input: {
            id: draft.id,
            kind: draft.kind,
            personaId: draft.personaId,
            characters: draft.characters,
            extras: draft.extras,
            name: draft.name,
            favorite: false,
            settings: draft.settings,
            reminders: draft.reminders,
            legacyKey: draft.legacyKey,
            createdAt: draft.createdAt,
            updatedAt: draft.updatedAt,
            activeChatId: draft.activeChatId,
            chats: draft.chats,
        },
    }));

    const settingsDropped = conversations.reduce((sum, { input }) => sum + Object.keys(input.settings).length - Object.keys(readSettings(input.settings)).length, 0);
    const migratedChats = conversations.reduce((sum, { input }) => sum + input.chats.length, 0);
    return {
        conversations,
        characterState,
        globalSettings,
        pins,
        report: {
            raw,
            normalised,
            migrated: {
                conversations: conversations.length,
                direct: conversations.filter(({ input }) => input.kind === 'direct').length,
                group: conversations.filter(({ input }) => input.kind === 'group').length,
                chats: migratedChats,
                messages: conversations.reduce((sum, { input }) => sum + input.chats.reduce((inner, chat) => inner + chat.records.length - 1, 0), 0),
                reminders: conversations.reduce((sum, { input }) => sum + input.reminders.length, 0),
                convertedGroups: ctx.converted,
                leftoverChats: ctx.leftoverChats,
            },
            skipped: ctx.skipped,
            emptyChatsSkipped: stats.emptyChatsSkipped,
            dropped: { settings: settingsDropped, markers: stats.droppedMarkers, scheduleTriggers: stats.scheduleTriggersDropped, remindersUnplaced: stats.remindersUnplaced, remindersDropped: stats.remindersDropped },
            unreadClamped: stats.unreadClamped,
            pins: { rekeyed: pins.rekeyed, dropped: pins.dropped },
            characterStates: Object.keys(characterState).length,
            unscopedWithoutPersona: notes.unscopedWithoutPersona,
        },
    };
}
