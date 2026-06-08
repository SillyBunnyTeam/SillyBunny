import { Fuse } from '../lib.js';

import {
    shuffle,
    onlyUnique,
    debounce,
    delay,
    isDataURL,
    createThumbnail,
    extractAllWords,
    saveBase64AsFile,
    PAGINATION_TEMPLATE,
    getBase64Async,
    resetScrollHeight,
    initScrollHeight,
    localizePagination,
    renderPaginationDropdown,
    paginationDropdownChangeHandler,
    waitUntilCondition,
    uuidv4,
} from './utils.js';
import { RA_CountCharTokens, humanizedDateTime, dragElement, favsToHotswap } from './RossAscends-mods.js';
import { power_user, loadMovingUIState, sortEntitiesList } from './power-user.js';
import { debounce_timeout } from './constants.js';

import {
    chat,
    sendSystemMessage,
    printMessages,
    characters,
    default_avatar,
    clearChat,
    Generate,
    generateRaw,
    select_rm_info,
    setCharacterId,
    setCharacterName,
    setEditedMessageId,
    is_send_press,
    resetChatState,
    setSendButtonState,
    getCharacters,
    system_message_types,
    online_status,
    talkativeness_default,
    selectRightMenuWithAnimation,
    deleteLastMessage,
    showSwipeButtons,
    hideSwipeButtons,
    chat_metadata,
    updateChatMetadata,
    getThumbnailUrl,
    setMenuType,
    menu_type,
    select_selected_character,
    cancelTtsPlay,
    displayPastChats,
    sendMessageAsUser,
    getBiasStrings,
    saveChatConditional,
    flushPendingChatSavesForNavigation,
    deactivateSendButtons,
    activateSendButtons,
    eventSource,
    event_types,
    getCurrentChatId,
    setCharacterSettingsOverrides,
    system_avatar,
    getRequestHeaders,
    isChatSaving,
    setExternalAbortController,
    baseChatReplace,
    createLazyFields,
    depth_prompt_depth_default,
    loadItemizedPrompts,
    animation_duration,
    depth_prompt_role_default,
    shouldAutoContinue,
    setGenerationChatFilter,
    setPendingGeneratedMessageExtra,
    setPendingUserMessageExtra,
    unshallowCharacter,
    chatElement,
    ensureMessageMediaIsArray,
    syncCharacterMenuActiveEntity,
    incrementChatGeneration,
} from '../script.js';
import { printTagList, createTagMapFromList, applyTagsOnCharacterSelect, tag_map, applyTagsOnGroupSelect, printTagFilters, tag_filter_type } from './tags.js';
import { FILTER_TYPES, FilterHelper } from './filters.js';
import { isExternalMediaAllowed } from './chats.js';
import { POPUP_TYPE, Popup, callGenericPopup } from './popup.js';
import { t } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';
import { compressRequest } from './request-compression.js';
import { chat_completion_sources, oai_settings } from './openai.js';

export {
    selected_group,
    openGroupId,
    is_group_automode_enabled,
    hideMutedSprites,
    is_group_generating,
    group_generation_id,
    groups,
    saveGroupChat,
    generateGroupWrapper,
    deleteGroup,
    getGroupAvatar,
    getGroups,
    regenerateGroup,
    resetSelectedGroup,
    select_group_chats,
    getGroupChatNames,
    getSelectedGroupSpeakerAvatar,
    updateGroupSpeakerControls,
};

let is_group_generating = false; // Group generation flag
let is_group_automode_enabled = false;
let isGroupScheduleGenerating = false;
let hideMutedSprites = false;
/** @type {Group[]} */
let groups = [];
/** @type {string|null} */
let selected_group = null;
let group_generation_id = null;
let fav_grp_checked = false;
let openGroupId = null;
let newGroupMembers = [];
let groupChatSaveQueue = Promise.resolve();

const GROUP_MEMBER_MODELS_KEY = 'member_models';
const GROUP_AUTO_MODE_KEY = 'SillyBunny.groupAutoModeEnabled';
const GROUP_DM_SETTINGS_KEY = 'SillyBunny.groupDmSettings';
const GROUP_DM_UNREAD_KEY = 'SillyBunny.groupDmUnread';
const ENTITY_SELECTION_PULSE_CLEANUP_MS = 900;
const defaultGroupDmSettings = {
    autoDmEnabled: false,
    autoDmMember: '',
};
let entitySelectionPulseId = 0;

function pulseSelectedEntityCard(card) {
    const charactersBlock = card?.closest?.('#rm_print_characters_block');
    if (!(charactersBlock instanceof HTMLElement) || !(card instanceof HTMLElement)) {
        return;
    }

    charactersBlock.querySelectorAll('.sb-just-selected').forEach(element => {
        element.classList.remove('sb-just-selected');
        element.removeAttribute('data-sb-selection-pulse');
    });

    const pulseToken = String(++entitySelectionPulseId);
    let cleanupTimer = 0;
    const cleanupPulse = () => {
        window.clearTimeout(cleanupTimer);
        card.removeEventListener('animationend', cleanupPulseOnAnimationEnd);
        if (card.dataset.sbSelectionPulse !== pulseToken) {
            return;
        }

        card.classList.remove('sb-just-selected');
        card.removeAttribute('data-sb-selection-pulse');
    };
    const cleanupPulseOnAnimationEnd = (event) => {
        if (event.target !== card || event.animationName !== 'sb-entity-select-pulse') {
            return;
        }

        cleanupPulse();
    };

    card.dataset.sbSelectionPulse = pulseToken;
    card.classList.add('sb-just-selected');
    card.addEventListener('animationend', cleanupPulseOnAnimationEnd, { once: true });
    cleanupTimer = window.setTimeout(cleanupPulse, ENTITY_SELECTION_PULSE_CLEANUP_MS);
}

function getGlobalGroupAutoModeEnabled() {
    return accountStorage.getItem(GROUP_AUTO_MODE_KEY) === 'true';
}

function saveGlobalGroupAutoModeEnabled(enabled) {
    accountStorage.setItem(GROUP_AUTO_MODE_KEY, String(Boolean(enabled)));
}

function applyGlobalGroupAutoModeSettings() {
    is_group_automode_enabled = getGlobalGroupAutoModeEnabled();
}

function getGlobalGroupDmSettings() {
    try {
        const stored = JSON.parse(accountStorage.getItem(GROUP_DM_SETTINGS_KEY) || '{}');
        return { ...defaultGroupDmSettings, ...(stored && typeof stored === 'object' ? stored : {}) };
    } catch {
        return { ...defaultGroupDmSettings };
    }
}

function saveGlobalGroupDmSettings(settings) {
    accountStorage.setItem(GROUP_DM_SETTINGS_KEY, JSON.stringify({ ...getGlobalGroupDmSettings(), ...settings }));
}

function applyGlobalGroupDmSettings() {
    const settings = getGlobalGroupDmSettings();
    selectedGroupDmAvatar = String(settings.autoDmMember || '');
}

function getGroupDmUnreadState() {
    try {
        const stored = JSON.parse(accountStorage.getItem(GROUP_DM_UNREAD_KEY) || '{}');
        return stored && typeof stored === 'object' ? stored : {};
    } catch {
        return {};
    }
}

function saveGroupDmUnreadState(state) {
    accountStorage.setItem(GROUP_DM_UNREAD_KEY, JSON.stringify(state || {}));
}

function getGroupDmUnreadKey(groupId, avatarId) {
    return `${groupId || ''}:${avatarId || ''}`;
}

function hasUnreadGroupDm(groupId, avatarId) {
    return Boolean(getGroupDmUnreadState()[getGroupDmUnreadKey(groupId, avatarId)]);
}

function setUnreadGroupDm(groupId, avatarId, unread = true) {
    const key = getGroupDmUnreadKey(groupId, avatarId);
    if (!key || key === ':') {
        return;
    }

    const state = getGroupDmUnreadState();
    if (unread) {
        state[key] = Date.now();
    } else {
        delete state[key];
    }
    saveGroupDmUnreadState(state);
    updateGroupSpeakerControls();
}


function getGroupMemberModels(group) {
    if (!group || typeof group !== 'object') {
        return {};
    }

    if (!group[GROUP_MEMBER_MODELS_KEY] || typeof group[GROUP_MEMBER_MODELS_KEY] !== 'object') {
        group[GROUP_MEMBER_MODELS_KEY] = {};
    }

    return group[GROUP_MEMBER_MODELS_KEY];
}

function getGroupMemberModel(group, avatarId) {
    return String(getGroupMemberModels(group)[avatarId] ?? '').trim();
}

function setGroupMemberModel(group, avatarId, model) {
    if (!group || !avatarId) {
        return;
    }

    const models = getGroupMemberModels(group);
    const value = String(model ?? '').trim();
    if (value) {
        models[avatarId] = value;
    } else {
        delete models[avatarId];
    }
}

function getCurrentChatCompletionModelSettingKey() {
    switch (oai_settings.chat_completion_source) {
        case chat_completion_sources.CLAUDE: return 'claude_model';
        case chat_completion_sources.OPENAI:
        case chat_completion_sources.OPENAI_RESPONSES: return 'openai_model';
        case chat_completion_sources.MAKERSUITE: return 'google_model';
        case chat_completion_sources.VERTEXAI: return 'vertexai_model';
        case chat_completion_sources.OPENROUTER: return 'openrouter_model';
        case chat_completion_sources.AI21: return 'ai21_model';
        case chat_completion_sources.MISTRALAI: return 'mistralai_model';
        case chat_completion_sources.CUSTOM: return 'custom_model';
        case chat_completion_sources.COHERE: return 'cohere_model';
        case chat_completion_sources.PERPLEXITY: return 'perplexity_model';
        case chat_completion_sources.GROQ: return 'groq_model';
        case chat_completion_sources.SILICONFLOW: return 'siliconflow_model';
        case chat_completion_sources.ELECTRONHUB: return 'electronhub_model';
        case chat_completion_sources.CHUTES: return 'chutes_model';
        case chat_completion_sources.NANOGPT: return 'nanogpt_model';
        case chat_completion_sources.DEEPSEEK: return 'deepseek_model';
        case chat_completion_sources.AIMLAPI: return 'aimlapi_model';
        case chat_completion_sources.XAI: return 'xai_model';
        case chat_completion_sources.POLLINATIONS: return 'pollinations_model';
        case chat_completion_sources.COMETAPI: return 'cometapi_model';
        case chat_completion_sources.MOONSHOT: return 'moonshot_model';
        case chat_completion_sources.FIREWORKS: return 'fireworks_model';
        case chat_completion_sources.AZURE_OPENAI: return 'azure_openai_model';
        case chat_completion_sources.ZAI: return 'zai_model';
        default: return '';
    }
}

async function runWithGroupMemberModelOverride(group, avatarId, callback) {
    const model = getGroupMemberModel(group, avatarId);
    const settingKey = model ? getCurrentChatCompletionModelSettingKey() : '';

    if (!model || !settingKey) {
        return callback();
    }

    const previousModel = oai_settings[settingKey];
    oai_settings[settingKey] = model;
    try {
        console.debug(`[Group] Using model override for ${avatarId}: ${model}`);
        return await callback();
    } finally {
        oai_settings[settingKey] = previousModel;
    }
}

let selectedGroupSpeakerAvatar = '';
let groupSpeakerControlsInitialized = false;
let selectedGroupDmAvatar = '';
let groupDmModeEnabled = false;
let groupDmModeForced = false;
let pendingGroupDmUserTarget = '';
let activeGroupTypingName = '';
let groupSpeakerAvatarRenderKey = '';
let groupScheduleCheckInterval = null;

function getCharacterIdByAvatar(avatarId) {
    return characters.findIndex(character => character.avatar === avatarId);
}

function getSelectedGroupSpeakerAvatar() {
    return selectedGroupSpeakerAvatar;
}

function getGroupEnabledMembers(group) {
    if (!group || !Array.isArray(group.members)) {
        return [];
    }

    return group.members.filter(member => !group.disabled_members?.includes(member));
}

function isGroupDmChatMetadata(metadata = chat_metadata) {
    return metadata?.type === 'group_dm_chat' && Boolean(metadata?.dm_member);
}

function getGroupDmParticipants(metadata = chat_metadata) {
    if (!isGroupDmChatMetadata(metadata)) {
        return [];
    }

    return [metadata.dm_member, ...(Array.isArray(metadata.dm_participants) ? metadata.dm_participants : [])]
        .map(avatar => String(avatar || ''))
        .filter(Boolean)
        .filter(onlyUnique);
}

function isGroupDmParticipant(avatarId, metadata = chat_metadata) {
    return getGroupDmParticipants(metadata).includes(String(avatarId || ''));
}

function getGroupDmAllowedMembers(group, metadata = chat_metadata) {
    const enabledMembers = getGroupEnabledMembers(group);
    if (!isGroupDmChatMetadata(metadata)) {
        return enabledMembers;
    }

    const participants = getGroupDmParticipants(metadata);
    return enabledMembers.filter(avatar => participants.includes(avatar));
}

async function inviteGroupDmParticipant(avatarId) {
    if (!isGroupDmChatMetadata(chat_metadata)) {
        return false;
    }

    const avatar = String(avatarId || '');
    if (!avatar || isGroupDmParticipant(avatar)) {
        return false;
    }

    const participants = getGroupDmParticipants(chat_metadata);
    const nextParticipants = [...participants, avatar].filter(onlyUnique);
    updateChatMetadata({ ...chat_metadata, dm_participants: nextParticipants }, true);
    await saveChatConditional();
    return true;
}

function applyGroupDmChatMode(metadata = chat_metadata) {
    if (isGroupDmChatMetadata(metadata)) {
        const dmMember = String(metadata.dm_member || '');
        selectedGroupSpeakerAvatar = dmMember;
        selectedGroupDmAvatar = dmMember;
        groupDmModeEnabled = true;
        groupDmModeForced = true;
        updateGroupSpeakerControls();
        return;
    }

    if (groupDmModeForced) {
        selectedGroupDmAvatar = '';
        groupDmModeEnabled = false;
        groupDmModeForced = false;
        updateGroupSpeakerControls();
    }
}

function getGroupDmExtra(fromAvatar, toAvatar) {
    return {
        is_group_dm: true,
        dm_from: fromAvatar || 'user',
        dm_to: toAvatar || 'user',
    };
}

function canGroupMemberSeeMessage(message, speakerAvatar) {
    if (!message?.extra?.is_group_dm) {
        return true;
    }

    if (isGroupDmChatMetadata()) {
        return isGroupDmParticipant(speakerAvatar);
    }

    const dmFrom = String(message.extra.dm_from || (message.is_user ? 'user' : message.original_avatar || ''));
    const dmTo = String(message.extra.dm_to || message.extra.dm_target || '');
    return dmFrom === speakerAvatar || dmTo === speakerAvatar;
}

function withGroupPrivateDmFilter(speakerAvatar, callback) {
    setGenerationChatFilter(message => canGroupMemberSeeMessage(message, speakerAvatar));
    try {
        return callback();
    } finally {
        setGenerationChatFilter(null);
    }
}

async function withGroupPrivateDmMemory(group, speakerAvatar, callback) {
    const dmMessages = isGroupDmChatMetadata() ? [] : await getGroupDmMemoryMessages(group, speakerAvatar);
    chat.splice(0, 0, ...dmMessages);

    try {
        return await withGroupPrivateDmFilter(speakerAvatar, callback);
    } finally {
        if (dmMessages.length) {
            const injected = new Set(dmMessages);
            for (let index = chat.length - 1; index >= 0; index--) {
                if (injected.has(chat[index])) {
                    chat.splice(index, 1);
                }
            }
        }
    }
}

async function getGroupDmMemoryMessages(group, speakerAvatar) {
    const avatar = String(speakerAvatar || '');
    if (!group || !avatar || !Array.isArray(group.chats)) {
        return [];
    }

    const messages = [];
    for (const chatId of group.chats) {
        const data = await loadGroupChat(chatId);
        const metadata = data?.[0]?.chat_metadata;
        if (!isGroupDmChatMetadata(metadata) || !isGroupDmParticipant(avatar, metadata)) {
            continue;
        }

        for (const message of data.slice(1)) {
            if (!message || message.is_system) {
                continue;
            }

            const clone = structuredClone(message);
            const isUserMessage = Boolean(clone.is_user);
            clone.extra = {
                ...(clone.extra || {}),
                is_group_dm: true,
                dm_from: clone.extra?.dm_from || (isUserMessage ? 'user' : avatar),
                dm_to: clone.extra?.dm_to || (isUserMessage ? avatar : 'user'),
            };
            clone.title = clone.title || 'Private DM';
            messages.push(clone);
        }
    }

    return messages;
}

function getSelectedGroupSpeakerChid(group) {
    if (!selectedGroupSpeakerAvatar) {
        return -1;
    }

    if (!getGroupEnabledMembers(group).includes(selectedGroupSpeakerAvatar)) {
        selectedGroupSpeakerAvatar = '';
        return -1;
    }

    return getCharacterIdByAvatar(selectedGroupSpeakerAvatar);
}

function getCurrentLocalTimeContext() {
    const now = new Date();
    return `${now.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'})`;
}

function buildContextAwareGroupPrompt(group, speakerName, options = {}) {
    const targetName = options.targetName || '';
    const reason = options.reason || '';
    const isDm = Boolean(options.isDm);
    const timeText = group?.time_aware ? ` Current local time: ${getCurrentLocalTimeContext()}.` : '';
    const targetText = targetName ? ` The immediate call or message is directed at ${speakerName} by ${targetName}; ${speakerName} should answer ${targetName}.` : '';
    const reasonText = reason ? ` Reason for this turn: ${reason}.` : '';
    const dmText = isDm ? ' This is a private DM; write it as a direct private message, not a public group reply.' : '';
    return `[Group context: write only as ${speakerName}. Pay attention to who addressed whom in the recent chat. If the user calls for ${speakerName}, answer the user. If another character calls for ${speakerName}, answer that character. Characters may also talk to each other naturally when the context calls for it.${targetText}${reasonText}${timeText}${dmText}]`;
}

function parseGroupSchedule(scheduleText) {
    return String(scheduleText || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const match = line.match(/^(\d{1,2}):(\d{2})\s+([^:–—-]+?)\s*[:–—-]\s*(.+)$/);
            if (!match) return null;
            const hour = Math.max(0, Math.min(23, Number(match[1])));
            const minute = Math.max(0, Math.min(59, Number(match[2])));
            return {
                time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
                minutes: hour * 60 + minute,
                name: match[3].trim(),
                reason: match[4].trim(),
            };
        })
        .filter(Boolean);
}

function getCurrentDayKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getCurrentMinutes(date = new Date()) {
    return date.getHours() * 60 + date.getMinutes();
}

function findScheduledCharacterId(group, scheduleItem) {
    const wanted = scheduleItem.name.toLowerCase();
    const avatar = getGroupDmAllowedMembers(group).find(member => {
        const character = characters.find(x => x.avatar === member);
        return character?.name?.toLowerCase() === wanted;
    });
    return avatar ? getCharacterIdByAvatar(avatar) : -1;
}

async function saveGroupRuntimeState(group) {
    if (group?.id) {
        await editGroup(group.id, false, false);
    }
}

function findDirectlyAddressedMember(group, text) {
    const lowerText = String(text || '').toLowerCase();
    if (!lowerText || !group) {
        return -1;
    }

    for (const avatar of getGroupDmAllowedMembers(group)) {
        const character = characters.find(x => x.avatar === avatar);
        if (!character?.name) continue;
        const escapedName = character.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const directMention = new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escapedName}([^\\p{L}\\p{N}_]|$)`, 'iu');
        if (directMention.test(lowerText)) {
            return getCharacterIdByAvatar(avatar);
        }
    }

    return -1;
}

function isAddressedToEntireGroup(text) {
    return /(^|[^\p{L}\p{N}_])(?:everyone|everybody|you\s+all|y['’]?all|all)([^\p{L}\p{N}_]|$)/iu.test(String(text || ''));
}


function getGroupAutoReplyDepth() {
    let depth = 0;
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (!message || message.is_user || message.is_system) {
            break;
        }

        depth++;
    }

    return depth;
}


function getMessageSpeakerName(message) {
    if (!message) return '';
    return message.is_user ? 'the user' : (message.name || 'another character');
}

function clearSelectedGroupSpeaker() {
    selectedGroupSpeakerAvatar = '';
    $('#group_speaker_controls .group_speaker_avatar').removeClass('selected');
}

function limitGroupSpeakersForControl(activatedMembers, forceSingleSpeaker) {
    if (!forceSingleSpeaker || activatedMembers.length <= 1) {
        return activatedMembers;
    }

    return activatedMembers.slice(0, 1);
}

function getGroupDmThreadStartIndex(participantAvatar) {
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (!message?.extra?.is_group_dm || message.extra?.type === 'group_dm_consolidation') {
            return index + 1;
        }

        if (!canGroupMemberSeeMessage(message, participantAvatar)) {
            return index + 1;
        }
    }

    return 0;
}

function getGroupDmThreadMessages(participantAvatar, startIndex = getGroupDmThreadStartIndex(participantAvatar)) {
    return chat.slice(startIndex).filter(message => message?.extra?.is_group_dm && message.extra?.type !== 'group_dm_consolidation' && canGroupMemberSeeMessage(message, participantAvatar) && String(message.mes ?? '').trim());
}

function removeGroupDmThreadMessages(participantAvatar, startIndex) {
    for (let index = chat.length - 1; index >= startIndex; index--) {
        const message = chat[index];
        if (message?.extra?.is_group_dm && canGroupMemberSeeMessage(message, participantAvatar)) {
            chat.splice(index, 1);
        }
    }
}

function getGroupDmChatName(group, character) {
    const safeGroupName = String(group?.name || 'Group').replace(/[/:*?"<>|]/g, '-');
    const safeCharacterName = String(character?.name || 'Character').replace(/[/:*?"<>|]/g, '-');
    return `DM - ${safeGroupName} - ${safeCharacterName}`;
}

async function returnToMainGroupChat() {
    const group = selected_group ? groups.find(x => x.id === selected_group) : null;
    const mainGroupChatId = String(chat_metadata.main_group_chat_id || '');

    if (!group) {
        return;
    }

    if (mainGroupChatId && group.chats.includes(mainGroupChatId)) {
        await openGroupChat(group.id, mainGroupChatId);
        return;
    }

    const fallbackChatId = group.chats.find(chatId => chatId !== group.chat_id && !String(chatId).startsWith('DM - '));
    if (fallbackChatId) {
        await openGroupChat(group.id, fallbackChatId);
        return;
    }

    await createNewGroupChat(group.id);
}

async function saveGroupChatData(chatId, data, force = true) {
    const saveChatRequest = await compressRequest({
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: chatId, chat: data, force }),
    });
    return fetch('/api/chats/group/save', saveChatRequest);
}

async function updateGroupDmReturnTarget(chatId, mainGroupChatId) {
    if (!chatId || !mainGroupChatId || chatId === mainGroupChatId) {
        return;
    }

    const data = await loadGroupChat(chatId);
    if (!Array.isArray(data) || !data.length || !Object.hasOwn(data[0], 'chat_metadata')) {
        return;
    }

    const header = { ...data[0], chat_metadata: { ...(data[0].chat_metadata || {}), main_group_chat_id: mainGroupChatId } };
    const response = await saveGroupChatData(chatId, [header, ...data.slice(1)], true);

    if (!response.ok) {
        console.warn('Could not update DM chat return target', chatId, response);
    }
}

async function ensureGroupDmChat(group, character, mainGroupChatId, initialMessages = []) {
    if (!group || !character) {
        return '';
    }

    const dmChatName = getGroupDmChatName(group, character);
    if (!group.chats.includes(dmChatName)) {
        const dmChatData = initialMessages.map(message => ({
            ...structuredClone(message),
            extra: { ...(message.extra || {}), is_group_dm: true },
        }));
        const saved = await saveGroupBookmarkChat(group.id, dmChatName, {
            type: 'group_dm_chat',
            dm_member: character.avatar,
            main_group_chat_id: mainGroupChatId || group.chat_id,
            tainted: true,
            dm_participants: [character.avatar],
        }, undefined, dmChatData, { throwOnError: false });

        if (!saved) {
            return '';
        }
    } else {
        await updateGroupDmReturnTarget(dmChatName, mainGroupChatId || group.chat_id);
    }

    return dmChatName;
}

async function appendMessageToGroupDmChat(group, character, message, mainGroupChatId) {
    const dmChatName = await ensureGroupDmChat(group, character, mainGroupChatId);
    if (!dmChatName) {
        return false;
    }

    const data = await loadGroupChat(dmChatName);
    if (!Array.isArray(data) || !data.length || !Object.hasOwn(data[0], 'chat_metadata')) {
        return false;
    }

    const dmMessage = {
        ...structuredClone(message),
        extra: { ...(message.extra || {}), ...getGroupDmExtra(character.avatar, 'user') },
        title: message.title || 'Private DM',
    };
    const response = await saveGroupChatData(dmChatName, [data[0], ...data.slice(1), dmMessage], true);
    return response.ok;
}

async function openGroupDmChatForAvatar(avatarId) {
    const group = selected_group ? groups.find(x => x.id === selected_group) : null;
    const targetAvatar = String(avatarId || '');
    if (!group || !targetAvatar) {
        toastr.warning(t`Pick a group member first.`);
        return false;
    }

    const character = characters.find(x => x.avatar === targetAvatar);
    if (!character) {
        return false;
    }

    const previousGroupChatId = isGroupDmChatMetadata() ? String(chat_metadata.main_group_chat_id || '') : group.chat_id;
    const startIndex = getGroupDmThreadStartIndex(targetAvatar);
    const dmMessages = group.chats.includes(getGroupDmChatName(group, character)) ? [] : getGroupDmThreadMessages(targetAvatar, startIndex);
    const dmChatName = await ensureGroupDmChat(group, character, previousGroupChatId, dmMessages);
    if (!dmChatName) {
        return false;
    }

    if (dmMessages.length) {
        removeGroupDmThreadMessages(targetAvatar, startIndex);
        await printMessages();
        await saveChatConditional();
    }

    setUnreadGroupDm(group.id, character.avatar, false);

    selectedGroupSpeakerAvatar = character.avatar;
    selectedGroupDmAvatar = character.avatar;
    groupDmModeEnabled = true;
    groupDmModeForced = true;
    updateGroupSpeakerControls();
    await openGroupChat(group.id, dmChatName);
    return true;
}

async function openSelectedGroupDmChat() {
    return openGroupDmChatForAvatar(selectedGroupSpeakerAvatar);
}

function setGroupTypingIndicator(characterName = '') {
    const nextTypingName = String(characterName || '');
    if (activeGroupTypingName === nextTypingName) {
        return;
    }

    activeGroupTypingName = nextTypingName;
    const indicator = $('#group_typing_indicator');
    if (!indicator.length) {
        return;
    }

    indicator.text(activeGroupTypingName ? `${activeGroupTypingName} is typing...` : '');
    indicator.toggleClass('displayNone', !activeGroupTypingName);
    $('#group_speaker_controls').toggleClass('is-typing', Boolean(activeGroupTypingName));
}

function updateGroupSpeakerControls() {
    const container = $('#group_speaker_controls');
    if (!container.length) {
        return;
    }

    const group = selected_group ? groups.find(x => x.id === selected_group) : null;
    const members = getGroupEnabledMembers(group);
    container.toggleClass('displayNone', !group || members.length === 0);
    if (!group || members.length === 0) {
        clearSelectedGroupSpeaker();
        setGroupTypingIndicator('');
        groupSpeakerAvatarRenderKey = '';
        return;
    }

    const unreadState = getGroupDmUnreadState();
    const avatarRenderKey = JSON.stringify({
        groupId: group.id,
        members,
        unread: members.map(avatarId => Boolean(unreadState[getGroupDmUnreadKey(group.id, avatarId)])),
    });
    if (avatarRenderKey !== groupSpeakerAvatarRenderKey) {
        groupSpeakerAvatarRenderKey = avatarRenderKey;
        const avatarList = container.find('.group_speaker_list').empty();
        for (const avatarId of members) {
            const character = characters.find(x => x.avatar === avatarId);
            if (!character) {
                continue;
            }

            const item = $('<button type="button" class="group_speaker_avatar"></button>');
            item.attr('title', `${character.name}: speak next / now`);
            item.attr('data-avatar', avatarId);
            const hasUnreadDm = Boolean(unreadState[getGroupDmUnreadKey(group.id, avatarId)]);
            item.toggleClass('selected', avatarId === selectedGroupSpeakerAvatar);
            item.toggleClass('has-unread-dm', hasUnreadDm);
            item.append($('<img alt="">').attr({
                src: getThumbnailUrl('avatar', avatarId),
                loading: 'lazy',
                decoding: 'async',
            }));
            item.append($('<span></span>').text(character.name));
            if (hasUnreadDm) {
                item.attr('title', `${character.name}: unread DM — tap to open`);
                item.append($('<i class="group-dm-unread-dot" aria-label="Unread DM"></i>'));
            }
            avatarList.append(item);
        }
    }

    container.find('.group_speaker_avatar').each(function () {
        const avatarId = String($(this).data('avatar') || '');
        $(this).toggleClass('selected', avatarId === selectedGroupSpeakerAvatar);
    });

    if (selectedGroupDmAvatar && !members.includes(selectedGroupDmAvatar)) {
        selectedGroupDmAvatar = '';
    }

    const autoDmEnabled = Boolean(getGlobalGroupDmSettings().autoDmEnabled);
    container.find('#group_speaker_auto_dm')
        .toggleClass('selected', autoDmEnabled)
        .attr('aria-pressed', String(autoDmEnabled));
    container.find('#group_speaker_dm_now').toggleClass('selected', groupDmModeEnabled);

    const dmChatButton = container.find('#group_speaker_dm_consolidate');
    const inDmChat = isGroupDmChatMetadata();
    dmChatButton.attr('title', inDmChat ? t`Return to the main group chat` : t`Open a separate private DM chat with the selected character`);
    dmChatButton.find('i').attr('class', inDmChat ? 'fa-solid fa-arrow-left' : 'fa-solid fa-envelope-open-text');
    dmChatButton.find('span').text(inDmChat ? t`Return to Group` : t`DM Chat`);
}

function initGroupSpeakerControls() {
    if (groupSpeakerControlsInitialized) {
        return;
    }

    groupSpeakerControlsInitialized = true;
    applyGlobalGroupDmSettings();
    const container = $('#group_speaker_controls');
    container.on('click', '.group_speaker_avatar', async function (event) {
        const avatarId = String($(this).data('avatar') || '');
        if (selected_group && hasUnreadGroupDm(selected_group, avatarId) && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            await openGroupDmChatForAvatar(avatarId);
            return;
        }

        if (groupDmModeForced && avatarId && !isGroupDmParticipant(avatarId) && !event.shiftKey) {
            selectedGroupSpeakerAvatar = avatarId;
            updateGroupSpeakerControls();
            return;
        }

        const alreadySelected = selectedGroupSpeakerAvatar === avatarId;
        selectedGroupSpeakerAvatar = groupDmModeForced && alreadySelected ? selectedGroupSpeakerAvatar : (alreadySelected ? '' : avatarId);
        if (groupDmModeForced && avatarId && !isGroupDmParticipant(avatarId)) {
            void inviteGroupDmParticipant(avatarId).then(invited => {
                if (invited) {
                    toastr.success(t`Added participant to this DM chat.`);
                }
                updateGroupSpeakerControls();
            });
        }
        updateGroupSpeakerControls();

        if (event.shiftKey && selected_group) {
            const chid = getCharacterIdByAvatar(avatarId);
            if (chid !== -1) {
                if (groupDmModeForced && !isGroupDmParticipant(avatarId)) {
                    void inviteGroupDmParticipant(avatarId).then(() => Generate('normal', { force_chid: chid }));
                } else {
                    Generate('normal', { force_chid: chid });
                }
            }
        }
    });

    container.on('click', '#group_speaker_now', async function () {
        if (!selected_group || !selectedGroupSpeakerAvatar) {
            toastr.warning(t`Pick a group member first.`);
            return;
        }

        if (groupDmModeForced && selectedGroupSpeakerAvatar && !isGroupDmParticipant(selectedGroupSpeakerAvatar)) {
            await inviteGroupDmParticipant(selectedGroupSpeakerAvatar);
        }

        const chid = getCharacterIdByAvatar(selectedGroupSpeakerAvatar);
        if (chid !== -1) {
            Generate('normal', { force_chid: chid });
        }
    });

    container.on('click', '#group_speaker_dm_consolidate', async function () {
        if (isGroupDmChatMetadata()) {
            await returnToMainGroupChat();
            return;
        }

        await openSelectedGroupDmChat();
    });

    container.on('click', '#group_speaker_dm_now', function () {
        const group = selected_group ? groups.find(x => x.id === selected_group) : null;
        if (!group) {
            return;
        }

        if (groupDmModeForced) {
            groupDmModeEnabled = true;
            selectedGroupDmAvatar = selectedGroupSpeakerAvatar || selectedGroupDmAvatar;
            updateGroupSpeakerControls();
            toastr.info(t`DM is locked on for this DM chat.`);
            return;
        }

        if (!groupDmModeEnabled && !selectedGroupSpeakerAvatar) {
            toastr.warning(t`Pick a group member first.`);
            return;
        }

        groupDmModeEnabled = !groupDmModeEnabled;
        selectedGroupDmAvatar = groupDmModeEnabled ? selectedGroupSpeakerAvatar : '';
        updateGroupSpeakerControls();
    });

    container.on('click', '#group_speaker_auto_dm', async function () {
        const group = selected_group ? groups.find(x => x.id === selected_group) : null;
        if (!group) {
            return;
        }

        const enabled = !getGlobalGroupDmSettings().autoDmEnabled;
        saveGlobalGroupDmSettings({ autoDmEnabled: enabled, autoDmMember: '' });
        updateGroupSpeakerControls();
    });
}

export const group_activation_strategy = {
    NATURAL: 0,
    LIST: 1,
    MANUAL: 2,
    POOLED: 3,
};

export const group_generation_mode = {
    SWAP: 0,
    APPEND: 1,
    APPEND_DISABLED: 2,
};

export const DEFAULT_AUTO_MODE_DELAY = 120;
export const DEFAULT_AUTO_DM_COOLDOWN = 300;

export const groupCandidatesFilter = new FilterHelper(debounce(printGroupCandidates, debounce_timeout.quick));
export const groupMembersFilter = new FilterHelper(debounce(printGroupMembers, debounce_timeout.quick));
let autoModeWorker = null;
const saveGroupDebounced = debounce(async (group, reload) => await _save(group, reload), debounce_timeout.relaxed);
/** @type {Map<string, number>} */
let groupChatQueueOrder = new Map();

function setAutoModeWorker() {
    clearInterval(autoModeWorker);
    clearInterval(groupScheduleCheckInterval);
    const autoModeDelay = groups.find(x => x.id === selected_group)?.auto_mode_delay ?? DEFAULT_AUTO_MODE_DELAY;
    autoModeWorker = setInterval(groupChatAutoModeWorker, autoModeDelay * 1000);
    groupScheduleCheckInterval = setInterval(groupScheduleAutoMessageWorker, 60 * 1000);
}

function syncGroupAutoModeToggle() {
    applyGlobalGroupAutoModeSettings();
    $('#rm_group_automode').prop('checked', is_group_automode_enabled);
    setAutoModeWorker();
}

function hasUserDraftInChatBox() {
    return String($('#send_textarea').val() || '').trim().length > 0;
}

function shouldGroupDmWaitForUserTurn() {
    if (!isGroupDmChatMetadata()) {
        return false;
    }

    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (!message || message.is_system) {
            continue;
        }

        return !message.is_user;
    }

    return true;
}

/**
 * Saves a group to the server.
 * @param {Group} group Group object to save
 * @param {boolean} reload Whether to reload characters after saving
 */
async function _save(group, reload = true) {
    await fetch('/api/groups/edit', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(group),
    });
    if (reload) {
        await getCharacters();
    }
}

// Group chats
async function regenerateGroup() {
    let generationId = getLastMessageGenerationId();

    while (chat.length > 0) {
        const lastMes = chat[chat.length - 1];
        const this_generationId = lastMes.extra?.gen_id;

        // for new generations after the update
        if ((generationId && this_generationId) && generationId !== this_generationId) {
            break;
        } else if (lastMes.is_user || lastMes.is_system) {
            // legacy for generations before the update
            break;
        }

        await deleteLastMessage();
    }

    const abortController = new AbortController();
    setExternalAbortController(abortController);
    return generateGroupWrapper(false, 'normal', { signal: abortController.signal });
}

/**
 * Loads group chat messages from the server.
 * @param {string} chatId Chat ID
 * @returns {Promise<ChatFile>} Array of chat messages
 */
async function loadGroupChat(chatId) {
    const response = await fetch('/api/chats/group/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: chatId }),
    });

    if (response.ok) {
        const data = await response.json();
        if (!Array.isArray(data)) {
            return [];
        }
        return data;
    }

    return [];
}

/**
 * Checks whether a group chat file currently exists on the server.
 * @param {string} chatId Chat ID
 * @returns {Promise<'present'|'missing'|'unknown'>} Current availability state
 */
async function groupChatExists(chatId) {
    if (!chatId) {
        return 'missing';
    }

    try {
        const response = await fetch('/api/chats/group/info', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ id: chatId }),
        });

        if (response.ok) {
            return 'present';
        }

        return response.status === 404 ? 'missing' : 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * Validates a group by checking if all members exist and removing duplicates.
 * @param {Group} group Group to validate
 * @returns {Promise<void>}
 */
async function validateGroup(group) {
    if (!group) return;

    // Validate that all members exist as characters
    let dirty = false;
    group.members = group.members.filter(member => {
        const character = characters.find(x => x.avatar === member || x.name === member);
        if (!character) {
            const msg = t`Warning: Listed member ${member} does not exist as a character. It will be removed from the group.`;
            toastr.warning(msg, t`Group Validation`);
            console.warn(msg);
            dirty = true;
        }
        return character;
    });

    if (typeof group.chat_id === 'number') {
        group.chat_id = String(group.chat_id);
        dirty = true;
    }

    // Remove duplicate chat ids and normalize IDs to strings
    if (Array.isArray(group.chats)) {
        const lengthBefore = group.chats.length;
        group.chats = group.chats.map(chatId => String(chatId)).filter(onlyUnique);
        const lengthAfter = group.chats.length;
        if (lengthBefore !== lengthAfter) {
            dirty = true;
        }
    }

    // Recover from stale chat IDs that no longer have a JSONL on disk.
    if (Array.isArray(group.chats) && group.chats.length) {
        const presentChats = [];
        const retainedChats = [];
        const results = await Promise.allSettled(group.chats.map(chatId => groupChatExists(chatId)));

        for (let i = 0; i < results.length; i++) {
            const chatId = group.chats[i];
            const availability = results[i].status === 'fulfilled' ? results[i].value : 'unknown';
            const isActiveChat = chatId === String(group.chat_id ?? '');

            if (availability === 'present') {
                presentChats.push(chatId);
                retainedChats.push(chatId);
                continue;
            }

            if (availability !== 'missing' || isActiveChat) {
                retainedChats.push(chatId);
            }
        }

        if (retainedChats.length !== group.chats.length) {
            group.chats = retainedChats;
            dirty = true;
        }

        if (presentChats.length && !presentChats.includes(String(group.chat_id ?? ''))) {
            group.chat_id = presentChats[presentChats.length - 1];
            dirty = true;
        }
    }

    if (!Array.isArray(group.chats)) {
        group.chats = [];
        dirty = true;
    }

    if (dirty) {
        await editGroup(group.id, true, false);
    }
}

/**
 * Loads the chat messages for a specific group.
 * @param {string} groupId - The ID of the group to load chat messages for.
 * @param {boolean} reload - Whether to reload the group chat after loading.
 * @param {object} options - Load options.
 * @param {boolean} [options.switchMenu=true] Whether to switch the right menu to the group editor.
 * @returns {Promise<void>} A promise that resolves when the chat messages have been loaded.
 */
export async function getGroupChat(groupId, reload = false, { switchMenu = true } = {}) {
    incrementChatGeneration();

    const group = groups.find((x) => x.id === groupId);
    if (!group) {
        console.warn('Group not found', groupId);
        return;
    }

    // Run validation before any loading
    await validateGroup(group);
    await unshallowGroupMembers(groupId);

    let createdChat = false;

    if (!group.chat_id) {
        const freshChatId = humanizedDateTime();
        group.chat_id = freshChatId;
        group.chats = Array.isArray(group.chats) ? group.chats : [];
        group.chats.push(freshChatId);
        await editGroup(group.id, true, false);
        createdChat = true;
    }

    const chat_id = group.chat_id;
    const data = await loadGroupChat(chat_id);
    const metadata = data?.[0]?.chat_metadata ?? {};
    const freshChat = createdChat && !metadata.tainted && (!Array.isArray(data) || !data.length);

    // Remove chat file header if present
    if (Array.isArray(data) && data.length && Object.hasOwn(data[0], 'chat_metadata')) {
        data.shift();
    }

    // Add integrity slug if missing
    if (!metadata.integrity) {
        metadata.integrity = uuidv4();
    }

    await loadItemizedPrompts(getCurrentChatId());

    if (group && Array.isArray(group.members) && freshChat) {
        chat.splice(0, chat.length);
        chatElement.find('.mes').remove();
        metadata.tainted = true;
        updateChatMetadata(metadata, true);
        await saveGroupChat(groupId, false);
    } else if (Array.isArray(data) && data.length) {
        chat.splice(0, chat.length, ...data);
        chat.forEach(ensureMessageMediaIsArray);
        chatElement.find('.mes').remove();
        await printMessages();
    }

    updateChatMetadata(metadata, true);
    applyGroupDmChatMode(metadata);

    if (reload && switchMenu) {
        select_group_chats(groupId, true);
    }

    await eventSource.emit(event_types.CHAT_CHANGED, getCurrentChatId());
    if (freshChat) await eventSource.emit(event_types.GROUP_CHAT_CREATED);
}

/**
 * Retrieves the members of a group
 *
 * @param {string} [groupId=selected_group] - The ID of the group to retrieve members from. Defaults to the currently selected group.
 * @returns {Character[]} An array of character objects representing the members of the group. If the group is not found, an empty array is returned.
 */
export function getGroupMembers(groupId = selected_group) {
    const group = groups.find((x) => x.id === groupId);
    return group?.members.map(member => characters.find(x => x.avatar === member)) ?? [];
}

/**
 * Retrieves the member names of a group. If the group is not selected, an empty array is returned.
 * @returns {string[]} An array of character names representing the members of the group.
 */
export function getGroupNames() {
    if (!selected_group) {
        return [];
    }
    const groupMembers = groups.find(x => x.id == selected_group)?.members;
    return Array.isArray(groupMembers)
        ? groupMembers.map(x => characters.find(y => y.avatar === x)?.name).filter(x => x)
        : [];
}

/**
 * Finds the character ID for a group member.
 * @param {number|string} arg 0-based member index or character name
 * @param {Boolean} full Whether to return a key-value object containing extra data
 * @returns {number|Object} 0-based character ID or key-value object if full is true
 */
export function findGroupMemberId(arg, full = false) {
    arg = arg?.toString()?.trim();

    if (!arg) {
        console.warn('WARN: No argument provided for findGroupMemberId');
        return;
    }

    const group = groups.find(x => x.id == selected_group);

    if (!group || !Array.isArray(group.members)) {
        console.warn('WARN: No group found for selected group ID');
        return;
    }

    const index = parseInt(arg);
    const searchByString = isNaN(index);

    if (searchByString) {
        const memberNames = group.members.map(x => ({
            avatar: x,
            name: characters.find(y => y.avatar === x)?.name,
            index: characters.findIndex(y => y.avatar === x),
        }));
        const fuse = new Fuse(memberNames, { keys: ['avatar', 'name'] });
        const result = fuse.search(arg);

        if (!result.length) {
            console.warn(`WARN: No group member found using string ${arg}`);
            return;
        }

        const chid = result[0].item.index;

        if (chid === -1) {
            console.warn(`WARN: No character found for group member ${arg}`);
            return;
        }

        console.log(`Targeting group member ${chid} (${arg}) from search result`, result[0]);

        return !full ? chid : { ...{ id: chid }, ...result[0].item };
    } else {
        const memberAvatar = group.members[index];

        if (memberAvatar === undefined) {
            console.warn(`WARN: No group member found at index ${index}`);
            return;
        }

        const chid = characters.findIndex(x => x.avatar === memberAvatar);

        if (chid === -1) {
            console.warn(`WARN: No character found for group member ${memberAvatar} at index ${index}`);
            return;
        }

        console.log(`Targeting group member ${memberAvatar} at index ${index}`);

        return !full ? chid : {
            id: chid,
            avatar: memberAvatar,
            name: characters.find(y => y.avatar === memberAvatar)?.name,
            index: index,
        };
    }
}

/**
 * Gets depth prompts for group members.
 * @param {string} groupId Group ID
 * @param {number} characterId Current Character ID
 * @returns {{depth: number, text: string, role: string}[]} Array of depth prompts
 */
export function getGroupDepthPrompts(groupId, characterId) {
    if (!groupId) {
        return [];
    }

    console.debug('getGroupDepthPrompts entered for group: ', groupId);
    const group = groups.find(x => x.id === groupId);

    if (!group || !Array.isArray(group.members) || !group.members.length) {
        return [];
    }

    if (group.generation_mode === group_generation_mode.SWAP) {
        return [];
    }

    const depthPrompts = [];

    for (const member of group.members) {
        const index = characters.findIndex(x => x.avatar === member);
        const character = characters[index];

        if (index === -1 || !character) {
            console.debug(`Skipping missing member: ${member}`);
            continue;
        }

        if (group.disabled_members.includes(member) && characterId !== index) {
            console.debug(`Skipping disabled group member: ${member}`);
            continue;
        }

        const depthPromptText = baseChatReplace(character.data?.extensions?.depth_prompt?.prompt?.trim(), null, character.name) || '';
        const depthPromptDepth = character.data?.extensions?.depth_prompt?.depth ?? depth_prompt_depth_default;
        const depthPromptRole = character.data?.extensions?.depth_prompt?.role ?? depth_prompt_role_default;

        if (depthPromptText) {
            depthPrompts.push({ text: depthPromptText, depth: depthPromptDepth, role: depthPromptRole });
        }
    }

    return depthPrompts;
}

/**
 * Combines group members cards into a single string. Only for groups with generation mode set to APPEND or APPEND_DISABLED.
 * @param {string} groupId Group ID
 * @param {number} characterId Current Character ID
 * @returns {{description: string, personality: string, scenario: string, mesExamples: string}} Group character cards combined
 */
export function getGroupCharacterCards(groupId, characterId) {
    const lazy = getGroupCharacterCardsLazy(groupId, characterId);
    if (!lazy) return null;

    // Resolve all lazy fields into a plain object
    return {
        description: lazy.description,
        personality: lazy.personality,
        scenario: lazy.scenario,
        mesExamples: lazy.mesExamples,
    };
}

/**
 * Returns group character cards with lazy evaluation.
 * Each field is only processed when first accessed.
 * @param {string} groupId Group ID
 * @param {number} characterId Current Character ID
 * @returns {{description: string, personality: string, scenario: string, mesExamples: string}} Group character cards with lazy getters
 */
export function getGroupCharacterCardsLazy(groupId, characterId) {
    const group = groups.find(x => x.id === groupId);

    // If no group cards should be generated, return null so caller knows to fall back
    if (!group || !group?.generation_mode || !Array.isArray(group.members) || !group.members.length) {
        return null;
    }

    /**
     * Runs baseChatReplace on a text, with custom <FIELDNAME> replace
     * @param {string} value Value to replace
     * @param {string} fieldName Name of the field
     * @param {string} characterName Name of the character
     * @param {boolean} trim Whether to trim the value
     * @returns {string} Replaced text
     */
    function customTransform(value, fieldName, characterName, trim) {
        if (!value) return '';
        value = value.replace(/<FIELDNAME>/gi, fieldName);
        value = trim ? value.trim() : value;
        return baseChatReplace(value, null, characterName);
    }

    /**
     * Prepares text with prefix/suffix for a character field
     * @param {string} value Value to replace
     * @param {string} characterName Name of the character
     * @param {string} fieldName Name of the field
     * @param {function(string): string} [preprocess] Preprocess function
     * @returns {string} Prepared text
     */
    function replaceAndPrepareForJoin(value, characterName, fieldName, preprocess = null) {
        value = value?.trim() ?? '';
        if (!value) return '';
        if (typeof preprocess === 'function') {
            value = preprocess(value);
        }
        const prefix = customTransform(group.generation_mode_join_prefix, fieldName, characterName, false);
        const suffix = customTransform(group.generation_mode_join_suffix, fieldName, characterName, false);
        value = customTransform(value, fieldName, characterName, true);
        return `${prefix}${value}${suffix}`;
    }

    /**
     * Collects and joins field values from all group members
     * @param {string} fieldName Display name of the field
     * @param {function(Character): string} getter Function to get field value from character
     * @param {function(string): string} [preprocess] Optional preprocess function
     * @returns {string} Combined field values
     */
    function collectField(fieldName, getter, preprocess = null) {
        const values = [];
        for (const member of group.members) {
            const index = characters.findIndex(x => x.avatar === member);
            const character = characters[index];
            if (index === -1 || !character) continue;
            if (group.disabled_members.includes(member) && characterId !== index && group.generation_mode !== group_generation_mode.APPEND_DISABLED) {
                continue;
            }
            values.push(replaceAndPrepareForJoin(getter(character), character.name, fieldName, preprocess));
        }
        return values.filter(x => x.length).join('\n');
    }

    const scenarioOverride = String(chat_metadata.scenario || '');
    const mesExamplesOverride = String(chat_metadata.mes_example || '');

    return createLazyFields({
        description: () => collectField('Description', c => c.description),
        personality: () => collectField('Personality', c => c.personality),
        scenario: () => baseChatReplace(scenarioOverride?.trim()) || collectField('Scenario', c => c.scenario),
        mesExamples: () => baseChatReplace(mesExamplesOverride?.trim()) ||
            collectField('Example Messages', c => c.mes_example, x => !x.startsWith('<START>') ? `<START>\n${x}` : x),
    });
}

function resetSelectedGroup() {
    selected_group = null;
    is_group_generating = false;
}

/**
 * Saves a group chat to the server.
 * @param {string} groupId Group ID
 * @param {boolean} shouldSaveGroup Whether to save the group after saving the chat
 * @param {boolean} force Force the saving on integrity error
 * @param {boolean} throwOnError Rethrow save errors after notifying the user
 * @returns {Promise<boolean>} A promise that resolves when the group chat has been saved.
 */
function saveGroupChat(groupId, shouldSaveGroup, force = false, throwOnError = false) {
    const group = groups.find(x => x.id == groupId);
    if (!group) {
        console.warn('Group not found', groupId);
        return Promise.resolve(false);
    }

    const chatSnapshot = chat.slice();
    const metadataSnapshot = { ...chat_metadata };
    const chatIdSnapshot = group.chat_id;
    const saveTask = groupChatSaveQueue
        .catch(error => console.warn('Previous group chat save failed before queued save.', error))
        .then(() => saveGroupChatImmediately({
            groupId,
            shouldSaveGroup,
            force,
            throwOnError,
            chatId: chatIdSnapshot,
            chatData: chatSnapshot,
            metadata: metadataSnapshot,
        }));

    groupChatSaveQueue = saveTask.catch(() => {});
    return saveTask;
}

async function saveGroupChatImmediately({ groupId, shouldSaveGroup, force = false, throwOnError = false, chatId, chatData, metadata }) {
    const group = groups.find(x => x.id == groupId);
    if (!group) {
        console.warn('Group not found', groupId);
        return false;
    }

    if (chatId && Array.isArray(group.chats) && !group.chats.includes(chatId)) {
        group.chats.push(chatId);
        shouldSaveGroup = true;
    }
    group.date_last_chat = Date.now();
    /** @type {ChatHeader} */
    const chatHeader = {
        chat_metadata: metadata,
        user_name: 'unused',
        character_name: 'unused',
    };
    const chatMessages = Array.isArray(chatData) ? chatData : chat;
    const saveGroupChatRequest = await compressRequest({
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: chatId, chat: [chatHeader, ...chatMessages], force: force }),
    });
    const response = await fetch('/api/chats/group/save', saveGroupChatRequest);

    if (!response.ok) {
        const errorData = await response.json();
        const isIntegrityError = errorData?.error === 'integrity' && !force;
        if (!isIntegrityError) {
            toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Group Chat could not be saved`);
            console.error('Group chat could not be saved', response);
            if (throwOnError) {
                throw new Error('Group chat could not be saved');
            }
            return false;
        }

        const popupResult = await Popup.show.input(
            t`ERROR: Chat integrity check failed while saving the file.`,
            t`<p>After you click OK, the page will be reloaded to prevent data corruption.</p>
              <p>To confirm an overwrite (and potentially <b>LOSE YOUR DATA</b>), enter <code>OVERWRITE</code> (in all caps) in the box below before clicking OK.</p>`,
            '',
            { okButton: 'OK', cancelButton: false },
        );

        const forceSaveConfirmed = popupResult === 'OVERWRITE';

        if (!forceSaveConfirmed) {
            console.warn('Chat integrity check failed, and user did not confirm the overwrite. Reloading the page.');
            window.location.reload();
            return false;
        }

        return await saveGroupChatImmediately({ groupId, shouldSaveGroup, force: true, throwOnError, chatId, chatData: chatMessages, metadata });
    }

    const responseData = await response.json().catch(() => ({}));
    const isActiveGroupChatSave = selected_group === groupId && group.chat_id === chatId;
    if (isActiveGroupChatSave && typeof responseData?.integrity === 'string' && responseData.integrity) {
        chat_metadata.integrity = responseData.integrity;
    }

    if (shouldSaveGroup) {
        await editGroup(groupId, false, false);
    }

    return true;
}

/**
 * Renames a group member across all groups and their chats.
 * @param {string} oldAvatar Old avatar name
 * @param {string} newAvatar New avatar name
 * @param {string} newName New character name
 */
export async function renameGroupMember(oldAvatar, newAvatar, newName) {
    // Scan every group for our renamed character
    for (const group of groups) {
        try {
            // Try finding the member by old avatar link
            const memberIndex = group.members.findIndex(x => x == oldAvatar);

            // Character was not present in the group...
            if (memberIndex == -1) {
                continue;
            }

            // Replace group member avatar id and save the changes
            group.members[memberIndex] = newAvatar;
            await editGroup(group.id, true, false);
            console.log(`Renamed character ${newName} in group: ${group.name}`);

            // Load all chats from this group
            for (const chatId of group.chats) {
                const messages = await loadGroupChat(chatId);

                // Only save the chat if there were any changes to the chat content
                let hadChanges = false;
                // Chat shouldn't be empty
                if (Array.isArray(messages) && messages.length) {
                    // Iterate over every chat message
                    for (const message of messages) {
                        // Skip the chat header
                        if (Object.hasOwn(message, 'chat_metadata')) {
                            continue;
                        }

                        // Only look at character messages
                        if (message.is_user || message.is_system) {
                            continue;
                        }

                        // Message belonged to the old-named character:
                        // Update name, avatar thumbnail URL and original avatar link
                        if (message.force_avatar && message.force_avatar.indexOf(encodeURIComponent(oldAvatar)) !== -1) {
                            message.name = newName;
                            message.force_avatar = message.force_avatar.replace(encodeURIComponent(oldAvatar), encodeURIComponent(newAvatar));
                            message.original_avatar = newAvatar;
                            hadChanges = true;
                        }
                    }

                    if (hadChanges) {
                        await eventSource.emit(event_types.CHARACTER_RENAMED_IN_PAST_CHAT, messages, oldAvatar, newAvatar);

                        const saveChatRequest = await compressRequest({
                            method: 'POST',
                            headers: getRequestHeaders(),
                            body: JSON.stringify({ id: chatId, chat: [...messages] }),
                        });
                        const saveChatResponse = await fetch('/api/chats/group/save', saveChatRequest);

                        if (!saveChatResponse.ok) {
                            throw new Error('Group member could not be renamed');
                        }

                        console.log(`Renamed character ${newName} in group chat: ${chatId}`);
                    }
                }
            }
        } catch (error) {
            console.log(`An error during renaming the character ${newName} in group: ${group.name}`);
            console.error(error);
        }
    }
}

/**
 * Fetches all groups from the server and processes them.
 */
async function getGroups() {
    const response = await fetch('/api/groups/all', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
    });

    if (response.ok) {
        /** @type {Group[]} */
        const data = await response.json();
        groups = data.slice();

        // Convert groups to new format
        for (const group of groups) {
            if (typeof group.id === 'number') {
                group.id = String(group.id);
            }
            if (group.disabled_members == undefined) {
                group.disabled_members = [];
            }
            group.time_aware = Boolean(group.time_aware);
            group.auto_message_enabled = Boolean(group.auto_message_enabled);
            group.auto_dm_cooldown = Number(group.auto_dm_cooldown) || DEFAULT_AUTO_DM_COOLDOWN;
            group.ai_schedule = String(group.ai_schedule || '');
            group.auto_schedule_state = group.auto_schedule_state && typeof group.auto_schedule_state === 'object' ? group.auto_schedule_state : {};
            if (group.chat_id == undefined) {
                group.chat_id = group.id;
                group.chats = [group.id];
                group.members = group.members
                    .map(x => characters.find(y => y.name == x)?.avatar)
                    .filter(x => x)
                    .filter(onlyUnique);
            }
            if (typeof group.chat_id === 'number') {
                group.chat_id = String(group.chat_id);
            }
            if (Array.isArray(group.chats) && group.chats.some(x => typeof x === 'number')) {
                group.chats = group.chats.map(x => String(x));
            }
        }
    }
}

/**
 * Gets a group UI block for the list.
 * @param {Group} group Group object
 * @returns {JQuery<HTMLElement>} jQuery element representing the group block
 */
export function getGroupBlock(group) {
    let count = 0;
    let namesList = [];

    // Build inline name list
    if (Array.isArray(group.members) && group.members.length) {
        for (const member of group.members) {
            const character = characters.find(x => x.avatar === member || x.name === member);
            if (character) {
                namesList.push(character.name);
                count++;
            }
        }
    }

    const template = $('#group_list_template .group_select').clone();
    template.data('id', group.id);
    template.attr('data-grid', group.id);
    template.find('.ch_name').text(group.name).attr('title', `[Group] ${group.name}`);
    template.find('.group_fav_icon').css('display', 'none');
    template.addClass(group.fav ? 'is_fav' : '');
    template.toggleClass('is-active-entity', selected_group === group.id);
    template.find('.ch_fav').val(String(group.fav));
    template.find('.group_select_counter').text(count + ' ' + (count != 1 ? t`characters` : t`character`));
    template.find('.group_select_block_list').text(namesList.join(', '));

    // Display inline tags
    const tagsElement = template.find('.tags');
    printTagList(tagsElement, { forEntityOrKey: group.id, tagOptions: { isCharacterList: true } });

    const avatar = getGroupAvatar(group);
    if (avatar) {
        $(template).find('.avatar').replaceWith(avatar);
    }

    return template;
}

/**
 * Updates the avatar display for a given group.
 * @param {Group} group Group object
 */
function updateGroupAvatar(group) {
    $('#group_avatar_preview').empty().append(getGroupAvatar(group));

    $('.group_select').each(function () {
        if ($(this).data('id') == group.id) {
            $(this).find('.avatar').replaceWith(getGroupAvatar(group));
        }
    });

    favsToHotswap();
}

/**
 * Checks if a URL is a valid image URL.
 * @param {string} url URL to check
 * @returns {boolean} True if valid, false otherwise
 */
function isValidImageUrl(url) {
    // check if empty dict
    if (!url || Object.keys(url).length === 0) {
        return false;
    }
    return isDataURL(url) || (url && (url.startsWith('user') || url.startsWith('/user')));
}

/**
 * Gets a group avatar element.
 * @param {Group} group Group object
 * @returns {JQuery<HTMLElement>} Group avatar element
 */
function getGroupAvatar(group) {
    if (!group) {
        return $(`<div class="avatar"><img src="${default_avatar}"></div>`);
    }
    // if isDataURL or if it's a valid local file url
    if (isValidImageUrl(group.avatar_url)) {
        return $(`<div class="avatar" title="[Group] ${group.name}"><img src="${group.avatar_url}"></div>`);
    }

    const memberAvatars = [];
    if (group && Array.isArray(group.members) && group.members.length) {
        for (const member of group.members) {
            const charIndex = characters.findIndex(x => x.avatar === member);
            if (charIndex !== -1 && characters[charIndex].avatar !== 'none') {
                const avatar = getThumbnailUrl('avatar', characters[charIndex].avatar);
                memberAvatars.push(avatar);
            }
            if (memberAvatars.length === 4) {
                break;
            }
        }
    }

    const avatarCount = memberAvatars.length;

    if (avatarCount >= 1 && avatarCount <= 4) {
        const groupAvatar = $(`#group_avatars_template .collage_${avatarCount}`).clone();

        for (let i = 0; i < avatarCount; i++) {
            groupAvatar.find(`.img_${i + 1}`).attr({
                src: memberAvatars[i],
                loading: 'lazy',
                decoding: 'async',
            });
        }

        groupAvatar.attr('title', `[Group] ${group.name}`);
        return groupAvatar;
    }

    // catch edge case where group had one member and that member is deleted
    if (avatarCount === 0) {
        return $('<div class="missing-avatar fa-solid fa-user-slash"></div>');
    }

    // default avatar
    const groupAvatar = $('#group_avatars_template .collage_1').clone();
    groupAvatar.find('.img_1').attr({
        src: group.avatar_url || system_avatar,
        loading: 'lazy',
        decoding: 'async',
    });
    groupAvatar.attr('title', `[Group] ${group.name}`);
    return groupAvatar;
}

/**
 * Gets chat IDs for a group.
 * @param {string} groupId Group ID
 * @returns {string[]} Array of chat IDs
 */
function getGroupChatNames(groupId) {
    const group = groups.find(x => x.id === groupId);

    if (!group) {
        return [];
    }

    const names = [];
    for (const chatId of group.chats) {
        names.push(chatId);
    }
    return names;
}

/**
 * Generates text for the group chat by queueing members according to the activation strategy.
 * @param {boolean} byAutoMode If the generation was triggered by the auto mode.
 * @param {string?} type Generation type
 * @param {object} params Additional Generate parameters
 * @returns {Promise<string|void>} Generated text or nothing if no generation occurred
 */
async function generateGroupWrapper(byAutoMode, type = null, params = {}) {
    function throwIfAborted() {
        if (params.signal instanceof AbortSignal && params.signal.aborted) {
            throw new Error('AbortSignal was fired. Group generation stopped');
        }
    }

    if (online_status === 'no_connection') {
        is_group_generating = false;
        setSendButtonState(false);
        return Promise.resolve();
    }

    if (is_group_generating) {
        return Promise.resolve();
    }

    // Auto-navigate back to group menu
    if (menu_type !== 'group_edit') {
        select_group_chats(selected_group, false);
        await delay(1);
    }

    /** @type {any} Caution: JS war crimes ahead */
    let textResult = '';
    const group = groups.find((x) => x.id === selected_group);

    if (!group || !Array.isArray(group.members) || !group.members.length) {
        sendSystemMessage(system_message_types.EMPTY, '', { isSmallSys: true });
        return Promise.resolve();
    }

    try {
        throwIfAborted();
        hideSwipeButtons();
        is_group_generating = true;
        setSendButtonState(true);
        setCharacterName('');
        setCharacterId(undefined);
        const userInput = String($('#send_textarea').val());
        const manualDmTarget = groupDmModeEnabled ? selectedGroupSpeakerAvatar : '';
        const isToggledDm = !byAutoMode && [null, undefined, 'normal'].includes(type) && Boolean(manualDmTarget);
        if (isToggledDm) {
            type = 'dm';
            params = { ...(params || {}), force_chid: getCharacterIdByAvatar(manualDmTarget) };
            pendingGroupDmUserTarget = manualDmTarget;
            setPendingUserMessageExtra(getGroupDmExtra('user', manualDmTarget));
        } else {
            pendingGroupDmUserTarget = '';
        }

        // id of this specific batch for regeneration purposes
        group_generation_id = Date.now();
        const lastMessage = chat[chat.length - 1];
        let activationText = '';
        let isUserInput = false;

        if (userInput?.length && !byAutoMode) {
            isUserInput = true;
            activationText = userInput;
        } else {
            if (lastMessage && !lastMessage.is_system) {
                activationText = lastMessage.mes;
            }
        }

        const activationStrategy = Number(group.activation_strategy ?? group_activation_strategy.NATURAL);
        const enabledMembers = getGroupDmAllowedMembers(group);
        let activatedMembers = [];

        const selectedSpeakerChid = getSelectedGroupSpeakerChid(group);
        const addressedMemberChid = findDirectlyAddressedMember(group, activationText);
        const isWholeGroupAddress = isAddressedToEntireGroup(activationText);
        const autoReplyDepth = byAutoMode && !isUserInput ? getGroupAutoReplyDepth() : 0;
        if (params && Array.isArray(params.force_chids)) {
            activatedMembers = params.force_chids;
        } else if (params && typeof params.force_chid == 'number') {
            activatedMembers = [params.force_chid];
        } else if (type !== 'quiet' && isWholeGroupAddress && isUserInput) {
            activatedMembers = enabledMembers.map(avatar => getCharacterIdByAvatar(avatar)).filter(chid => chid !== -1);
        } else if (byAutoMode && type !== 'quiet' && addressedMemberChid !== -1 && autoReplyDepth < 3) {
            activatedMembers = [addressedMemberChid];
        } else if (byAutoMode && type !== 'quiet' && autoReplyDepth >= 3) {
            activatedMembers = [];
        } else if (!byAutoMode && type !== 'quiet' && addressedMemberChid !== -1) {
            activatedMembers = [addressedMemberChid];
        } else if (!byAutoMode && type !== 'quiet' && selectedSpeakerChid !== -1) {
            activatedMembers = [selectedSpeakerChid];
        } else if (type === 'quiet') {
            activatedMembers = activateSwipe(enabledMembers, { allowSystem: true }).slice(0, 1);

            if (activatedMembers.length === 0) {
                activatedMembers = activateListOrder(enabledMembers.slice(0, 1));
            }
        } else if (type === 'swipe' || type === 'continue') {
            activatedMembers = activateSwipe(enabledMembers, { allowSystem: false });

            if (activatedMembers.length === 0) {
                toastr.warning(t`Deleted group member swiped. To get a reply, add them back to the group.`);
                throw new Error('Deleted group member swiped');
            }
        } else if (type === 'impersonate') {
            activatedMembers = activateImpersonate(enabledMembers);
        } else if (activationStrategy === group_activation_strategy.NATURAL) {
            activatedMembers = activateNaturalOrder(enabledMembers, activationText, lastMessage, group.allow_self_responses, isUserInput);
        } else if (activationStrategy === group_activation_strategy.LIST) {
            activatedMembers = activateListOrder(enabledMembers);
        } else if (activationStrategy === group_activation_strategy.POOLED) {
            activatedMembers = activatePooledOrder(enabledMembers, lastMessage, isUserInput);
        } else if (activationStrategy === group_activation_strategy.MANUAL && !isUserInput) {
            activatedMembers = shuffle(enabledMembers).slice(0, 1).map(x => characters.findIndex(y => y.avatar === x)).filter(x => x !== -1);
        }

        if (isGroupDmChatMetadata()) {
            const allowedMemberSet = new Set(enabledMembers);
            activatedMembers = activatedMembers.filter(chid => allowedMemberSet.has(characters[chid]?.avatar));
        }

        const canUseMultiSpeakerTurn = byAutoMode || (params && Array.isArray(params.force_chids)) || (isWholeGroupAddress && isUserInput);
        const shouldForceSingleSpeaker = !canUseMultiSpeakerTurn && !['quiet', 'swipe', 'continue', 'impersonate'].includes(type);
        activatedMembers = limitGroupSpeakersForControl(activatedMembers, shouldForceSingleSpeaker);
        const shouldRenderUserMessage = Boolean(userInput) && !byAutoMode && !['quiet', 'swipe', 'continue', 'impersonate'].includes(type);
        let didRenderUserMessage = false;

        if (shouldRenderUserMessage) {
            if (activatedMembers.length > 0) {
                setCharacterId(activatedMembers[0]);
            }

            const bias = getBiasStrings(userInput, type);
            if (bias.messageBias && !userInput.replace(/\{\{[\s\S]*?\}\}/gm, '').trim()) {
                sendSystemMessage(system_message_types.GENERIC, ' ', { bias: bias.messageBias });
            } else {
                await sendMessageAsUser(userInput, bias.messageBias);
            }
            didRenderUserMessage = true;
            $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(resolve => requestAnimationFrame(resolve));
        }

        if (activatedMembers.length === 0) {
            return Promise.resolve();
        }

        await unshallowGroupMembers(selected_group);
        groupChatQueueOrder = new Map();

        if (power_user.show_group_chat_queue) {
            for (let i = 0; i < activatedMembers.length; ++i) {
                groupChatQueueOrder.set(characters[activatedMembers[i]].avatar, i + 1);
            }
        }
        await eventSource.emit(event_types.GROUP_WRAPPER_STARTED, { selected_group, type });
        // now the real generation begins: cycle through every activated character
        for (const chId of activatedMembers) {
            throwIfAborted();
            deactivateSendButtons();
            setCharacterId(chId);
            setCharacterName(characters[chId].name);
            setGroupTypingIndicator(characters[chId].name);
            if (power_user.show_group_chat_queue) {
                printGroupMembers();
            }
            await eventSource.emit(event_types.GROUP_MEMBER_DRAFTED, chId);

            // Wait for generation to finish
            const generateType = ['swipe', 'impersonate', 'quiet', 'continue'].includes(type) ? type : 'normal';
            const contextPrompt = buildContextAwareGroupPrompt(group, characters[chId]?.name || 'the selected speaker', {
                targetName: addressedMemberChid === chId ? getMessageSpeakerName(lastMessage) : '',
                isDm: type === 'dm' || isGroupDmChatMetadata(),
            });
            const mergedParams = { ...(params || {}) };
            mergedParams.quiet_prompt = [mergedParams.quiet_prompt, contextPrompt].filter(Boolean).join('\n');
            mergedParams.quietToLoud = true;
            mergedParams.suppressUserMessage = didRenderUserMessage || mergedParams.suppressUserMessage;
            if (type === 'dm' || isGroupDmChatMetadata()) {
                setPendingGeneratedMessageExtra(getGroupDmExtra(characters[chId]?.avatar, 'user'));
            }
            textResult = await runWithGroupMemberModelOverride(group, characters[chId]?.avatar, () => withGroupPrivateDmMemory(group, characters[chId]?.avatar, () => Generate(generateType, { automatic_trigger: byAutoMode, ...mergedParams })));
            let messageChunk = textResult?.messageChunk;

            if (messageChunk) {
                while (shouldAutoContinue(messageChunk, type === 'impersonate')) {
                    textResult = await runWithGroupMemberModelOverride(group, characters[chId]?.avatar, () => withGroupPrivateDmMemory(group, characters[chId]?.avatar, () => Generate('continue', { automatic_trigger: byAutoMode, ...mergedParams })));
                    messageChunk = textResult?.messageChunk;
                }
            }

            if (type === 'dm' || isGroupDmChatMetadata()) {
                const dmMessage = chat[chat.length - 1];
                if (dmMessage && !dmMessage.is_user && !dmMessage.is_system) {
                    dmMessage.extra = { ...(dmMessage.extra || {}), ...getGroupDmExtra(characters[chId]?.avatar, 'user') };
                    dmMessage.title = dmMessage.title || 'Private DM';
                    if (byAutoMode && type === 'dm' && !isGroupDmChatMetadata()) {
                        const dmSaved = await appendMessageToGroupDmChat(group, characters[chId], dmMessage, group.chat_id);
                        if (dmSaved) {
                            chat.pop();
                            await printMessages();
                            await saveChatConditional();
                            setUnreadGroupDm(group.id, characters[chId]?.avatar, true);
                        }
                    }
                }
            }
            if (power_user.show_group_chat_queue) {
                groupChatQueueOrder.delete(characters[chId].avatar);
                groupChatQueueOrder.forEach((value, key, map) => map.set(key, value - 1));
            }
            setGroupTypingIndicator('');
        }

        if (type === 'dm' && pendingGroupDmUserTarget) {
            pendingGroupDmUserTarget = '';
            updateGroupSpeakerControls();
        }

        if (selectedSpeakerChid !== -1 && !(params && typeof params.force_chid == 'number')) {
            clearSelectedGroupSpeaker();
        }
    } finally {
        setGenerationChatFilter(null);
        setPendingGeneratedMessageExtra(null);
        setPendingUserMessageExtra(null);
        setGroupTypingIndicator('');
        is_group_generating = false;
        setSendButtonState(false);
        setCharacterId(undefined);
        if (power_user.show_group_chat_queue) {
            groupChatQueueOrder = new Map();
            printGroupMembers();
        }
        setCharacterName('');
        activateSendButtons();
        showSwipeButtons();
        await eventSource.emit(event_types.GROUP_WRAPPER_FINISHED, { selected_group, type });
    }

    return Promise.resolve(textResult);
}

/**
 * Gets the generation ID of the last chat message.
 * @returns {number|null} Generation ID or null
 */
function getLastMessageGenerationId() {
    let generationId = null;
    if (chat.length > 0) {
        const lastMes = chat[chat.length - 1];
        if (!lastMes.is_user && !lastMes.is_system && lastMes.extra) {
            generationId = lastMes.extra.gen_id;
        }
    }
    return generationId;
}

/**
 * Activate group chat members for 'impersonate' generation type.
 * @param {string[]} members Array of group member avatar ids
 * @returns {number[]} Array of character ids
 */
function activateImpersonate(members) {
    const randomIndex = Math.floor(Math.random() * members.length);
    const activatedMembers = [members[randomIndex]];
    const memberIds = activatedMembers
        .map((x) => characters.findIndex((y) => y.avatar === x))
        .filter((x) => x !== -1);
    return memberIds;
}

/**
 * Activates a group member based on the last message.
 * @param {string[]} members Array of group member avatar ids
 * @param {Object} [options] Options object
 * @param {boolean} [options.allowSystem] Whether to allow system messages
 * @returns {number[]} Array of character ids
 */
function activateSwipe(members, { allowSystem = false } = {}) {
    let activatedNames = [];
    const lastMessage = chat[chat.length - 1];

    if (!lastMessage) {
        return [];
    }

    if (lastMessage.is_user || (!allowSystem && lastMessage.is_system) || lastMessage.extra?.type === system_message_types.NARRATOR) {
        for (const message of chat.slice().reverse()) {
            if (message.is_user || (!allowSystem && message.is_system) || message.extra?.type === system_message_types.NARRATOR) {
                continue;
            }

            if (message.original_avatar) {
                activatedNames.push(message.original_avatar);
                break;
            }
        }

        if (activatedNames.length === 0) {
            activatedNames.push(shuffle(members.slice())[0]);
        }
    }

    // pre-update group chat swipe
    if (!lastMessage.original_avatar) {
        const matches = characters.filter(x => x.name == lastMessage.name);

        for (const match of matches) {
            if (members.includes(match.avatar)) {
                activatedNames.push(match.avatar);
                break;
            }
        }
    } else {
        activatedNames.push(lastMessage.original_avatar);
    }

    const memberIds = activatedNames
        .map((x) => characters.findIndex((y) => y.avatar === x))
        .filter((x) => x !== -1);
    return memberIds;
}

/**
 * Activate group members for the list activation order.
 * @param {string[]} members Array of group member avatar ids
 * @returns {number[]} Array of character ids
 */
function activateListOrder(members) {
    let activatedMembers = members.filter(onlyUnique);

    // map to character ids
    const memberIds = activatedMembers
        .map((x) => characters.findIndex((y) => y.avatar === x))
        .filter((x) => x !== -1);
    return memberIds;
}

/**
 * Activate group members based on the last message.
 * @param {string[]} members List of member avatars
 * @param {Object} lastMessage Last message
 * @param {boolean} isUserInput Whether the user has input text
 * @returns {number[]} List of character ids
 */
function activatePooledOrder(members, lastMessage, isUserInput) {
    /** @type {string} */
    let activatedMember = null;
    /** @type {string[]} */
    const spokenSinceUser = [];

    for (const message of chat.slice().reverse()) {
        if (message.is_user || isUserInput) {
            break;
        }

        if (message.is_system || message.extra?.type === system_message_types.NARRATOR) {
            continue;
        }

        if (message.original_avatar) {
            spokenSinceUser.push(message.original_avatar);
        }
    }

    const haveNotSpoken = members.filter(x => !spokenSinceUser.includes(x));

    if (haveNotSpoken.length) {
        activatedMember = haveNotSpoken[Math.floor(Math.random() * haveNotSpoken.length)];
    }

    if (activatedMember === null) {
        const lastMessageAvatar = members.length > 1 && lastMessage && !lastMessage.is_user && lastMessage.original_avatar;
        const randomPool = lastMessageAvatar ? members.filter(x => x !== lastMessage.original_avatar) : members;
        activatedMember = randomPool[Math.floor(Math.random() * randomPool.length)];
    }

    const memberId = characters.findIndex(y => y.avatar === activatedMember);
    return memberId !== -1 ? [memberId] : [];
}

/**
 * Activate group members for the natural activation order.
 * @param {string[]} members Array of group member avatar ids
 * @param {string} input User input that triggered the generation
 * @param {ChatMessage} lastMessage Last message in the chat
 * @param {boolean} allowSelfResponses If the group allows self-responses
 * @param {boolean} isUserInput If the generation was triggered by user input
 * @returns {number[]} Array of character ids
 */
function activateNaturalOrder(members, input, lastMessage, allowSelfResponses, isUserInput) {
    let activatedMembers = [];

    // prevents the same character from speaking twice
    let bannedUser = !isUserInput && lastMessage && !lastMessage.is_user && lastMessage.name;

    // ...unless allowed to do so
    if (allowSelfResponses) {
        bannedUser = undefined;
    }

    // find mentions (excluding self)
    if (input && input.length) {
        for (let inputWord of extractAllWords(input)) {
            for (let member of members) {
                const character = characters.find(x => x.avatar === member);

                if (!character || character.name === bannedUser) {
                    continue;
                }

                if (extractAllWords(character.name).includes(inputWord)) {
                    activatedMembers.push(member);
                    break;
                }
            }
        }
    }

    const chattyMembers = [];
    // activation by talkativeness (in shuffled order, except banned)
    const shuffledMembers = shuffle([...members]);
    for (let member of shuffledMembers) {
        const character = characters.find((x) => x.avatar === member);

        if (!character || character.name === bannedUser) {
            continue;
        }

        const rollValue = Math.random();
        const talkativeness = isNaN(character.talkativeness)
            ? talkativeness_default
            : Number(character.talkativeness);
        if (talkativeness >= rollValue) {
            activatedMembers.push(member);
        }
        if (talkativeness > 0) {
            chattyMembers.push(member);
        }
    }

    // pick 1 at random if no one was activated
    let retries = 0;
    // try to limit the selected random character to those with talkativeness > 0
    const randomPool = chattyMembers.length > 0 ? chattyMembers : members;
    while (activatedMembers.length === 0 && ++retries <= randomPool.length) {
        const randomIndex = Math.floor(Math.random() * randomPool.length);
        const character = characters.find((x) => x.avatar === randomPool[randomIndex]);

        if (!character) {
            continue;
        }

        activatedMembers.push(randomPool[randomIndex]);
    }

    // de-duplicate array of character avatars
    activatedMembers = activatedMembers.filter(onlyUnique);

    // map to character ids
    const memberIds = activatedMembers
        .map((x) => characters.findIndex((y) => y.avatar === x))
        .filter((x) => x !== -1);
    return memberIds;
}

/**
 * Deletes a group from the server by ID.
 * @param {string} id Group ID to delete
 * @returns {Promise<void>} Promise that resolves when the group is deleted
 */
async function deleteGroup(id) {
    const group = groups.find((x) => x.id === id);

    const response = await fetch('/api/groups/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: id }),
    });

    if (group && Array.isArray(group.chats)) {
        for (const chatId of group.chats) {
            await eventSource.emit(event_types.GROUP_CHAT_DELETED, chatId);
        }
    }

    if (response.ok) {
        await clearChat();
        selected_group = null;
        delete tag_map[id];
        resetChatState();
        await printMessages();
        await getCharacters();

        select_rm_info('group_delete', id);

        $('#rm_button_selected_ch').children('h2').text('');
    }
}

/**
 * Edits a group by ID.
 * @param {string} id Group ID to edit
 * @param {boolean} immediately Whether to save immediately
 * @param {boolean} reload Whether to reload the groups after saving
 * @returns {Promise<void>} Promise that resolves when the group is edited
 */
export async function editGroup(id, immediately, reload = true) {
    let group = groups.find((x) => x.id === id);

    if (!group) {
        return;
    }

    if (immediately) {
        return await _save(group, reload);
    }

    saveGroupDebounced(group, reload);
}

/**
 * Unshallows all definitions of group members.
 * @param {string} groupId Id of the group
 * @returns {Promise<void>} Promise that resolves when all group members are unshallowed
 */
export async function unshallowGroupMembers(groupId) {
    const group = groups.find(x => x.id == groupId);
    if (!group) {
        return;
    }
    const members = group.members;
    if (!Array.isArray(members)) {
        return;
    }
    for (const member of members) {
        const index = characters.findIndex(x => x.avatar === member);
        if (index === -1) {
            continue;
        }
        await unshallowCharacter(String(index));
    }
}

let groupAutoModeAbortController = null;

async function groupChatAutoModeWorker() {
    if (!is_group_automode_enabled || online_status === 'no_connection') {
        return;
    }

    if (!selected_group || is_send_press || is_group_generating || hasUserDraftInChatBox() || shouldGroupDmWaitForUserTurn()) {
        return;
    }

    const group = groups.find((x) => x.id === selected_group);

    if (!group || !Array.isArray(group.members) || !group.members.length) {
        return;
    }

    const allowedMembers = getGroupDmAllowedMembers(group);
    if (!allowedMembers.length) {
        return;
    }

    groupAutoModeAbortController = new AbortController();
    await generateGroupWrapper(true, 'auto', { signal: groupAutoModeAbortController.signal, quiet_prompt: buildContextAwareGroupPrompt(group, 'the next speaker', { reason: 'automatic group conversation', isDm: isGroupDmChatMetadata() }), quietToLoud: true });
}

async function triggerImmediateMentionedGroupReply(messageId) {
    if (!is_group_automode_enabled || online_status === 'no_connection' || is_send_press || hasUserDraftInChatBox() || isGroupDmChatMetadata() || !selected_group) {
        return;
    }

    const message = chat[messageId];
    const group = groups.find((x) => x.id === selected_group);
    if (!group || !message || message.is_user || message.is_system) {
        return;
    }

    const addressedMemberChid = findDirectlyAddressedMember(group, message.mes);
    if (addressedMemberChid === -1 || characters[addressedMemberChid]?.avatar === message.original_avatar) {
        return;
    }

    if (is_group_generating) {
        await waitUntilCondition(() => !is_group_generating, debounce_timeout.extended, 20);
    }

    if (!is_group_automode_enabled || online_status === 'no_connection' || is_send_press || is_group_generating || getGroupAutoReplyDepth() >= 3) {
        return;
    }

    groupAutoModeAbortController = new AbortController();
    await generateGroupWrapper(true, 'auto', {
        signal: groupAutoModeAbortController.signal,
        force_chid: addressedMemberChid,
        quiet_prompt: buildContextAwareGroupPrompt(group, characters[addressedMemberChid]?.name || 'the mentioned speaker', { targetName: getMessageSpeakerName(message), isDm: isGroupDmChatMetadata() }),
        quietToLoud: true,
    });
}

async function triggerImmediateWholeGroupReply(messageId) {
    if (!is_group_automode_enabled || online_status === 'no_connection' || is_send_press || hasUserDraftInChatBox() || is_group_generating || !selected_group) {
        return;
    }

    const message = chat[messageId];
    const group = groups.find((x) => x.id === selected_group);
    if (!group || !message?.is_user || message.is_system || !isAddressedToEntireGroup(message.mes)) {
        return;
    }

    const forceChids = getGroupDmAllowedMembers(group).map(avatar => getCharacterIdByAvatar(avatar)).filter(chid => chid !== -1);
    if (!forceChids.length) {
        return;
    }

    groupAutoModeAbortController = new AbortController();
    await generateGroupWrapper(true, 'auto', {
        signal: groupAutoModeAbortController.signal,
        force_chids: forceChids,
        quiet_prompt: buildContextAwareGroupPrompt(group, 'everyone in the DM', { targetName: 'the user', isDm: isGroupDmChatMetadata() }),
        quietToLoud: true,
    });
}

async function groupScheduleAutoMessageWorker() {
    if (online_status === 'no_connection' || !selected_group || is_send_press || is_group_generating || hasUserDraftInChatBox()) {
        return;
    }

    const group = groups.find((x) => x.id === selected_group);
    if (!group?.auto_message_enabled || isGroupDmChatMetadata()) {
        return;
    }

    const schedule = parseGroupSchedule(group.ai_schedule);
    if (!schedule.length) {
        return;
    }

    const now = new Date();
    const dayKey = getCurrentDayKey(now);
    const currentMinutes = getCurrentMinutes(now);
    group.auto_schedule_state = group.auto_schedule_state && typeof group.auto_schedule_state === 'object' ? group.auto_schedule_state : {};
    const state = group.auto_schedule_state;

    for (const item of schedule) {
        const key = `${dayKey}:${item.time}:${item.name}`;
        if (state[key] || item.minutes > currentMinutes) {
            continue;
        }

        const chid = findScheduledCharacterId(group, item);
        if (chid === -1) {
            state[key] = 'missing';
            continue;
        }

        groupAutoModeAbortController = new AbortController();
        const character = characters[chid];
        const dmSettings = getGlobalGroupDmSettings();
        const isDmWanted = Boolean(dmSettings.autoDmEnabled && (!dmSettings.autoDmMember || dmSettings.autoDmMember === character.avatar));
        const cooldownMs = Math.max(1, Number(group.auto_dm_cooldown) || DEFAULT_AUTO_DM_COOLDOWN) * 1000;
        const lastAutoDmAt = Number(group.auto_schedule_state?.last_auto_dm_at || 0);
        const isDm = isDmWanted && (!lastAutoDmAt || Date.now() - lastAutoDmAt >= cooldownMs);
        if (isDmWanted && !isDm) {
            continue;
        }

        state[key] = Date.now();
        await saveGroupRuntimeState(group);
        await generateGroupWrapper(true, isDm ? 'dm' : 'auto', {
            signal: groupAutoModeAbortController.signal,
            force_chid: chid,
            quiet_prompt: buildContextAwareGroupPrompt(group, character.name, { reason: item.reason, isDm, targetName: isDm ? 'the user' : '' }),
            quietToLoud: true,
        });
        if (isDm) {
            group.auto_schedule_state.last_auto_dm_at = Date.now();
        }
        await saveGroupRuntimeState(group);
        break;
    }
}

/**
 * Modifies a group member by adding or removing them.
 * @param {string} groupId Group ID
 * @param {JQuery<HTMLElement>} groupMember Group member element
 * @param {boolean} isDelete If true, removes the member; otherwise adds the member
 */
async function modifyGroupMember(groupId, groupMember, isDelete) {
    const id = groupMember.data('id');
    const thisGroup = groups.find((x) => x.id == groupId);
    const membersArray = thisGroup?.members ?? newGroupMembers;

    if (isDelete) {
        const index = membersArray.findIndex((x) => x === id);
        if (index !== -1) {
            membersArray.splice(membersArray.indexOf(id), 1);
            if (thisGroup) {
                setGroupMemberModel(thisGroup, id, '');
            }
        }
    } else {
        membersArray.unshift(id);
    }

    if (openGroupId) {
        await unshallowGroupMembers(openGroupId);
        await editGroup(openGroupId, false, false);
        updateGroupAvatar(thisGroup);
    }

    printGroupCandidates();
    printGroupMembers();

    // Refresh the tag filters for both lists to reflect any new tags
    printTagFilters(tag_filter_type.group_candidates_list);
    printTagFilters(tag_filter_type.group_members_list);

    const groupHasMembers = getGroupCharacters({ doFilter: false, onlyMembers: true }).length > 0;
    $('#rm_group_submit').prop('disabled', !groupHasMembers);
}

/**
 * Reorders a group member up or down.
 * @param {string} groupId Group ID
 * @param {JQuery<HTMLElement>} groupMember Group member element
 * @param {string} direction Direction to move the member ('up' or 'down')
 * @returns {Promise<void>} Promise that resolves when the member has been reordered
 */
async function reorderGroupMember(groupId, groupMember, direction) {
    const id = groupMember.data('id');
    const thisGroup = groups.find((x) => x.id == groupId);
    const memberArray = thisGroup?.members ?? newGroupMembers;

    const indexOf = memberArray.indexOf(id);
    if (direction == 'down') {
        const next = memberArray[indexOf + 1];
        if (next) {
            memberArray[indexOf + 1] = memberArray[indexOf];
            memberArray[indexOf] = next;
        }
    }
    if (direction == 'up') {
        const prev = memberArray[indexOf - 1];
        if (prev) {
            memberArray[indexOf - 1] = memberArray[indexOf];
            memberArray[indexOf] = prev;
        }
    }

    printGroupMembers();

    // Existing groups need to modify members list
    if (openGroupId) {
        await editGroup(groupId, false, false);
        updateGroupAvatar(thisGroup);
    }
}

async function onGroupActivationStrategyInput(e) {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.activation_strategy = Number(e.target.value);
        await editGroup(openGroupId, false, false);
    }
}

async function onGroupGenerationModeInput(e) {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.generation_mode = Number(e.target.value);
        await editGroup(openGroupId, false, false);

        toggleHiddenControls(_thisGroup);
    }
}

async function onGroupAutoModeDelayInput(e) {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.auto_mode_delay = Number(e.target.value);
        await editGroup(openGroupId, false, false);
        setAutoModeWorker();
    }
}

async function onGroupAutoDmCooldownInput(e) {
    if (openGroupId) {
        const group = groups.find((x) => x.id == openGroupId);
        group.auto_dm_cooldown = Number(e.target.value) || DEFAULT_AUTO_DM_COOLDOWN;
        await editGroup(openGroupId, false, false);
    }
}

async function onGroupTimeAwareInput(e) {
    if (openGroupId) {
        const group = groups.find((x) => x.id == openGroupId);
        group.time_aware = $(e.target).prop('checked');
        await editGroup(openGroupId, false, false);
    }
}

async function onGroupAutoMessageInput(e) {
    if (openGroupId) {
        const group = groups.find((x) => x.id == openGroupId);
        group.auto_message_enabled = $(e.target).prop('checked');
        await editGroup(openGroupId, false, false);
        setAutoModeWorker();
    }
}

async function onGroupScheduleInput(e) {
    if (openGroupId) {
        const group = groups.find((x) => x.id == openGroupId);
        group.ai_schedule = String(e.target.value || '');
        await editGroup(openGroupId, false, false);
    }
}

async function onGenerateGroupScheduleClick() {
    const group = openGroupId ? groups.find((x) => x.id == openGroupId) : null;
    if (!group) {
        toastr.warning(t`Open a group first.`);
        return;
    }

    if (isGroupScheduleGenerating) {
        toastr.info(t`Group schedule is already being generated.`);
        return;
    }

    isGroupScheduleGenerating = true;
    const names = getGroupEnabledMembers(group)
        .map(avatar => characters.find(character => character.avatar === avatar)?.name)
        .filter(Boolean)
        .join(', ');
    const toast = toastr.info(t`Generating group schedule...`, '', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
    try {
        const prompt = `Create an immersive full-day routine and auto-message schedule for this fictional group. Current local time: ${getCurrentLocalTimeContext()}. Group members: ${names}. Cover the whole day from 00:00 through 23:00. Include mundane realistic activities such as sleeping, meals, chores, travel, study/work, rest, hobbies, checking on others, and winding down. Use 24-hour local time. Return only schedule lines in this exact format: HH:MM Character: short in-character reason. Include at least one entry for every hour 00 through 23, with natural variation and no markdown.`;
        const schedule = String(await generateRaw({
            prompt,
            systemPrompt: 'You create immersive 24-hour daily routines for fictional group chat auto-messages. Return only schedule lines in the requested HH:MM Character: reason format.',
            responseLength: 1200,
        }) || '').trim();
        if (!schedule) {
            toastr.warning(t`Schedule generation did not return anything.`);
            return;
        }

        group.ai_schedule = schedule;
        $('#rm_group_ai_schedule').val(schedule).trigger('input');
        await editGroup(group.id, false, false);
        toastr.success(t`Group schedule generated.`);
    } catch (error) {
        console.error('Group schedule generation failed', error);
        toastr.error(t`Group schedule generation failed.`);
    } finally {
        isGroupScheduleGenerating = false;
        toastr.clear(toast);
    }
}

async function onGroupGenerationModeTemplateInput(e) {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        const prop = $(e.target).attr('setting');
        _thisGroup[prop] = String(e.target.value);
        await editGroup(openGroupId, false, false);
    }
}

async function onGroupNameInput() {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.name = $(this).val();
        $('#rm_button_selected_ch').children('h2').text(_thisGroup.name);
        await editGroup(openGroupId, false);
    }
}

async function renameOpenGroup() {
    if (menu_type !== 'group_edit' || !openGroupId) {
        return;
    }

    const group = groups.find((x) => x.id == openGroupId);
    if (!group) {
        return;
    }

    const newName = await callGenericPopup('<h3>' + t`New name:` + '</h3>', POPUP_TYPE.INPUT, group.name);
    if (!newName || newName === group.name) {
        return;
    }

    group.name = String(newName);
    $('#rm_group_chat_name').val(group.name);
    $('#rm_button_selected_ch').children('h2').text(group.name);
    await editGroup(openGroupId, true, true);
}

const sillyBunnyShell = /** @type {any} */ (globalThis.SillyBunnyShell || {});
globalThis.SillyBunnyShell = Object.assign(sillyBunnyShell, {
    renameOpenGroup,
});

/**
 * Checks if a character with the given avatar ID is a member of the group.
 * @param {Group} group Group object
 * @param {string} avatarId Avatar ID to check
 * @returns {boolean} True if the avatar is a member of the group, false otherwise
 */
function isGroupMember(group, avatarId) {
    if (group && Array.isArray(group.members)) {
        return group.members.includes(avatarId);
    } else {
        return newGroupMembers.includes(avatarId);
    }
}

/**
 * Gets group characters based on filters.
 * @param {object} param
 * @param {boolean} [param.doFilter=false] Whether to apply filters
 * @param {boolean} [param.onlyMembers=false] Whether to include only group members
 * @returns {Array<{item: Character, id: number, type: string}>} Array of group character objects
 */
function getGroupCharacters({ doFilter = false, onlyMembers = false } = {}) {
    function applyFilterAndSort(results, filter, filterSelector) {
        let filtered = results;
        if (doFilter) {
            filtered = filter.applyFilters(filtered);
        }
        const useFilterOrder = doFilter && !!$(filterSelector).val();
        sortEntitiesList(filtered, useFilterOrder, filter);
        filter.clearFuzzySearchCaches();
        return filtered;
    }

    function handleMembers(results, thisGroup) {
        const membersArray = thisGroup?.members ?? newGroupMembers;

        // Create index map for O(1) lookups in member sort function
        // (separate from characterIndexMap which maps character objects to their array indices)
        const memberIndexMap = new Map(membersArray.map((avatar, index) => [avatar, index]));

        function sortMembersFn(a, b) {
            const aIndex = memberIndexMap.get(a.item.avatar) ?? -1;
            const bIndex = memberIndexMap.get(b.item.avatar) ?? -1;
            return aIndex - bIndex;
        }

        // Apply manual member sort before filter and sort
        let filtered = results;
        if (doFilter) {
            filtered = groupMembersFilter.applyFilters(filtered);
        }
        filtered.sort(sortMembersFn);

        // Apply conditional filter-based sort and cleanup
        const useFilterOrder = doFilter && !!$('#rm_group_members_filter').val();
        if (useFilterOrder) {
            sortEntitiesList(filtered, useFilterOrder, groupMembersFilter);
        }
        groupMembersFilter.clearFuzzySearchCaches();
        return filtered;
    }

    const thisGroup = openGroupId && groups.find((x) => x.id == openGroupId);

    // Create index map for O(1) lookups when mapping characters to their array indices
    // (separate from memberIndexMap used later for sorting members by their group order)
    const characterIndexMap = new Map(characters.map((char, index) => [char, index]));

    const results = characters
        .filter((x) => isGroupMember(thisGroup, x.avatar) == onlyMembers)
        .map((x) => ({ item: x, id: characterIndexMap.get(x), type: 'character' }));

    // Early return for candidates (non-members)
    if (!onlyMembers) {
        return applyFilterAndSort(results, groupCandidatesFilter, '#rm_group_filter');
    }

    // Handle members with manual sort capability
    return handleMembers(results, thisGroup);
}

function printGroupCandidates() {
    const storageKey = 'GroupCandidates_PerPage';
    const pageSize = Number(accountStorage.getItem(storageKey)) || 5;
    const sizeChangerOptions = [5, 10, 25, 50, 100, 200, 500, 1000];
    $('#rm_group_add_members_pagination').pagination({
        dataSource: getGroupCharacters({ doFilter: true, onlyMembers: false }),
        pageRange: 1,
        position: 'top',
        showPageNumbers: false,
        prevText: '<',
        nextText: '>',
        formatNavigator: PAGINATION_TEMPLATE,
        formatSizeChanger: renderPaginationDropdown(pageSize, sizeChangerOptions),
        showNavigator: true,
        showSizeChanger: true,
        pageSize,
        afterSizeSelectorChange: function (e, size) {
            accountStorage.setItem(storageKey, e.target.value);
            paginationDropdownChangeHandler(e, size);
        },
        callback: function (data) {
            $('#rm_group_add_members').empty();
            for (const i of data) {
                $('#rm_group_add_members').append(getGroupCharacterBlock(i.item));
            }
            localizePagination($('#rm_group_add_members_pagination'));
        },
    });
}

function printGroupMembers() {
    const storageKey = 'GroupMembers_PerPage';
    $('.rm_group_members_pagination').each(function () {
        let that = this;
        const pageSize = Number(accountStorage.getItem(storageKey)) || 5;
        const sizeChangerOptions = [5, 10, 25, 50, 100, 200, 500, 1000];
        $(this).pagination({
            dataSource: getGroupCharacters({ doFilter: true, onlyMembers: true }),
            pageRange: 1,
            position: 'top',
            showPageNumbers: false,
            prevText: '<',
            nextText: '>',
            formatNavigator: PAGINATION_TEMPLATE,
            showNavigator: true,
            showSizeChanger: true,
            formatSizeChanger: renderPaginationDropdown(pageSize, sizeChangerOptions),
            pageSize,
            afterSizeSelectorChange: function (e, size) {
                accountStorage.setItem(storageKey, e.target.value);
                paginationDropdownChangeHandler(e, size);
            },
            callback: function (data) {
                $('.rm_group_members').empty();
                for (const i of data) {
                    $('.rm_group_members').append(getGroupCharacterBlock(i.item));
                }
                localizePagination($(that));
            },
        });
    });
}

/**
 * Creates a jQuery element representing a group character block.
 * @param {Character} character Character object
 * @returns {JQuery<HTMLElement>} jQuery element representing the group character block
 */
function getGroupCharacterBlock(character) {
    const avatar = getThumbnailUrl('avatar', character.avatar);
    const template = $('#group_member_template .group_member').clone();
    const isFav = !!character.fav || character.fav == 'true';
    template.data('id', character.avatar);
    template.find('.avatar img').attr({ 'src': avatar, 'title': character.avatar });
    template.find('.ch_name').text(character.name);
    template.attr('data-chid', characters.indexOf(character));
    template.find('.ch_fav').val(String(isFav));
    template.toggleClass('is_fav', isFav);

    const auxFieldName = power_user.aux_field || 'character_version';
    const auxFieldValue = (character.data && character.data[auxFieldName]) || '';
    if (auxFieldValue) {
        template.find('.character_version').text(auxFieldValue);
    } else {
        template.find('.character_version').hide();
    }

    let queuePosition = groupChatQueueOrder.get(character.avatar);
    if (queuePosition) {
        template.find('.queue_position').text(queuePosition);
        template.toggleClass('is_queued', queuePosition > 1);
        template.toggleClass('is_active', queuePosition === 1);
    }

    template.toggleClass('disabled', isGroupMemberDisabled(character.avatar));

    const thisGroup = openGroupId && groups.find((x) => x.id == openGroupId);
    const modelInput = template.find('.group_member_model_input');
    modelInput.val(getGroupMemberModel(thisGroup, character.avatar));
    modelInput.toggle(!!thisGroup && isGroupMember(thisGroup, character.avatar));

    // Display inline tags
    const tagsElement = template.find('.tags');
    printTagList(tagsElement, { forEntityOrKey: characters.indexOf(character), tagOptions: { isCharacterList: true } });

    if (!openGroupId) {
        template.find('[data-action="speak"]').hide();
        template.find('[data-action="enable"]').hide();
        template.find('[data-action="disable"]').hide();
        modelInput.hide();
    }

    return template;
}

/**
 * Checks if a group member is disabled.
 * @param {string} avatarId Avatar ID of the group member
 * @returns {boolean} True if the group member is disabled, false otherwise
 */
function isGroupMemberDisabled(avatarId) {
    const thisGroup = openGroupId && groups.find((x) => x.id == openGroupId);
    return Boolean(thisGroup && thisGroup.disabled_members.includes(avatarId));
}

async function onDeleteGroupClick() {
    if (!openGroupId) {
        toastr.warning(t`Currently no group selected.`);
        return;
    }
    if (is_group_generating) {
        toastr.warning(t`Not so fast! Wait for the characters to stop typing before deleting the group.`);
        return;
    }

    const confirm = await Popup.show.confirm(t`Delete the group?`, '<p>' + t`This will also delete all your chats with that group. If you want to delete a single conversation, select a "View past chats" option in the lower left menu.` + '</p>');
    if (confirm) {
        deleteGroup(openGroupId);
    }
}

async function onFavoriteGroupClick() {
    updateFavButtonState(!fav_grp_checked);
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.fav = fav_grp_checked;
        await editGroup(openGroupId, false, false);
        favsToHotswap();
    }
}

async function onGroupSelfResponsesClick() {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        const value = $(this).prop('checked');
        _thisGroup.allow_self_responses = value;
        await editGroup(openGroupId, false, false);
    }
}

async function onHideMutedSpritesClick(value) {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.hideMutedSprites = value;
        console.log(`_thisGroup.hideMutedSprites = ${_thisGroup.hideMutedSprites}`);
        await editGroup(openGroupId, false, false);
        await eventSource.emit(event_types.GROUP_UPDATED);
    }
}

/**
 * Toggles the visibility of hidden controls based on the group's generation mode.
 * @param {Group} group Group object
 * @param {number|null} generationMode Generation mode, or null to use the group's current generation mode
 */
function toggleHiddenControls(group, generationMode = null) {
    const isJoin = [group_generation_mode.APPEND, group_generation_mode.APPEND_DISABLED].includes(generationMode ?? group?.generation_mode);
    $('#rm_group_generation_mode_join_prefix').parent().toggle(isJoin);
    $('#rm_group_generation_mode_join_suffix').parent().toggle(isJoin);

    if (!CSS.supports('field-sizing', 'content')) {
        initScrollHeight($('#rm_group_generation_mode_join_prefix'));
        initScrollHeight($('#rm_group_generation_mode_join_suffix'));
    }
}

/**
 * Opens a group creation/editing right menu.
 * @param {string|null} groupId ID of the group to select or null if creating a new group
 * @param {boolean} skipAnimation If true, skips the animation when selecting the group
 */
function select_group_chats(groupId, skipAnimation) {
    openGroupId = groupId;
    newGroupMembers = [];
    const group = openGroupId && groups.find((x) => x.id == openGroupId);
    const groupName = group?.name ?? '';
    const replyStrategy = Number(group?.activation_strategy ?? group_activation_strategy.NATURAL);
    const generationMode = Number(group?.generation_mode ?? group_generation_mode.SWAP);

    setMenuType(group ? 'group_edit' : 'group_create');
    $('#group_avatar_preview').empty().append(getGroupAvatar(group));
    $('#rm_group_restore_avatar').toggle(!!group && isValidImageUrl(group.avatar_url));
    $('#rm_group_filter').val('').trigger('input');
    $('#rm_group_members_filter').val('').trigger('input');
    $('#rm_group_activation_strategy').val(replyStrategy);
    $(`#rm_group_activation_strategy option[value="${replyStrategy}"]`).prop('selected', true);
    $('#rm_group_generation_mode').val(generationMode);
    $(`#rm_group_generation_mode option[value="${generationMode}"]`).prop('selected', true);
    $('#rm_group_chat_name').val(groupName);

    if (!skipAnimation) {
        selectRightMenuWithAnimation('rm_group_chats_block');
    }

    // render tags
    applyTagsOnGroupSelect(groupId);

    // render characters list
    printGroupCandidates();
    printGroupMembers();

    const groupHasMembers = !!$('#rm_group_members').children().length;
    $('#rm_group_submit').prop('disabled', !groupHasMembers);
    $('#rm_group_allow_self_responses').prop('checked', group && group.allow_self_responses);
    $('#rm_group_hidemutedsprites').prop('checked', group && group.hideMutedSprites);
    $('#rm_group_automode_delay').val(group?.auto_mode_delay ?? DEFAULT_AUTO_MODE_DELAY);
    $('#rm_group_auto_dm_cooldown').val(group?.auto_dm_cooldown ?? DEFAULT_AUTO_DM_COOLDOWN);
    $('#rm_group_time_aware').prop('checked', Boolean(group?.time_aware));
    $('#rm_group_auto_message').prop('checked', Boolean(group?.auto_message_enabled));
    $('#rm_group_ai_schedule').val(group?.ai_schedule ?? '');

    $('#rm_group_generation_mode_join_prefix').val(group?.generation_mode_join_prefix ?? '').attr('setting', 'generation_mode_join_prefix');
    $('#rm_group_generation_mode_join_suffix').val(group?.generation_mode_join_suffix ?? '').attr('setting', 'generation_mode_join_suffix');
    toggleHiddenControls(group, generationMode);

    // bottom buttons
    if (openGroupId) {
        $('#rm_group_submit').hide();
        $('#rm_group_delete').show();
        $('#rm_group_scenario').show();
        $('#group-metadata-controls .chat_lorebook_button').removeClass('disabled').prop('disabled', false);
        $('#group_open_media_overrides').show();
        const isMediaAllowed = isExternalMediaAllowed();
        $('#group_media_allowed_icon').toggle(isMediaAllowed);
        $('#group_media_forbidden_icon').toggle(!isMediaAllowed);
    } else {
        $('#rm_group_submit').show();
        if ($('#groupAddMemberListToggle .inline-drawer-content').css('display') !== 'block') {
            $('#groupAddMemberListToggle').trigger('click');
        }
        $('#rm_group_delete').hide();
        $('#rm_group_scenario').hide();
        $('#group-metadata-controls .chat_lorebook_button').addClass('disabled').prop('disabled', true);
        $('#group_open_media_overrides').hide();
    }

    updateFavButtonState(group?.fav ?? false);
    syncGroupAutoModeToggle();

    // top bar
    if (group) {
        $('#rm_group_automode_label').show();
        $('#rm_button_selected_ch').children('h2').text(groupName);
    } else {
        $('#rm_group_automode_label').hide();
    }

    // Toggle textbox sizes, as input events have not fired here
    if (!CSS.supports('field-sizing', 'content')) {
        $('#rm_group_chats_block .autoSetHeight').each(element => {
            resetScrollHeight(element);
        });
    }

    hideMutedSprites = group?.hideMutedSprites ?? false;
    $('#rm_group_hidemutedsprites').prop('checked', hideMutedSprites);

    updateGroupSpeakerControls();
    eventSource.emit('groupSelected', { detail: { id: openGroupId, group: group } });
}

/**
 * Handles the upload and processing of a group avatar.
 * The selected image is read, cropped using a popup, processed into a thumbnail,
 * and then uploaded to the server.
 *
 * @param {Event} event - The event triggered by selecting a file input, containing the image file to upload.
 *
 * @returns {Promise<void>} - A promise that resolves when the processing and upload is complete.
 */
async function uploadGroupAvatar(event) {
    if (!(event.target instanceof HTMLInputElement) || !event.target.files.length) {
        return;
    }

    const file = event.target.files[0];

    if (!file) {
        return;
    }

    const result = await getBase64Async(file);

    $('#dialogue_popup').addClass('large_dialogue_popup wide_dialogue_popup');

    const croppedImage = await callGenericPopup('Set the crop position of the avatar image', POPUP_TYPE.CROP, '', { cropImage: result });

    if (!croppedImage) {
        return;
    }

    let thumbnail = await createThumbnail(String(croppedImage), 200, 300);
    //remove data:image/whatever;base64
    thumbnail = thumbnail.replace(/^data:image\/[a-z]+;base64,/, '');
    let _thisGroup = groups.find((x) => x.id == openGroupId);
    // filename should be group id + human readable timestamp
    const filename = _thisGroup ? `${_thisGroup.id}_${humanizedDateTime()}` : humanizedDateTime();
    let thumbnailUrl = await saveBase64AsFile(thumbnail, String(openGroupId ?? ''), filename, 'jpg');
    if (!openGroupId) {
        $('#group_avatar_preview img').attr('src', thumbnailUrl);
        $('#rm_group_restore_avatar').show();
        return;
    }

    _thisGroup.avatar_url = thumbnailUrl;
    $('#group_avatar_preview').empty().append(getGroupAvatar(_thisGroup));
    $('#rm_group_restore_avatar').show();
    await editGroup(openGroupId, true, true);
}

async function restoreGroupAvatar() {
    const confirm = await Popup.show.confirm('Are you sure you want to restore the group avatar?', 'Your custom image will be deleted, and a collage will be used instead.');
    if (!confirm) {
        return;
    }

    if (!openGroupId) {
        $('#group_avatar_preview img').attr('src', default_avatar);
        $('#rm_group_restore_avatar').hide();
        return;
    }

    let _thisGroup = groups.find((x) => x.id == openGroupId);
    _thisGroup.avatar_url = '';
    $('#group_avatar_preview').empty().append(getGroupAvatar(_thisGroup));
    $('#rm_group_restore_avatar').hide();
    await editGroup(openGroupId, true, true);
}

async function onGroupActionClick(event) {
    event.stopPropagation();
    const action = $(this).data('action');
    const member = $(this).closest('.group_member');

    if (action === 'remove') {
        await modifyGroupMember(openGroupId, member, true);
    }

    if (action === 'add') {
        await modifyGroupMember(openGroupId, member, false);
    }

    if (action === 'enable') {
        member.removeClass('disabled');
        const _thisGroup = groups.find(x => x.id === openGroupId);
        const index = _thisGroup.disabled_members.indexOf(member.data('id'));
        if (index !== -1) {
            _thisGroup.disabled_members.splice(index, 1);
            await editGroup(openGroupId, false, false);
        }
    }

    if (action === 'disable') {
        member.addClass('disabled');
        const _thisGroup = groups.find(x => x.id === openGroupId);
        if (!_thisGroup.disabled_members.includes(member.data('id'))) {
            _thisGroup.disabled_members.push(member.data('id'));
            await editGroup(openGroupId, false, false);
        }
    }

    if (action === 'up' || action === 'down') {
        await reorderGroupMember(openGroupId, member, action);
    }

    if (action === 'view') {
        await openCharacterDefinition(member);
    }

    if (action === 'speak') {
        const chid = Number(member.attr('data-chid'));
        if (Number.isInteger(chid)) {
            Generate('normal', { force_chid: chid });
        }
    }

    await eventSource.emit(event_types.GROUP_UPDATED);
}

function isMobileGroupCandidateRowTap(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target || target.closest('.right_menu_button, input, button, select, textarea, a')) {
        return false;
    }

    return globalThis.SillyBunnyShell?.isMobileViewport?.() ?? Boolean(globalThis.matchMedia?.('(max-width: 768px)')?.matches);
}

async function onGroupCandidateRowClick(event) {
    if (!isMobileGroupCandidateRowTap(event)) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    await modifyGroupMember(openGroupId, $(this), false);
    await eventSource.emit(event_types.GROUP_UPDATED);
}

function updateFavButtonState(state) {
    fav_grp_checked = state;
    $('#rm_group_fav').val(String(fav_grp_checked));
    $('#group_favorite_button').toggleClass('fav_on', fav_grp_checked);
    $('#group_favorite_button').toggleClass('fav_off', !fav_grp_checked);
}

/**
 * Opens a group chat by its ID and updates the UI accordingly.
 * @param {string} groupId ID of the group to open
 * @param {object} options Open options
 * @param {boolean} [options.switchMenu=true] Whether to switch the right menu to the group editor
 * @returns {Promise<boolean>} Whether the group was opened
 */
export async function openGroupById(groupId, { switchMenu = true } = {}) {
    if (isChatSaving) {
        toastr.info(t`Please wait until the chat is saved before switching characters.`, t`Your chat is still saving...`);
        return false;
    }

    if (!groups.find(x => x.id === groupId)) {
        console.log('Group not found', groupId);
        return false;
    }

    if (is_send_press || is_group_generating) {
        return false;
    }

    if (switchMenu) {
        select_group_chats(groupId, false);
    }

    if (selected_group === groupId) {
        syncCharacterMenuActiveEntity();
        return true;
    }

    if (!await flushPendingChatSavesForNavigation()) {
        return false;
    }

    groupChatQueueOrder = new Map();
    setCharacterId(undefined);
    setCharacterName('');
    resetSelectedGroup();
    await clearChat({ clearData: true });
    cancelTtsPlay();
    selected_group = groupId;
    setEditedMessageId(undefined);
    updateChatMetadata({}, true);
    await getGroupChat(groupId, false, { switchMenu });
    syncGroupAutoModeToggle();
    syncCharacterMenuActiveEntity();
    return true;
}

/**
 * Peeks the character definition from a group member element.
 * @param {JQuery<HTMLElement>} characterSelect Character select element
 * @returns {Promise<void>}
 */
async function openCharacterDefinition(characterSelect) {
    if (is_group_generating) {
        toastr.warning(t`Can't peek a character while group reply is being generated`);
        console.warn('Can\'t peek a character def while group reply is being generated');
        return;
    }

    const chid = characterSelect.attr('data-chid');

    if (chid === null || chid === undefined) {
        return;
    }

    await unshallowCharacter(chid);
    setCharacterId(chid);
    select_selected_character(chid);
    // Gentle nudge to recalculate tokens
    RA_CountCharTokens();
    // Do a little tomfoolery to spoof the tag selector
    applyTagsOnCharacterSelect.call(characterSelect);
}

function filterGroupMembers() {
    const searchValue = String($(this).val()).toLowerCase();
    groupCandidatesFilter.setFilterData(FILTER_TYPES.SEARCH, searchValue);
}

function filterGroupMemberList() {
    const searchValue = String($(this).val()).toLowerCase();
    groupMembersFilter.setFilterData(FILTER_TYPES.SEARCH, searchValue);
}


function getSelectedGroupMemberAvatars() {
    if (openGroupId) {
        return groups.find(x => x.id === openGroupId)?.members ?? [];
    }

    return newGroupMembers;
}

function getGroupMemberSignature(members) {
    return [...new Set(Array.isArray(members) ? members : [])].sort().join('|');
}

function findGroupByMembers(members) {
    const signature = getGroupMemberSignature(members);
    if (!signature) {
        return null;
    }

    return groups.find(group => getGroupMemberSignature(group.members) === signature) || null;
}

async function createQuickGroupFromSelectedMembers() {
    const members = getSelectedGroupMemberAvatars().filter(onlyUnique);
    if (members.length === 0) {
        toastr.warning(t`Select at least one character first.`);
        return;
    }

    const existingGroup = !openGroupId ? findGroupByMembers(members) : null;
    if (existingGroup) {
        await createNewGroupChat(existingGroup.id);
        toastr.info(t`Opened a new chat branch for the existing group.`);
        return;
    }

    if (openGroupId) {
        await createNewGroupChat(openGroupId);
        toastr.info(t`Opened a new chat branch for this group.`);
        return;
    }

    const names = members
        .map(avatar => characters.find(character => character.avatar === avatar)?.name)
        .filter(Boolean);
    const defaultName = names.length ? t`Group: ${names.join(', ')}` : t`New Group`;
    const groupName = await Popup.show.input(t`Create Group Chat`, t`Name this group chat:`, defaultName);
    if (groupName === null) {
        return;
    }

    $('#rm_group_chat_name').val(String(groupName || defaultName));
    await createGroup();
}

async function onGroupMemberModelInput() {
    if (!openGroupId) {
        return;
    }

    const group = groups.find(x => x.id === openGroupId);
    const member = $(this).closest('.group_member');
    setGroupMemberModel(group, member.data('id'), $(this).val());
    await editGroup(openGroupId, false, false);
}

async function createGroup() {
    let name = $('#rm_group_chat_name').val().toString();
    let allowSelfResponses = !!$('#rm_group_allow_self_responses').prop('checked');
    let activationStrategy = Number($('#rm_group_activation_strategy').find(':selected').val()) ?? group_activation_strategy.NATURAL;
    let generationMode = Number($('#rm_group_generation_mode').find(':selected').val()) ?? group_generation_mode.SWAP;
    let autoModeDelay = Number($('#rm_group_automode_delay').val()) ?? DEFAULT_AUTO_MODE_DELAY;
    const members = newGroupMembers.filter(onlyUnique);
    const existingGroup = findGroupByMembers(members);
    if (existingGroup) {
        await createNewGroupChat(existingGroup.id);
        toastr.info(t`Opened a new chat branch for the existing group.`);
        return;
    }

    const memberNames = characters.filter(x => members.includes(x.avatar)).map(x => x.name).join(', ');

    if (!name) {
        name = t`Group: ${memberNames}`;
    }

    const avatarUrl = $('#group_avatar_preview img').attr('src');
    const chatName = humanizedDateTime();
    const chats = [chatName];

    /** @type {Omit<Group, 'id'>} */
    const groupCreateModel = {
        name: name,
        members: members,
        avatar_url: isValidImageUrl(avatarUrl) ? avatarUrl : default_avatar,
        allow_self_responses: allowSelfResponses,
        hideMutedSprites: hideMutedSprites,
        activation_strategy: activationStrategy,
        generation_mode: generationMode,
        disabled_members: [],
        [GROUP_MEMBER_MODELS_KEY]: {},
        fav: fav_grp_checked,
        chat_id: chatName,
        chats: chats,
        auto_mode_delay: autoModeDelay,
        auto_dm_cooldown: Number($('#rm_group_auto_dm_cooldown').val()) || DEFAULT_AUTO_DM_COOLDOWN,
        time_aware: Boolean($('#rm_group_time_aware').prop('checked')),
        auto_message_enabled: Boolean($('#rm_group_auto_message').prop('checked')),
        ai_schedule: String($('#rm_group_ai_schedule').val() || ''),
        auto_schedule_state: {},
    };

    const createGroupResponse = await fetch('/api/groups/create', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(groupCreateModel),
    });

    if (createGroupResponse.ok) {
        newGroupMembers = [];
        const data = await createGroupResponse.json();
        createTagMapFromList('#groupTagList', data.id);
        await getCharacters();
        select_rm_info('group_create', data.id);
    }
}

/**
 * Creates a new group chat within the specified group.
 * @param {string} groupId Group ID
 * @returns {Promise<void>} Promise that resolves when the new group chat is created
 */
export async function createNewGroupChat(groupId) {
    const group = groups.find(x => x.id === groupId);

    if (!group) {
        return;
    }

    if (!await flushPendingChatSavesForNavigation()) {
        return;
    }

    await clearChat({ clearData: true });
    const newChatName = humanizedDateTime();
    group.chats.push(newChatName);
    group.chat_id = newChatName;
    updateChatMetadata({}, true);

    await editGroup(group.id, true, false);
    await getGroupChat(group.id);
    syncGroupAutoModeToggle();
}

/**
 * Retrieves past chats for a specified group.
 * @param {string} groupId Group ID
 * @returns {Promise<Array<import('../../src/endpoints/chats.js').ChatInfo>>} Array of past chats
 */
export async function getGroupPastChats(groupId) {
    const group = groups.find(x => x.id === groupId);

    if (!group) {
        return [];
    }

    const chats = [];

    try {
        for (const chatId of group.chats) {
            const response = await fetch('/api/chats/group/info', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ id: chatId }),
            });
            if (response.ok) {
                const data = await response.json();
                chats.push(data);
            }
        }
    } catch (err) {
        console.error(err);
    }
    return chats;
}

/**
 * Opens a specific group chat for the specified group by its ID.
 * @param {string} groupId Group ID
 * @param {string} chatId Chat ID
 * @returns {Promise<void>}
 */
export async function openGroupChat(groupId, chatId) {
    await waitUntilCondition(() => !isChatSaving, debounce_timeout.extended, 10);
    const group = groups.find(x => x.id === groupId);

    if (!group || !group.chats.includes(chatId)) {
        return;
    }

    if (!await flushPendingChatSavesForNavigation()) {
        return;
    }

    await clearChat({ clearData: true });
    group.chat_id = chatId;
    group.date_last_chat = Date.now();
    updateChatMetadata({}, true);

    await editGroup(groupId, true, false);
    await getGroupChat(groupId);
    syncGroupAutoModeToggle();
}

/**
 * Renames a group chat within the specified group.
 * @param {string} groupId Group ID
 * @param {string} oldChatId Old chat ID
 * @param {string} newChatId New chat ID
 * @returns {Promise<void>} Promise that resolves when the group chat is renamed
 */
export async function renameGroupChat(groupId, oldChatId, newChatId) {
    const group = groups.find(x => x.id === groupId);

    if (!group || !group.chats.includes(oldChatId)) {
        return;
    }

    if (group.chat_id === oldChatId) {
        group.chat_id = newChatId;
    }

    group.chats.splice(group.chats.indexOf(oldChatId), 1);
    group.chats.push(newChatId);

    await editGroup(groupId, true, true);
}

/**
 * Deletes a group chat by its name. Doesn't affect displayed chat.
 * @param {string} groupId Group ID
 * @param {string} chatName Name of the chat to delete
 * @returns {Promise<boolean>} Whether the chat was deleted
 */
export async function deleteGroupChatByName(groupId, chatName) {
    const group = groups.find(x => x.id === groupId);
    if (!group || !group.chats.includes(chatName)) {
        return false;
    }

    group.chats.splice(group.chats.indexOf(chatName), 1);

    const response = await fetch('/api/chats/group/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: chatName }),
    });

    if (!response.ok) {
        toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Group chat could not be deleted`);
        console.error('Group chat could not be deleted');
        return false;
    }

    // If the deleted chat was the current chat, switch to the last chat in the group
    if (group.chat_id === chatName) {
        const newChatName = group.chats.length ? group.chats[group.chats.length - 1] : humanizedDateTime();
        group.chat_id = newChatName;
    }

    await editGroup(groupId, true, true);
    await eventSource.emit(event_types.GROUP_CHAT_DELETED, chatName);
    return true;
}

/**
 * Deletes a group chat by name.
 * @param {string} groupId The ID of the group containing the chat to delete.
 * @param {string} chatId The id/name of the chat to delete.
 * @param {object} [options={}] Options for the deletion.
 * @param {boolean} [options.jumpToNewChat=true] Whether to jump to a new chat after deletion (existing one, or create a new one if none exists)
 */
export async function deleteGroupChat(groupId, chatId, { jumpToNewChat = true } = {}) {
    const group = groups.find(x => x.id === groupId);

    if (!group || !group.chats.includes(chatId)) {
        return;
    }

    group.chats.splice(group.chats.indexOf(chatId), 1);

    if (group.chat_id === chatId) {
        group.chat_id = '';
        updateChatMetadata({}, true);
    }

    const response = await fetch('/api/chats/group/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: chatId }),
    });

    if (response.ok) {
        if (jumpToNewChat) {
            if (group.chats.length) {
                await openGroupChat(groupId, group.chats[group.chats.length - 1]);
            } else {
                await createNewGroupChat(groupId);
            }
        }

        await eventSource.emit(event_types.GROUP_CHAT_DELETED, chatId);
    }
}

/**
 * Imports a group chat from a file and adds it to the group.
 * @param {FormData} formData Form data to send to the server
 * @param {object} [options={}] Options for the import
 * @param {boolean} [options.refresh] Whether to refresh the group chat list after import
 * @returns {Promise<string[]>} List of imported file names
 */
export async function importGroupChat(formData, { refresh = true } = {}) {
    const fetchResult = await fetch('/api/chats/group/import', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
        cache: 'no-cache',
    });

    if (fetchResult.ok) {
        const data = await fetchResult.json();
        if (data.res) {
            const chatId = data.res;
            const group = groups.find(x => x.id == selected_group);

            if (group) {
                group.chats.push(chatId);
                await editGroup(selected_group, true, true);
                if (refresh) {
                    await displayPastChats();
                }
            }

            return [data.res];
        }

        return data?.fileNames || [];
    }

    return [];
}

/**
 * Saves the current group chat as a bookmark chat.
 * @param {string} groupId Group ID
 * @param {string} name Name of the chat to save
 * @param {ChatMetadata?} metadata New metadata to save with the chat
 * @param {number|undefined} mesId Optional message ID to trim the chat up to
 * @param {ChatMessage[]|undefined} chatData Optional chat snapshot to save instead of the current in-memory chat
 * @param {{throwOnError?: boolean}} [options] Additional save options
 * @returns {Promise<boolean>} Promise that resolves to whether the group chat was saved
 */
export async function saveGroupBookmarkChat(groupId, name, metadata, mesId, chatData = undefined, { throwOnError = false } = {}) {
    const group = groups.find(x => x.id === groupId);

    if (!group) {
        return false;
    }

    group.chats.push(name);

    /** @type {ChatHeader} */
    const chatHeader = {
        chat_metadata: { ...chat_metadata, ...(metadata || {}) },
        user_name: 'unused',
        character_name: 'unused',
    };

    /** @type {ChatMessage[]} */
    const trimmedChat = Array.isArray(chatData)
        ? chatData
        : (mesId !== undefined && mesId >= 0 && mesId < chat.length)
            ? chat.slice(0, Number(mesId) + 1)
            : chat;

    try {
        await editGroup(groupId, true, false);

        const saveChatRequest = await compressRequest({
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ id: name, chat: [chatHeader, ...trimmedChat] }),
        });
        const response = await fetch('/api/chats/group/save', saveChatRequest);

        if (!response.ok) {
            throw new Error(response.statusText || 'Group chat could not be saved');
        }

        return true;
    } catch (error) {
        toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Group chat could not be saved`);
        console.error('Group chat could not be saved', error);
        if (throwOnError) {
            throw error;
        }
        return false;
    }
}

function stopAutoModeGeneration() {
    if (groupAutoModeAbortController) {
        groupAutoModeAbortController.abort();
    }
}

function doCurMemberListPopout() {
    //repurposes the zoomed avatar template to server as a floating group member list
    if ($('#groupMemberListPopout').length === 0) {
        console.debug('did not see popout yet, creating');
        const memberListClone = $(this).parent().parent().find('.inline-drawer-content').html();
        const template = $('#zoomed_avatar_template').html();
        const controlBarHtml = `<div class="panelControlBar flex-container">
        <div id="groupMemberListPopoutheader" class="fa-solid fa-grip drag-grabber hoverglow"></div>
        <div id="groupMemberListPopoutClose" class="fa-solid fa-circle-xmark hoverglow"></div>
    </div>`;
        const newElement = $(template);

        newElement.attr('id', 'groupMemberListPopout')
            .removeClass('zoomed_avatar')
            .addClass('draggable')
            .empty()
            .append(controlBarHtml)
            .append(memberListClone);

        // Remove pagination from popout
        newElement.find('.group_pagination').empty();

        $('#movingDivs').append(newElement);
        loadMovingUIState();
        $('#groupMemberListPopout').fadeIn(animation_duration);
        dragElement(newElement);
        $('#groupMemberListPopoutClose').off('click').on('click', function () {
            $('#groupMemberListPopout').fadeOut(animation_duration, () => { $('#groupMemberListPopout').remove(); });
        });

        // Re-add pagination not working in popout
        printGroupMembers();
    } else {
        console.debug('saw existing popout, removing');
        $('#groupMemberListPopout').fadeOut(animation_duration, () => { $('#groupMemberListPopout').remove(); });
    }
}

jQuery(() => {
    applyGlobalGroupAutoModeSettings();
    initGroupSpeakerControls();
    if (!CSS.supports('field-sizing', 'content')) {
        $(document).on('input', '#rm_group_chats_block .autoSetHeight', function () {
            resetScrollHeight($(this));
        });
    }

    $(document).on('click', '.group_select', async function () {
        const isCharactersBlockClick = $(this).closest('#rm_print_characters_block').length > 0;
        const shouldCloseCharacterMenu = isCharactersBlockClick && (globalThis.SillyBunnyShell?.isMobileViewport?.() ?? true);
        const groupId = $(this).attr('data-chid') || $(this).attr('data-grid');
        // SillyBunny: drawer selection flashes Editor instead of opening it.
        const didOpenGroup = await openGroupById(groupId, { switchMenu: false });
        if (didOpenGroup && isCharactersBlockClick) {
            pulseSelectedEntityCard(this);
            globalThis.SillyBunnyShell?.highlightCharacterEditorTab?.();
        }
        if (shouldCloseCharacterMenu) {
            globalThis.SillyBunnyShell?.closeCharacters?.();
        }
    });
    $('#rm_group_filter').on('input', filterGroupMembers);
    $('#rm_group_members_filter').on('input', filterGroupMemberList);
    $('#rm_group_submit').on('click', createGroup);
    $('#rm_group_quick_create').on('click', createQuickGroupFromSelectedMembers);
    $('#rm_group_scenario').on('click', setCharacterSettingsOverrides);
    $('#rm_group_automode').on('input', function () {
        const value = $(this).prop('checked');
        is_group_automode_enabled = value;
        saveGlobalGroupAutoModeEnabled(value);
        syncGroupAutoModeToggle();
        if (!value) {
            stopAutoModeGeneration();
        }
    });
    $('#rm_group_hidemutedsprites').on('input', function () {
        const value = $(this).prop('checked');
        hideMutedSprites = value;
        onHideMutedSpritesClick(value);
    });
    $('#groupCurrentMemberPopoutButton').on('click', doCurMemberListPopout);
    $('#rm_group_chat_name').on('input', onGroupNameInput);
    $('#rm_button_selected_ch h2').on('click', async function (event) {
        if (menu_type !== 'group_edit' || !openGroupId) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        await renameOpenGroup();
    });
    $('#rm_group_delete').off().on('click', onDeleteGroupClick);
    $('#group_favorite_button').on('click', onFavoriteGroupClick);
    $('#rm_group_allow_self_responses').on('input', onGroupSelfResponsesClick);
    $('#rm_group_activation_strategy').on('change', onGroupActivationStrategyInput);
    $('#rm_group_generation_mode').on('change', onGroupGenerationModeInput);
    $('#rm_group_automode_delay').on('input', onGroupAutoModeDelayInput);
    $('#rm_group_auto_dm_cooldown').on('input', onGroupAutoDmCooldownInput);
    $('#rm_group_time_aware').on('input', onGroupTimeAwareInput);
    $('#rm_group_auto_message').on('input', onGroupAutoMessageInput);
    $('#rm_group_ai_schedule').on('input', onGroupScheduleInput);
    $('#rm_group_generate_schedule').on('click', onGenerateGroupScheduleClick);
    $('#rm_group_generation_mode_join_prefix').on('input', onGroupGenerationModeTemplateInput);
    $('#rm_group_generation_mode_join_suffix').on('input', onGroupGenerationModeTemplateInput);
    $('#group_avatar_button').on('input', uploadGroupAvatar);
    $('#rm_group_restore_avatar').on('click', restoreGroupAvatar);
    $(document).on('click', '.group_member .right_menu_button', onGroupActionClick);
    $(document).on('click', '#rm_group_add_members .group_member', onGroupCandidateRowClick);
    $(document).on('change', '.group_member_model_input', onGroupMemberModelInput);
    eventSource.on(event_types.CHAT_CHANGED, updateGroupSpeakerControls);
    eventSource.on(event_types.GROUP_UPDATED, updateGroupSpeakerControls);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, (messageId) => {
        triggerImmediateWholeGroupReply(messageId);
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        triggerImmediateMentionedGroupReply(messageId);
    });
    eventSource.on(event_types.ONLINE_STATUS_CHANGED, () => {
        groupScheduleAutoMessageWorker();
    });
});
