/**
 * Conversation Mode REST API - Utilities and Validation
 *
 * Shared utility functions for persona scoping, validation, and image fetching.
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import ipaddr from 'ipaddr.js';

// Validation constants
export const MAX_AVATAR_LENGTH = 512;
export const MAX_CHARACTER_FIELD_LENGTH = 8 * 1024; // 8KB
export const MAX_ARRAY_LENGTH = 1000;
export const MAX_CONVERSATION_STRING_LENGTH = 14 * 1024 * 1024;
export const MAX_CONVERSATION_PAYLOAD_BYTES = 24 * 1024 * 1024;
export const MAX_CONVERSATION_NESTING_DEPTH = 12;
export const MAX_CONVERSATION_PAYLOAD_ENTRIES = 5000;

// Image fetching constants
const IMAGE_FETCH_TIMEOUT_MS = 10000; // 10 seconds
const IMAGE_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const IMAGE_MAX_AGGREGATE_BYTES = 20 * 1024 * 1024; // 20MB
const IMAGE_MAX_COUNT = 32;
const IMAGE_MAX_REDIRECTS = 3;
const IMAGE_MAX_URL_LENGTH = 8192;

const PERSONA_CONVERSATION_STORE_PREFIX = 'persona:';
const RESERVED_PROPERTY_KEYS = new Set([
    ...Object.getOwnPropertyNames(Object.prototype),
    'prototype',
]);
const STORED_MESSAGE_ROLES = new Set(['user', 'character', 'assistant', 'partner', 'system']);
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;
const NON_GLOBAL_IP_RANGES = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.0.2.0/24',
    '192.31.196.0/24',
    '192.52.193.0/24',
    '192.88.99.0/24',
    '192.168.0.0/16',
    '192.175.48.0/24',
    '198.18.0.0/15',
    '198.51.100.0/24',
    '203.0.113.0/24',
    '224.0.0.0/4',
    '240.0.0.0/4',
    '::/128',
    '::1/128',
    '64:ff9b::/96',
    '64:ff9b:1::/48',
    '100::/64',
    '2001::/23',
    '2001:db8::/32',
    '2002::/16',
    '2620:4f:8000::/48',
    '3fff::/20',
    '5f00::/16',
    'fc00::/7',
    'fe80::/10',
    'ff00::/8',
].map(value => ipaddr.parseCIDR(value));

/**
 * Type guard for plain objects
 */
export function isObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
}

/**
 * Safe object getter - returns empty object if not a plain object
 */
export function getObject(value) {
    return isObject(value) ? value : {};
}

/**
 * Copy all own properties into a null-prototype record.
 */
export function getOwnRecord(value) {
    const record = Object.create(null);
    if (!isObject(value)) {
        return record;
    }
    for (const [key, item] of Object.entries(value)) {
        record[key] = item;
    }
    return record;
}

/**
 * Check an own property without consulting an object prototype.
 */
export function hasOwn(value, key) {
    return isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Create a null-prototype record from safe own properties.
 */
export function getSafeRecord(value) {
    const record = Object.create(null);
    if (!isObject(value)) {
        return record;
    }

    for (const [key, item] of Object.entries(value)) {
        if (isSafeConversationPropertyKey(key)) {
            record[key] = item;
        }
    }
    return record;
}

/**
 * Reject keys that can mutate or collide with JavaScript object prototypes.
 */
export function isSafeConversationPropertyKey(value) {
    const key = String(value ?? '');
    return Boolean(key && !RESERVED_PROPERTY_KEYS.has(key));
}

/**
 * Validate a user-controlled storage key component.
 */
export function validateConversationStoragePart(value, { required = false, maxLength = MAX_AVATAR_LENGTH, allowColon = true } = {}) {
    if (value === undefined || value === null || value === '') {
        return required ? { valid: false, error: 'value_required' } : { valid: true, value: '' };
    }
    if (typeof value !== 'string') {
        return { valid: false, error: 'invalid_value' };
    }

    const trimmed = value.trim();
    let encodable = true;
    try {
        encodeURIComponent(trimmed);
    } catch {
        encodable = false;
    }
    if ((!trimmed && required)
        || trimmed.length > maxLength
        || /[\u0000-\u001F\u007F]/.test(trimmed)
        || (!allowColon && trimmed.includes(':'))
        || !encodable
        || !isSafeConversationPropertyKey(trimmed)) {
        return { valid: false, error: 'invalid_value' };
    }
    return { valid: true, value: trimmed };
}

/**
 * Parse positive integer with fallback
 */
export function parsePositiveInt(value, fallback, min = 1) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/**
 * Clamp value between min and max
 */
export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * Normalize persona ID from request body
 */
export function getConversationPersonaId(personaId = '') {
    return String(personaId || '').trim();
}

/**
 * Extract persona ID from request (supports multiple aliases)
 */
export function getRequestPersonaId(request) {
    const value = request.body?.personaId
        || request.body?.persona
        || request.body?.personaAvatar
        || request.body?.userAvatar
        || '';
    return typeof value === 'string' ? value.trim() : value;
}

/**
 * URL-encode a storage key part
 */
export function encodeConversationStoragePart(value) {
    return encodeURIComponent(String(value || '').trim());
}

/**
 * Scope a storage key to a persona namespace
 */
export function scopeConversationStorageKey(storageKey, personaId = '') {
    const key = String(storageKey || '').trim();
    const persona = getConversationPersonaId(personaId);
    if (!key || !persona || key.startsWith(PERSONA_CONVERSATION_STORE_PREFIX) || !isSafeConversationPropertyKey(persona)) {
        return key;
    }

    return `${PERSONA_CONVERSATION_STORE_PREFIX}${encodeConversationStoragePart(persona)}:${key}`;
}

/**
 * Validate avatar parameter
 */
export function validateAvatar(avatar) {
    if (!avatar || typeof avatar !== 'string') {
        return { valid: false, error: 'avatar_required' };
    }
    const validation = validateConversationStoragePart(avatar, { required: true, allowColon: false });
    if (!validation.valid) {
        return { valid: false, error: 'invalid_avatar' };
    }
    return { valid: true, avatar: validation.value };
}

/**
 * Validate group/persona storage identifiers.
 */
export function validateConversationScope(groupId = '', personaId = '') {
    const groupValidation = validateConversationStoragePart(groupId, { allowColon: false });
    if (!groupValidation.valid) {
        return { valid: false, error: 'invalid_group_id' };
    }
    const personaValidation = validateConversationStoragePart(personaId);
    if (!personaValidation.valid) {
        return { valid: false, error: 'invalid_persona_id' };
    }
    return {
        valid: true,
        groupId: groupValidation.value,
        personaId: personaValidation.value,
    };
}

/**
 * Validate generation payload structure
 */
export function validateGenerationPayload(generation) {
    if (!isObject(generation)) {
        return { valid: false, error: 'generation_required' };
    }
    if (!isObject(generation.payload)) {
        return { valid: false, error: 'generation_payload_required' };
    }
    if (!generation.payload.model || typeof generation.payload.model !== 'string' || generation.payload.model.length > MAX_AVATAR_LENGTH) {
        return { valid: false, error: 'generation_model_required' };
    }
    return { valid: true };
}

/**
 * Enforce bounded, prototype-safe JSON payloads below the global 500MB parser.
 */
export function validateConversationPayload(value) {
    let entries = 0;
    let payloadBytes = 0;
    const stack = [{ value, depth: 0 }];

    while (stack.length) {
        const current = stack.pop();
        const item = current.value;
        if (current.depth > MAX_CONVERSATION_NESTING_DEPTH) {
            return { valid: false, error: 'payload_too_deep' };
        }
        if (typeof item === 'string') {
            const byteLength = Buffer.byteLength(item);
            if (byteLength > MAX_CONVERSATION_STRING_LENGTH) {
                return { valid: false, error: 'string_too_long' };
            }
            payloadBytes += byteLength;
            if (payloadBytes > MAX_CONVERSATION_PAYLOAD_BYTES) {
                return { valid: false, error: 'payload_too_large' };
            }
            continue;
        }
        if (item === null || item === undefined || typeof item === 'boolean') {
            continue;
        }
        if (typeof item === 'number') {
            if (!Number.isFinite(item)) {
                return { valid: false, error: 'invalid_number' };
            }
            continue;
        }
        if (Array.isArray(item)) {
            if (item.length > MAX_ARRAY_LENGTH) {
                return { valid: false, error: 'array_too_long' };
            }
            entries += item.length;
            for (const child of item) {
                stack.push({ value: child, depth: current.depth + 1 });
            }
        } else if (isObject(item)) {
            const ownEntries = Object.entries(item);
            entries += ownEntries.length;
            for (const [key, child] of ownEntries) {
                const keyBytes = Buffer.byteLength(key);
                if (keyBytes > MAX_CONVERSATION_STRING_LENGTH) {
                    return { valid: false, error: 'string_too_long' };
                }
                payloadBytes += keyBytes;
                if (payloadBytes > MAX_CONVERSATION_PAYLOAD_BYTES) {
                    return { valid: false, error: 'payload_too_large' };
                }
                stack.push({ value: child, depth: current.depth + 1 });
            }
        } else {
            return { valid: false, error: 'invalid_payload_value' };
        }

        if (entries > MAX_CONVERSATION_PAYLOAD_ENTRIES) {
            return { valid: false, error: 'payload_too_complex' };
        }
    }

    return { valid: true };
}

/**
 * Validate character override fields
 */
export function validateCharacterOverride(character) {
    if (!character) {
        return { valid: true };
    }
    if (!isObject(character)) {
        return { valid: false, error: 'invalid_character' };
    }
    if (character.data !== undefined && !isObject(character.data)) {
        return { valid: false, error: 'invalid_character_data' };
    }
    const fields = ['name', 'description', 'personality', 'scenario', 'mes_example', 'first_mes', 'creator_notes', 'creatorcomment'];
    for (const source of [character, getObject(character.data)]) {
        for (const field of fields) {
            if (source[field] !== undefined && typeof source[field] !== 'string') {
                return { valid: false, error: `invalid_character_${field}` };
            }
            if (source[field]?.length > MAX_CHARACTER_FIELD_LENGTH) {
                return { valid: false, error: `character_${field}_too_long` };
            }
        }
    }
    return { valid: true };
}

function isValidStoredAttachment(attachment) {
    return Boolean(
        isObject(attachment)
        && typeof attachment.url === 'string'
        && attachment.url.trim()
        && attachment.url.length <= MAX_CONVERSATION_STRING_LENGTH,
    );
}

export function validateConversationAttachments(extra) {
    if (extra === undefined) {
        return { valid: true };
    }
    if (!isObject(extra)) {
        return { valid: false, error: 'invalid_stored_attachment' };
    }
    for (const field of ['media', 'files']) {
        if (extra[field] !== undefined
            && (!Array.isArray(extra[field]) || extra[field].some(attachment => !isValidStoredAttachment(attachment)))) {
            return { valid: false, error: 'invalid_stored_attachment' };
        }
    }
    if (extra.image_url !== undefined && (typeof extra.image_url !== 'string' || !extra.image_url.trim())) {
        return { valid: false, error: 'invalid_stored_attachment' };
    }
    return { valid: true };
}

function validateStoredMessage(message) {
    if (!isObject(message)) {
        return { valid: false, error: 'invalid_stored_message' };
    }
    for (const field of ['id', 'name', 'send_date']) {
        if (message[field] !== undefined && typeof message[field] !== 'string') {
            return { valid: false, error: 'invalid_stored_message' };
        }
    }
    if (message.role !== undefined && (typeof message.role !== 'string' || !STORED_MESSAGE_ROLES.has(message.role))) {
        return { valid: false, error: 'invalid_stored_message' };
    }
    if (message.mes !== undefined && typeof message.mes !== 'string') {
        return { valid: false, error: 'invalid_stored_message' };
    }
    if (message.created_at !== undefined) {
        const timestamp = Number(message.created_at);
        if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_DATE_TIMESTAMP) {
            return { valid: false, error: 'invalid_stored_message' };
        }
    }
    const attachmentValidation = validateConversationAttachments(message.extra);
    if (!attachmentValidation.valid) {
        return attachmentValidation;
    }
    const extra = getObject(message.extra);
    const hasContent = Boolean(
        String(message.mes || '').trim()
        || (Array.isArray(extra.media) && extra.media.length)
        || (Array.isArray(extra.files) && extra.files.length)
        || (typeof extra.image_url === 'string' && extra.image_url),
    );
    return hasContent ? { valid: true } : { valid: false, error: 'invalid_stored_message' };
}

function validateStoredThread(threadStore) {
    if (!isObject(threadStore)) {
        return { valid: false, error: 'invalid_thread' };
    }
    if (threadStore.settings !== undefined && !isObject(threadStore.settings)) {
        return { valid: false, error: 'invalid_thread_settings' };
    }
    if (threadStore.activeBranchId !== undefined) {
        const branchId = threadStore.activeBranchId;
        if (typeof branchId !== 'string' || !branchId.trim() || branchId.length > 256 || !isSafeConversationPropertyKey(branchId)) {
            return { valid: false, error: 'invalid_branch_id' };
        }
    }
    if (threadStore.branches !== undefined && !isObject(threadStore.branches)) {
        return { valid: false, error: 'invalid_branches' };
    }
    for (const [branchId, branch] of Object.entries(getObject(threadStore.branches))) {
        if (!branchId.trim() || branchId.length > 256 || !isSafeConversationPropertyKey(branchId) || !isObject(branch)) {
            return { valid: false, error: 'invalid_branch_id' };
        }
        if (branch.id !== undefined && (typeof branch.id !== 'string' || branch.id !== branchId)) {
            return { valid: false, error: 'invalid_branch_id' };
        }
        if (branch.messages !== undefined && !Array.isArray(branch.messages)) {
            return { valid: false, error: 'invalid_branch_messages' };
        }
        for (const message of branch.messages || []) {
            const messageValidation = validateStoredMessage(message);
            if (!messageValidation.valid) {
                return messageValidation;
            }
        }
        for (const field of ['scheduleTriggers', 'sessionMarkers']) {
            if (branch[field] !== undefined && !isObject(branch[field])) {
                return { valid: false, error: `invalid_branch_${field}` };
            }
            if (Object.keys(getObject(branch[field])).some(key => !isSafeConversationPropertyKey(key))) {
                return { valid: false, error: `unsafe_branch_${field}_key` };
            }
        }
    }
    return { valid: true };
}

/**
 * Validate Conversation Mode store structure without discarding future fields.
 */
export function validateStoreStructure(store) {
    if (!isObject(store)) {
        return { valid: false, error: 'invalid_store' };
    }

    const payloadValidation = validateConversationPayload(store);
    if (!payloadValidation.valid) {
        return payloadValidation;
    }
    if (store.version !== undefined && (!Number.isSafeInteger(store.version) || store.version < 1)) {
        return { valid: false, error: 'invalid_store_version' };
    }
    if (store.localStorageMigrated !== undefined && typeof store.localStorageMigrated !== 'boolean') {
        return { valid: false, error: 'invalid_migration_state' };
    }
    if (store.settings !== undefined && !isObject(store.settings)) {
        return { valid: false, error: 'invalid_store_settings' };
    }
    for (const field of ['userStatus', 'userPersonaStatus']) {
        if (store[field] !== undefined && (typeof store[field] !== 'string' || store[field].length > MAX_CHARACTER_FIELD_LENGTH)) {
            return { valid: false, error: `invalid_${field}` };
        }
    }

    if (store.groups !== undefined && !Array.isArray(store.groups)) {
        return { valid: false, error: 'invalid_groups' };
    }
    if (Array.isArray(store.groups) && store.groups.length > MAX_ARRAY_LENGTH) {
        return { valid: false, error: 'too_many_groups' };
    }
    const groupIds = new Set();
    for (const group of store.groups || []) {
        if (!isObject(group) || !Array.isArray(group.members)) {
            return { valid: false, error: 'invalid_group' };
        }
        const idValidation = validateConversationStoragePart(group.id, { required: true, allowColon: false });
        if (!idValidation.valid) {
            return { valid: false, error: 'invalid_group' };
        }
        if (groupIds.has(idValidation.value)) {
            return { valid: false, error: 'duplicate_group_id' };
        }
        groupIds.add(idValidation.value);

        const normalizedMembers = group.members.map(member => validateConversationStoragePart(member, { required: true, allowColon: false }));
        if (normalizedMembers.length < 2 || normalizedMembers.some(validation => !validation.valid)) {
            return { valid: false, error: 'invalid_group_members' };
        }
        const memberValues = normalizedMembers.map(validation => validation.value);
        if (new Set(memberValues).size !== memberValues.length) {
            return { valid: false, error: 'duplicate_group_members' };
        }
        if (group.disabled_members !== undefined && !Array.isArray(group.disabled_members)) {
            return { valid: false, error: 'invalid_disabled_group_members' };
        }
        const disabledMembers = (group.disabled_members || []).map(member => validateConversationStoragePart(member, { required: true, allowColon: false }));
        if (disabledMembers.some(validation => !validation.valid)) {
            return { valid: false, error: 'invalid_disabled_group_members' };
        }
        const disabledMemberValues = disabledMembers.map(validation => validation.value);
        if (new Set(disabledMemberValues).size !== disabledMemberValues.length) {
            return { valid: false, error: 'duplicate_disabled_group_members' };
        }
        if (disabledMemberValues.some(member => !memberValues.includes(member))) {
            return { valid: false, error: 'invalid_disabled_group_members' };
        }
        if (group.conversation_settings !== undefined && !isObject(group.conversation_settings)) {
            return { valid: false, error: 'invalid_group_settings' };
        }
        for (const field of ['personaId', 'persona', 'personaAvatar', 'userAvatar']) {
            if (group[field] !== undefined && !validateConversationStoragePart(group[field], { allowColon: false }).valid) {
                return { valid: false, error: 'invalid_group_persona' };
            }
        }
    }

    if (store.reminders !== undefined && !Array.isArray(store.reminders)) {
        return { valid: false, error: 'invalid_reminders' };
    }
    if (Array.isArray(store.reminders) && store.reminders.length > MAX_ARRAY_LENGTH) {
        return { valid: false, error: 'too_many_reminders' };
    }
    if (store.characters !== undefined && !isObject(store.characters)) {
        return { valid: false, error: 'invalid_characters' };
    }
    for (const [threadKey, threadStore] of Object.entries(getObject(store.characters))) {
        if (!isSafeConversationPropertyKey(threadKey)) {
            return { valid: false, error: 'unsafe_thread_key' };
        }
        const threadValidation = validateStoredThread(threadStore);
        if (!threadValidation.valid) {
            return threadValidation;
        }
    }

    if (store.legacyThreadPersonaAssignments !== undefined && !isObject(store.legacyThreadPersonaAssignments)) {
        return { valid: false, error: 'invalid_legacy_thread_assignments' };
    }
    for (const [threadKey, personaId] of Object.entries(getObject(store.legacyThreadPersonaAssignments))) {
        if (!isSafeConversationPropertyKey(threadKey) || !validateConversationStoragePart(personaId, { required: true }).valid) {
            return { valid: false, error: 'invalid_legacy_thread_assignment' };
        }
    }

    return { valid: true };
}

/**
 * Check if an avatar is a member of a group
 */
export function isAvatarInGroup(avatar, groupId, store, personaId = '') {
    const groups = Array.isArray(store.groups) ? store.groups : [];
    const group = groups.find(g => String(g?.id) === String(groupId) && getConversationPersonaId(g?.personaId) === getConversationPersonaId(personaId));
    if (!group) {
        return false;
    }
    return Array.isArray(group.members) && group.members.includes(avatar) &&
           !(Array.isArray(group.disabled_members) && group.disabled_members.includes(avatar));
}

/**
 * Check whether an IP is globally routable.
 */
export function isGlobalIPAddress(address) {
    try {
        const parsed = ipaddr.process(address);
        return parsed.range() === 'unicast' && !NON_GLOBAL_IP_RANGES.some(([network, prefix]) => (
            network.kind() === parsed.kind() && parsed.match(network, prefix)
        ));
    } catch {
        return false;
    }
}

function createAbortError() {
    const error = new Error('Image fetch aborted');
    error.name = 'AbortError';
    error.status = 499;
    error.apiError = 'request_aborted';
    return error;
}

async function resolveGlobalAddress(hostname, signal) {
    const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (signal?.aborted) {
        throw createAbortError();
    }

    let timer;
    let abort;
    const lookup = net.isIP(host)
        ? Promise.resolve([{ address: host, family: net.isIP(host) }])
        : dns.promises.lookup(host, { all: true, verbatim: true });
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(createAbortError()), IMAGE_FETCH_TIMEOUT_MS);
        timer.unref?.();
        abort = () => reject(createAbortError());
        signal?.addEventListener('abort', abort, { once: true });
    });
    let addresses;
    try {
        addresses = await Promise.race([lookup, timeout]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
    if (!addresses.length || addresses.some(result => !isGlobalIPAddress(result.address))) {
        throw new Error('Image host did not resolve exclusively to global addresses');
    }
    return { address: addresses[0].address, family: net.isIP(addresses[0].address) };
}

export function createConversationPinnedLookup(address, family = net.isIP(address)) {
    const resolvedFamily = net.isIP(address);
    return (_hostname, options, callback) => {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        if (typeof callback !== 'function') {
            return;
        }
        const requestedFamily = typeof options === 'number' ? options : Number(options?.family || 0);
        if (!resolvedFamily || (family !== resolvedFamily) || ([4, 6].includes(requestedFamily) && requestedFamily !== resolvedFamily)) {
            callback(new Error('Pinned image address is invalid'));
            return;
        }
        if (typeof options === 'object' && options?.all) {
            callback(null, [{ address, family: resolvedFamily }]);
            return;
        }
        callback(null, address, resolvedFamily);
    };
}

function readImageDataUrl(imageUrl, maxBytes) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(imageUrl);
    if (!match || !/^image\/[a-z0-9.+-]+$/i.test(match[1])) {
        return null;
    }

    try {
        let buffer;
        if (match[2]) {
            const encoded = match[3].replace(/\s/g, '');
            const paddingBytes = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
            const decodedSize = Math.floor(encoded.length * 3 / 4) - paddingBytes;
            if (!/^[a-z0-9+/]*={0,2}$/i.test(encoded) || encoded.length % 4 === 1 || decodedSize > maxBytes) {
                return null;
            }
            buffer = Buffer.from(encoded, 'base64');
        } else {
            if (match[3].length > maxBytes * 3) {
                return null;
            }
            buffer = Buffer.from(decodeURIComponent(match[3]), 'utf8');
        }
        return buffer.byteLength <= maxBytes ? { dataUrl: imageUrl, byteLength: buffer.byteLength } : null;
    } catch {
        return null;
    }
}

export function resolveConversationImageRedirect(location, currentUrl) {
    if (typeof location !== 'string' || !location || location.length > IMAGE_MAX_URL_LENGTH) {
        return '';
    }
    try {
        return new URL(location, currentUrl).toString();
    } catch {
        return '';
    }
}

async function fetchRemoteImage(imageUrl, { signal, maxBytes, redirectsRemaining }) {
    const url = new URL(imageUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Unsupported image URL');
    }

    const resolved = await resolveGlobalAddress(url.hostname, signal);
    const transport = url.protocol === 'https:' ? https : http;
    const agent = url.protocol === 'https:' ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
    return new Promise((resolve, reject) => {
        let settled = false;
        let timeout;
        const finish = (callback, value) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
            callback(value);
        };
        const abort = () => request.destroy(createAbortError());
        const request = transport.get(url, {
            agent,
            headers: {
                'Connection': 'close',
                'User-Agent': 'SillyBunny-Conversation-API/1.0',
            },
            lookup: createConversationPinnedLookup(resolved.address, resolved.family),
        }, response => {
            response.on('error', error => finish(reject, error));
            const status = response.statusCode || 0;
            if (status >= 300 && status < 400 && response.headers.location) {
                if (redirectsRemaining <= 0) {
                    response.resume();
                    finish(reject, new Error('Too many image redirects'));
                    return;
                }
                const redirectUrl = resolveConversationImageRedirect(response.headers.location, url);
                response.resume();
                if (!redirectUrl) {
                    finish(reject, new Error('Image redirect location is invalid'));
                    return;
                }
                fetchRemoteImage(redirectUrl, { signal, maxBytes, redirectsRemaining: redirectsRemaining - 1 })
                    .then(result => finish(resolve, result), error => finish(reject, error));
                return;
            }
            if (status < 200 || status >= 300) {
                response.resume();
                finish(reject, new Error(`Image request failed with status ${status}`));
                return;
            }

            const contentType = String(response.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
            if (!/^image\/[a-z0-9.+-]+$/.test(contentType)) {
                response.resume();
                finish(reject, new Error('Image response has an invalid content type'));
                return;
            }
            const contentLength = Number(response.headers['content-length']);
            if (Number.isFinite(contentLength) && contentLength > maxBytes) {
                response.resume();
                finish(reject, new Error('Image response is too large'));
                return;
            }

            const chunks = [];
            let byteLength = 0;
            response.on('data', chunk => {
                byteLength += chunk.length;
                if (byteLength > maxBytes) {
                    response.destroy(new Error('Image response is too large'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                const buffer = Buffer.concat(chunks, byteLength);
                finish(resolve, {
                    dataUrl: `data:${contentType};base64,${buffer.toString('base64')}`,
                    byteLength,
                });
            });
        });

        timeout = setTimeout(() => {
            const error = createAbortError();
            request.destroy(error);
            finish(reject, error);
        }, IMAGE_FETCH_TIMEOUT_MS);
        timeout.unref?.();
        request.on('error', error => finish(reject, error));
        if (signal?.aborted) {
            abort();
        } else {
            signal?.addEventListener('abort', abort, { once: true });
        }
    });
}

/**
 * Fetch image URL and convert to base64 with SSRF protection
 */
export async function fetchImageToBase64(imageUrl, { signal, maxBytes = IMAGE_MAX_SIZE_BYTES, includeSize = false } = {}) {
    if (typeof imageUrl !== 'string' || !imageUrl) {
        return includeSize ? { dataUrl: '', byteLength: 0 } : '';
    }

    if (imageUrl.startsWith('data:')) {
        const result = readImageDataUrl(imageUrl, maxBytes) || { dataUrl: '', byteLength: 0 };
        return includeSize ? result : result.dataUrl;
    }
    if (imageUrl.length > IMAGE_MAX_URL_LENGTH) {
        return includeSize ? { dataUrl: '', byteLength: 0 } : '';
    }

    try {
        const result = await fetchRemoteImage(imageUrl, { signal, maxBytes, redirectsRemaining: IMAGE_MAX_REDIRECTS });
        return includeSize ? result : result.dataUrl;
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        console.warn(`Conversation REST API: rejected image URL: ${error.message}`);
        return includeSize ? { dataUrl: '', byteLength: 0 } : '';
    }
}

/**
 * Convert multiple image URLs to base64 with concurrency control
 */
export async function convertImageUrlsToBase64(imageUrls, concurrency = 3, { signal, maxAggregateBytes = IMAGE_MAX_AGGREGATE_BYTES } = {}) {
    const urls = Array.isArray(imageUrls) ? imageUrls : [];
    if (!urls.length) {
        return [];
    }

    const results = new Array(urls.length).fill('');
    let nextIndex = 0;
    let aggregateBytes = 0;
    let reservedBytes = 0;
    const processCount = Math.min(urls.length, IMAGE_MAX_COUNT);
    const aggregateWorkerLimit = Math.max(1, Math.ceil(maxAggregateBytes / IMAGE_MAX_SIZE_BYTES));
    const workerCount = Math.max(1, Math.min(concurrency, processCount, aggregateWorkerLimit));
    const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < processCount) {
            const index = nextIndex;
            nextIndex += 1;
            const remainingBytes = Math.min(IMAGE_MAX_SIZE_BYTES, maxAggregateBytes - aggregateBytes - reservedBytes);
            if (remainingBytes <= 0) {
                continue;
            }
            reservedBytes += remainingBytes;
            let result;
            try {
                result = await fetchImageToBase64(urls[index], { signal, maxBytes: remainingBytes, includeSize: true });
            } finally {
                reservedBytes -= remainingBytes;
            }
            if (result.dataUrl && aggregateBytes + result.byteLength <= maxAggregateBytes) {
                aggregateBytes += result.byteLength;
                results[index] = result.dataUrl;
            }
        }
    });

    await Promise.all(workers);
    return results;
}

/**
 * Extract avatar from request body
 */
export function getRequestAvatar(request) {
    const value = request.body?.avatar ?? '';
    return typeof value === 'string' ? value.trim() : value;
}

/**
 * Extract groupId from request body
 */
export function getRequestGroupId(request) {
    const value = request.body?.groupId ?? '';
    return typeof value === 'string' ? value.trim() : value;
}
