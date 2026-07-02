/**
 * Conversation Mode REST API - Group Management
 *
 * Functions for managing Conversation-owned group DMs.
 */

import path from 'node:path';
import sanitize from 'sanitize-filename';

import {
    DEFAULT_SETTINGS,
    GROUP_CONVERSATION_SETTINGS_KEYS,
} from '../../public/scripts/sillybunny-conversation/constants.js';
import { getObject, parsePositiveInt, getConversationPersonaId } from './conversation-utils.js';
import { readJsonFile } from './conversation-store.js';

/**
 * Normalize group-scoped conversation settings (subset of full settings)
 */
export function normalizeGroupConversationSettings(settings = {}, normalizeConversationSettings) {
    const source = getObject(settings);
    const normalized = normalizeConversationSettings(source);
    return GROUP_CONVERSATION_SETTINGS_KEYS.reduce((picked, key) => {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            picked[key] = normalized[key];
        }
        return picked;
    }, {});
}

/**
 * Get default group conversation settings
 */
export function getDefaultGroupConversationSettings(normalizeConversationSettings) {
    return normalizeGroupConversationSettings({
        ...DEFAULT_SETTINGS,
        multi_char: true,
        auto_character_chat: true,
    }, normalizeConversationSettings);
}

/**
 * Get unique group members (deduplicated and trimmed)
 */
export function getUniqueConversationGroupMembers(memberAvatars) {
    return Array.from(new Set(
        (Array.isArray(memberAvatars) ? memberAvatars : [])
            .map(avatar => String(avatar || '').trim())
            .filter(Boolean),
    ));
}

/**
 * Normalize a group record
 */
export function normalizeConversationGroupRecord(group, normalizeConversationSettings) {
    const source = getObject(group);
    const id = String(source.id || '').trim();
    const personaId = getConversationPersonaId(source.personaId || source.persona || source.personaAvatar || source.userAvatar);
    const members = getUniqueConversationGroupMembers(source.members);
    if (!id || members.length < 2) {
        return null;
    }

    const now = Date.now();
    return {
        ...source,
        id,
        personaId,
        name: String(source.name || 'Conversation Group'),
        members,
        disabled_members: getUniqueConversationGroupMembers(source.disabled_members).filter(avatar => members.includes(avatar)),
        conversation_settings: normalizeGroupConversationSettings(source.conversation_settings, normalizeConversationSettings),
        is_conversation_group: true,
        createdAt: parsePositiveInt(source.createdAt, now, 0),
        updatedAt: parsePositiveInt(source.updatedAt, source.createdAt || now, 0),
    };
}

/**
 * Create a new conversation group record
 */
export function createConversationGroupRecord(memberAvatars, { name = '', avatarUrl = '', settings = null, personaId = '' } = {}, normalizeConversationSettings) {
    const members = getUniqueConversationGroupMembers(memberAvatars);
    if (members.length < 2) {
        return null;
    }

    const now = Date.now();
    return normalizeConversationGroupRecord({
        id: `conversation_${now}_${Math.random().toString(36).slice(2)}`,
        personaId: getConversationPersonaId(personaId),
        name: name || 'Conversation Group',
        members,
        avatar_url: avatarUrl || '',
        disabled_members: [],
        conversation_settings: settings || getDefaultGroupConversationSettings(normalizeConversationSettings),
        createdAt: now,
        updatedAt: now,
    }, normalizeConversationSettings);
}

/**
 * Get all conversation groups for a persona
 */
export function getConversationGroups(store, personaId = '', normalizeConversationSettings) {
    const persona = getConversationPersonaId(personaId);
    store.groups = Array.isArray(store.groups) ? store.groups.map(g => normalizeConversationGroupRecord(g, normalizeConversationSettings)).filter(Boolean) : [];
    return store.groups.filter(group => getConversationPersonaId(group.personaId) === persona);
}

/**
 * Get a single conversation group by ID
 */
export function getConversationGroupRecord(store, groupId, personaId = '', normalizeConversationSettings) {
    const safeGroupId = String(groupId || '').trim();
    if (!safeGroupId) {
        return null;
    }

    return getConversationGroups(store, personaId, normalizeConversationSettings).find(group => String(group?.id) === safeGroupId) || null;
}

/**
 * Get conversation settings for a group (from store or disk)
 */
export function getGroupConversationSettings(request, store, groupId, personaId = '', normalizeConversationSettings) {
    if (!groupId) {
        return {};
    }

    const conversationGroup = getConversationGroupRecord(store, groupId, personaId, normalizeConversationSettings);
    if (conversationGroup) {
        return getObject(conversationGroup.conversation_settings);
    }

    if (!request.user.directories.groups) {
        return {};
    }

    const groupPath = path.join(request.user.directories.groups, sanitize(`${groupId}.json`));
    const group = readJsonFile(groupPath, null);
    return getObject(group?.data?.conversation_settings);
}
