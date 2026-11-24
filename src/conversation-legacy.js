/**
 * Read-only reader for the old conversation store, `extension_settings.sillybunny_conversation` in `settings.json`.
 *
 * Builds before the storage move kept every conversation in that one object: a map of "thread" keys, each holding
 * "branches", plus "groups" and "reminders". The migration reads that object through this module and writes the new
 * folder layout. The old terms (thread, branch, partner) stay here on purpose, because they are the names of the
 * stored data that this module reads.
 *
 * Nothing here writes a file or changes the object it is given: `normalizeLegacyStore` works on a copy, and the
 * functions that take that copy only change the copy. The defaults come from `conversation-legacy-defaults.js`, a
 * frozen snapshot, so that later changes to the client constants cannot change what an old value means.
 */

import { LEGACY_DEFAULT_SETTINGS } from './conversation-legacy-defaults.js';

export { LEGACY_DEFAULT_SETTINGS } from './conversation-legacy-defaults.js';

export const LEGACY_STORE_KEY = 'sillybunny_conversation';
export const LEGACY_DEFAULT_CHAT_ID = 'main';

/** The keys a group record stores in `conversation_settings`; every other key lives on the group's anchor thread. */
export const LEGACY_GROUP_SETTINGS_KEYS = Object.freeze([
    'multi_char',
    'auto_character_chat',
    'proactive_messaging',
    'inactivity_threshold',
    'max_followups',
    'talkativeness',
    'reply_delay_multiplier',
    'reply_max_tokens',
    'selfie_command_enabled',
    'schedule_command_enabled',
]);

const PERSONA_KEY_PREFIX = 'persona:';
const GROUP_KEY_PREFIX = 'group:';
const MAX_STORAGE_PART_LENGTH = 512;
const MAX_MESSAGE_FIELD_LENGTH = 512;
const MAX_BRANCH_ID_LENGTH = 256;
const MAX_THREAD_MESSAGES = 250;
const MIN_REPLY_MAX_TOKENS = 64;
const MAX_REPLY_MAX_TOKENS = 64000;
const DEFAULT_REPLY_MAX_TOKENS = 16000;
const RESERVED_PROPERTY_KEYS = new Set([
    ...Object.getOwnPropertyNames(Object.prototype),
    'prototype',
]);
const ORIGINAL_MESSAGE_ID = Symbol('originalLegacyMessageId');

// ---------------------------------------------------------------------------------------------------------------------
// Plain-data helpers. Stored objects are untrusted: a key such as `__proto__` must never become a property.

function isObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
}

function getObject(value) {
    return isObject(value) ? value : {};
}

function hasOwn(value, key) {
    return isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function getOwnRecord(value) {
    const record = Object.create(null);
    if (!isObject(value)) {
        return record;
    }
    for (const [key, item] of Object.entries(value)) {
        record[key] = item;
    }
    return record;
}

function isSafePropertyKey(value) {
    const key = String(value ?? '');
    return Boolean(key && !RESERVED_PROPERTY_KEYS.has(key));
}

function getSafeRecord(value) {
    const record = Object.create(null);
    if (!isObject(value)) {
        return record;
    }
    for (const [key, item] of Object.entries(value)) {
        if (isSafePropertyKey(key)) {
            record[key] = item;
        }
    }
    return record;
}

function parsePositiveInt(value, fallback, min = 1) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function getPersonaId(personaId = '') {
    return String(personaId || '').trim();
}

/** Message ids are interpolated into quoted CSS attribute selectors by the old client. */
function isSafeMessageId(value) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_MESSAGE_FIELD_LENGTH
        && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function validateStoragePart(value, { required = false, allowColon = true } = {}) {
    if (value === undefined || value === null || value === '') {
        return required ? { valid: false, value: '' } : { valid: true, value: '' };
    }
    if (typeof value !== 'string') {
        return { valid: false, value: '' };
    }

    const trimmed = value.trim();
    let encodable = true;
    try {
        encodeURIComponent(trimmed);
    } catch {
        encodable = false;
    }
    if ((!trimmed && required)
        || trimmed.length > MAX_STORAGE_PART_LENGTH
        || /[\u0000-\u001F\u007F]/.test(trimmed)
        || (!allowColon && trimmed.includes(':'))
        || !encodable
        || !isSafePropertyKey(trimmed)) {
        return { valid: false, value: '' };
    }
    return { valid: true, value: trimmed };
}

function decodeStoragePart(value) {
    try {
        return decodeURIComponent(String(value || ''));
    } catch {
        return String(value || '');
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Thread keys: `[persona:<encoded persona>:][group:<group id>:]<avatar file name>`.

/**
 * Build a thread key. Returns an empty string when a part cannot be stored in a key, as the old server did.
 * @param {string} avatar Character avatar file name.
 * @param {string} [groupId] Group id, empty for a direct thread.
 * @param {string} [personaId] Persona avatar file name, empty for a legacy unscoped key.
 * @returns {string}
 */
export function buildLegacyThreadKey(avatar, groupId = '', personaId = '') {
    const avatarPart = validateStoragePart(String(avatar || '').trim(), { required: true, allowColon: false });
    const groupPart = validateStoragePart(String(groupId || '').trim(), { allowColon: false });
    const personaPart = validateStoragePart(personaId);
    if (!avatarPart.valid || !groupPart.valid || !personaPart.valid) {
        return '';
    }

    const key = groupPart.value ? `${GROUP_KEY_PREFIX}${groupPart.value}:${avatarPart.value}` : avatarPart.value;
    if (!personaPart.value || key.startsWith(PERSONA_KEY_PREFIX)) {
        return key;
    }
    return `${PERSONA_KEY_PREFIX}${encodeURIComponent(personaPart.value)}:${key}`;
}

/**
 * Split a thread key into its parts. The same rules as the client's `parseConversationKey`: a key that is cut short
 * gives empty parts, never an exception, and an undecodable persona is kept as it is written.
 * @param {string} key
 * @returns {{ avatar: string, groupId: string, personaId: string }}
 */
export function parseLegacyThreadKey(key) {
    let value = String(key || '');
    let personaId = '';
    if (value.startsWith(PERSONA_KEY_PREFIX)) {
        const withoutPrefix = value.slice(PERSONA_KEY_PREFIX.length);
        const separatorIndex = withoutPrefix.indexOf(':');
        if (separatorIndex < 0) {
            return { avatar: '', groupId: '', personaId: '' };
        }

        personaId = decodeStoragePart(withoutPrefix.slice(0, separatorIndex));
        value = withoutPrefix.slice(separatorIndex + 1);
    }

    if (!value.startsWith(GROUP_KEY_PREFIX)) {
        return { avatar: value, groupId: '', personaId };
    }

    const withoutPrefix = value.slice(GROUP_KEY_PREFIX.length);
    const separatorIndex = withoutPrefix.indexOf(':');
    if (separatorIndex < 0) {
        return { avatar: '', groupId: '', personaId };
    }

    return {
        groupId: withoutPrefix.slice(0, separatorIndex),
        avatar: withoutPrefix.slice(separatorIndex + 1),
        personaId,
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings and group records.

/**
 * Fill defaults and clamp a stored settings object.
 * @param {object} [settings]
 * @returns {Record<string, any>}
 */
export function normalizeLegacySettings(settings = {}) {
    const normalized = { ...LEGACY_DEFAULT_SETTINGS, ...getObject(settings) };
    normalized.reply_max_tokens = clamp(
        parsePositiveInt(normalized.reply_max_tokens, DEFAULT_REPLY_MAX_TOKENS, MIN_REPLY_MAX_TOKENS),
        MIN_REPLY_MAX_TOKENS,
        MAX_REPLY_MAX_TOKENS,
    );
    if (normalized.reply_max_tokens === 1024) {
        normalized.reply_max_tokens = DEFAULT_REPLY_MAX_TOKENS;
    }
    normalized.selfie_command_enabled = Boolean(normalized.selfie_command_enabled);
    normalized.schedule_command_enabled = Boolean(normalized.schedule_command_enabled);
    normalized.grounded_dialogue_rules_enabled = Boolean(normalized.grounded_dialogue_rules_enabled);
    normalized.grounded_dialogue_rules = typeof normalized.grounded_dialogue_rules === 'string'
        ? normalized.grounded_dialogue_rules
        : LEGACY_DEFAULT_SETTINGS.grounded_dialogue_rules;
    return normalized;
}

function normalizeGroupSettings(settings = {}) {
    const source = getObject(settings);
    const normalized = normalizeLegacySettings(source);
    return LEGACY_GROUP_SETTINGS_KEYS.reduce((picked, key) => {
        if (hasOwn(source, key)) {
            picked[key] = normalized[key];
        }
        return picked;
    }, {});
}

function getUniqueMembers(memberAvatars) {
    return Array.from(new Set(
        (Array.isArray(memberAvatars) ? memberAvatars : [])
            .filter(avatar => typeof avatar === 'string')
            .map(avatar => avatar.trim())
            .filter(avatar => validateStoragePart(avatar, { required: true, allowColon: false }).valid),
    ));
}

/**
 * Normalize a stored conversation group. A group with an unusable id or fewer than two members is not a group.
 * @param {object} group
 * @returns {object|null}
 */
export function normalizeLegacyGroupRecord(group) {
    const source = getObject(group);
    const idPart = validateStoragePart(source.id, { required: true, allowColon: false });
    const id = idPart.valid ? idPart.value : '';
    const personaId = getPersonaId(source.personaId || source.persona || source.personaAvatar || source.userAvatar);
    const members = getUniqueMembers(source.members);
    if (!id || members.length < 2) {
        return null;
    }

    const now = Date.now();
    return {
        ...getOwnRecord(source),
        id,
        personaId,
        name: typeof source.name === 'string' && source.name ? source.name : 'Conversation Group',
        members,
        disabled_members: getUniqueMembers(source.disabled_members).filter(avatar => members.includes(avatar)),
        conversation_settings: normalizeGroupSettings(source.conversation_settings),
        is_conversation_group: true,
        createdAt: parsePositiveInt(source.createdAt, now, 0),
        updatedAt: parsePositiveInt(source.updatedAt, source.createdAt || now, 0),
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// Messages and branches.

/** Move the pre-media-schema attachment list into the current media and files fields. */
function normalizeAttachments(extra) {
    const normalized = getOwnRecord(extra);
    const media = [];
    const files = [];
    const mediaUrls = new Set();
    const fileUrls = new Set();
    const addUnique = (target, urls, attachment) => {
        const url = String(attachment?.url || '').trim();
        if (!url || urls.has(url)) {
            return;
        }
        urls.add(url);
        target.push(attachment);
    };
    for (const attachment of Array.isArray(normalized.media) ? normalized.media : []) {
        addUnique(media, mediaUrls, attachment);
    }
    for (const attachment of Array.isArray(normalized.files) ? normalized.files : []) {
        addUnique(files, fileUrls, attachment);
    }
    for (const attachment of Array.isArray(normalized.attachments) ? normalized.attachments : []) {
        const type = String(attachment?.type || '').toLowerCase();
        const mimeType = String(attachment?.mime || attachment?.mimeType || attachment?.contentType || '').toLowerCase();
        if (type === 'file' || (mimeType && !/^(?:image|audio|video)\//.test(mimeType))) {
            addUnique(files, fileUrls, attachment);
        } else {
            addUnique(media, mediaUrls, attachment);
        }
    }
    if (normalized.media !== undefined || media.length) {
        normalized.media = media;
    }
    if (normalized.files !== undefined || files.length) {
        normalized.files = files;
    }
    delete normalized.attachments;
    return normalized;
}

function hasMessageContent(message) {
    const media = Array.isArray(message?.extra?.media) ? message.extra.media.filter(item => item?.url) : [];
    const files = Array.isArray(message?.extra?.files) ? message.extra.files.filter(item => item?.url) : [];
    return Boolean(
        message?.id
        && (String(message.mes || '').trim() || media.length || files.length || message.extra?.image_url),
    );
}

function giveMessageAnId(message, index, now = Date.now()) {
    if (!message || typeof message !== 'object') {
        return message;
    }
    if (message.id) {
        return message;
    }

    const createdAt = parsePositiveInt(message.created_at || message.send_date || now, now, 0);
    return {
        ...message,
        id: `legacy-${createdAt}-${index}`,
        created_at: message.created_at || createdAt,
    };
}

/** The old client's `safeParseMessages`: ids for messages that have none, and no message without content. */
function parseStoredMessages(stored) {
    if (!stored) {
        return [];
    }
    try {
        const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
        return Array.isArray(parsed)
            ? parsed.map((message, index) => giveMessageAnId(message, index)).filter(hasMessageContent)
            : [];
    } catch {
        return [];
    }
}

function getSafeBranchId(value, fallback = LEGACY_DEFAULT_CHAT_ID) {
    const branchId = String(value || '').trim();
    return branchId && branchId.length <= MAX_BRANCH_ID_LENGTH && isSafePropertyKey(branchId) ? branchId : fallback;
}

function createBranch(name = 'Main', id = LEGACY_DEFAULT_CHAT_ID) {
    const now = Date.now();
    return {
        id: getSafeBranchId(id),
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
 * A message whose id cannot be used as one gets `legacy-<created_at>-<index>`. A reply reference to the old id
 * follows the new one, so that the reply still points at the same message.
 */
function repairMessageIds(messages) {
    const reservedSafeIds = new Set(messages
        .map(message => typeof message[ORIGINAL_MESSAGE_ID] === 'string' ? message[ORIGINAL_MESSAGE_ID] : '')
        .filter(isSafeMessageId));
    const usedIds = new Set(reservedSafeIds);
    const retainedSafeIds = new Set();
    const remappedIds = new Map();
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        const originalValue = message[ORIGINAL_MESSAGE_ID];
        delete message[ORIGINAL_MESSAGE_ID];
        const originalId = typeof originalValue === 'string' ? originalValue : String(originalValue ?? '');
        const originalIdIsSafe = typeof originalValue === 'string' && isSafeMessageId(originalId);
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

function normalizeBranch(branch, id = LEGACY_DEFAULT_CHAT_ID) {
    const now = Date.now();
    const safeId = getSafeBranchId(id);
    const target = isObject(branch)
        ? getOwnRecord(branch)
        : createBranch(safeId === LEGACY_DEFAULT_CHAT_ID ? 'Main' : 'Conversation', safeId);

    target.id = safeId;
    target.name = target.name || (safeId === LEGACY_DEFAULT_CHAT_ID ? 'Main' : 'Conversation');
    const messages = Array.isArray(target.messages)
        ? target.messages.map(message => {
            if (!isObject(message)) {
                return message;
            }
            const normalizedMessage = { ...getOwnRecord(message), extra: normalizeAttachments(message.extra) };
            normalizedMessage[ORIGINAL_MESSAGE_ID] = message.id;
            return normalizedMessage;
        })
        : target.messages;
    target.messages = repairMessageIds(parseStoredMessages(messages));
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

// ---------------------------------------------------------------------------------------------------------------------
// Legacy unscoped keys: a thread key with no persona belongs to the persona that was active when the build still
// wrote them. The old client moved such a thread to the persona's key on first use.

function getMessageFingerprint(message) {
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
            const fingerprint = getMessageFingerprint(message);
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
            const fingerprint = getMessageFingerprint(message);
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

function mergeLegacyThread(destination, source) {
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

/**
 * Move an unscoped thread to the persona's key. When the persona's key already exists, merge into it and drop the
 * unscoped one only if the merge lost nothing; otherwise keep it, and remember which persona it was merged for.
 */
function moveLegacyThreadToPersona(store, avatar, groupId, personaId, scopedKey) {
    if (!personaId) {
        return;
    }
    const legacyKey = buildLegacyThreadKey(avatar, groupId, '');
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

    const merged = mergeLegacyThread(store.characters[scopedKey], store.characters[legacyKey]);
    if (merged.complete) {
        delete store.characters[legacyKey];
        delete store.legacyThreadPersonaAssignments[legacyKey];
    } else {
        store.legacyThreadPersonaAssignments[legacyKey] = personaId;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Group alias threads: a group's chat history was stored once per member, under that member's avatar. One of them is
// the anchor; the others are merged into it.

function mergeGroupMessages(destinationMessages, sourceMessages) {
    const destination = Array.isArray(destinationMessages) ? destinationMessages : [];
    const fingerprintCounts = destination.reduce((counts, message) => {
        const fingerprint = getMessageFingerprint(message);
        counts.set(fingerprint, (counts.get(fingerprint) || 0) + 1);
        return counts;
    }, new Map());
    const sourceCounts = new Map();
    for (const message of Array.isArray(sourceMessages) ? sourceMessages : []) {
        const fingerprint = getMessageFingerprint(message);
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

function mergeGroupThread(destination, source, sourceAvatar) {
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

function getGroupThreadRank(thread) {
    const branches = Object.values(getObject(thread?.branches));
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

// ---------------------------------------------------------------------------------------------------------------------
// Public readers.

/**
 * Normalize the stored object into a copy: safe records for every map, groups that pass `normalizeLegacyGroupRecord`,
 * and the top-level fields the old store always had. The argument is not changed.
 * @param {object} rawStore `settings.extension_settings.sillybunny_conversation`, or anything else (it reads as empty).
 * @returns {Record<string, any>}
 */
export function normalizeLegacyStore(rawStore) {
    // A JSON round trip, not `structuredClone`: the stored object came from JSON, and `isObject` accepts only objects
    // whose prototype is this realm's `Object.prototype`, which a `structuredClone` copy can fail in a test realm.
    const current = getObject(rawStore === undefined ? undefined : JSON.parse(JSON.stringify(rawStore)));
    const store = getOwnRecord(current);
    store.version = parsePositiveInt(current.version, 1, 1);
    store.localStorageMigrated = Boolean(current.localStorageMigrated);
    store.settings = getObject(current.settings);
    store.characters = getSafeRecord(current.characters);
    store.groups = Array.isArray(current.groups) ? current.groups.map(normalizeLegacyGroupRecord).filter(Boolean) : [];
    store.legacyThreadPersonaAssignments = getSafeRecord(current.legacyThreadPersonaAssignments);
    store.reminders = Array.isArray(current.reminders) ? current.reminders : [];
    return store;
}

/**
 * Read one thread of a normalized store: move a legacy unscoped key to the persona's key when the persona is known,
 * then normalize every branch. Changes the store it is given, which `normalizeLegacyStore` made as a copy.
 * @param {Record<string, any>} store A store from `normalizeLegacyStore`.
 * @param {string} avatar
 * @param {string} [groupId]
 * @param {{ personaId?: string }} [options]
 * @returns {Record<string, any>|null} The thread, or null when the key is unusable or no such thread exists.
 */
export function getLegacyThread(store, avatar, groupId = '', { personaId = '' } = {}) {
    const threadKey = buildLegacyThreadKey(avatar, groupId, personaId);
    if (!threadKey) {
        return null;
    }

    store.characters = getSafeRecord(store.characters);
    moveLegacyThreadToPersona(store, avatar, groupId, personaId, threadKey);
    if (!hasOwn(store.characters, threadKey) || !isObject(store.characters[threadKey])) {
        return null;
    }

    const thread = getOwnRecord(store.characters[threadKey]);
    store.characters[threadKey] = thread;
    thread.settings = getObject(thread.settings);
    thread.branches = getSafeRecord(thread.branches);
    for (const [branchId, branch] of Object.entries(thread.branches)) {
        const safeBranchId = getSafeBranchId(branchId);
        if (safeBranchId !== branchId) {
            if (!hasOwn(thread.branches, safeBranchId)) {
                thread.branches[safeBranchId] = normalizeBranch(branch, safeBranchId);
            }
            delete thread.branches[branchId];
            continue;
        }
        thread.branches[branchId] = normalizeBranch(branch, branchId);
    }
    thread.activeBranchId = getSafeBranchId(thread.activeBranchId);
    if (!hasOwn(thread.branches, thread.activeBranchId)) {
        thread.branches[thread.activeBranchId] = createBranch(
            thread.activeBranchId === LEGACY_DEFAULT_CHAT_ID ? 'Main' : 'Conversation',
            thread.activeBranchId,
        );
    }
    thread.branches[thread.activeBranchId] = normalizeBranch(
        thread.branches[thread.activeBranchId],
        thread.activeBranchId,
    );
    thread.threadAvatar = avatar;
    thread.groupId = groupId || '';
    return thread;
}

/**
 * Merge a group's per-member alias threads into one deterministic anchor thread. The anchor is the alias with
 * history, then the most recently updated, then the first member. Changes the store it is given.
 * @param {Record<string, any>} store A store from `normalizeLegacyStore`.
 * @param {{ id?: string, members?: string[], disabled_members?: string[] }} group A normalized group record.
 * @param {string} groupId
 * @param {string} [personaId]
 * @returns {{ avatar: string, threadKey: string }|null} The anchor, or null when no member can hold a thread.
 */
export function canonicalizeLegacyGroupThread(store, group, groupId, personaId = '') {
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
            && buildLegacyThreadKey(member, safeGroupId, personaId)
        ))));
    if (!activeMembers.length) {
        return null;
    }

    store.characters = getSafeRecord(store.characters);
    for (const member of activeMembers) {
        const scopedKey = buildLegacyThreadKey(member, safeGroupId, personaId);
        moveLegacyThreadToPersona(store, member, safeGroupId, personaId, scopedKey);
    }

    const candidates = activeMembers.map((avatar, index) => {
        const threadKey = buildLegacyThreadKey(avatar, safeGroupId, personaId);
        const thread = store.characters[threadKey];
        return {
            avatar,
            index,
            threadKey,
            thread,
            rank: isObject(thread) ? getGroupThreadRank(thread) : { hasHistory: false, updatedAt: 0 },
        };
    });
    candidates.sort((left, right) => (
        Number(right.rank.hasHistory) - Number(left.rank.hasHistory)
        || right.rank.updatedAt - left.rank.updatedAt
        || left.index - right.index
    ));
    const canonical = candidates[0];
    if (!isObject(store.characters[canonical.threadKey])) {
        const persistedCandidate = candidates.find(candidate => isObject(candidate.thread));
        if (persistedCandidate) {
            canonical.avatar = persistedCandidate.avatar;
            canonical.threadKey = persistedCandidate.threadKey;
            canonical.thread = persistedCandidate.thread;
        }
    }

    const canonicalThread = store.characters[canonical.threadKey];
    if (isObject(canonicalThread)) {
        for (const candidate of candidates) {
            if (candidate.threadKey === canonical.threadKey || !isObject(store.characters[candidate.threadKey])) {
                continue;
            }
            mergeGroupThread(canonicalThread, store.characters[candidate.threadKey], candidate.avatar);
            delete store.characters[candidate.threadKey];
        }
        canonicalThread.threadAvatar = canonical.avatar;
        canonicalThread.groupId = safeGroupId;
    }

    return { avatar: canonical.avatar, threadKey: canonical.threadKey };
}
