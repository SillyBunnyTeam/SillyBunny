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
    uuidv4,
} from './utils.js';
import { RA_CountCharTokens, humanizedDateTime, dragElement, favsToHotswap, getMessageTimeStamp } from './RossAscends-mods.js';
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
    saveChatConditional,
    getBiasStrings,
    flushPendingChatSavesForNavigation,
    deactivateSendButtons,
    activateSendButtons,
    eventSource,
    event_types,
    getCurrentChatId,
    setCharacterSettingsOverrides,
    system_avatar,
    getRequestHeaders,
    refreshCsrfToken,
    setExternalAbortController,
    baseChatReplace,
    createLazyFields,
    depth_prompt_depth_default,
    loadItemizedPrompts,
    animation_duration,
    depth_prompt_role_default,
    shouldAutoContinue,
    unshallowCharacter,
    chatElement,
    ensureMessageMediaIsArray,
    syncCharacterMenuActiveEntity,
    incrementChatGeneration,
    getChatGeneration,
} from '../script.js';
import { getQueuedChatSaveAbortReason } from './chat-save-guard.js';
import { getChatBackupSaveOptions } from './chat-backup-sequence.js';
import { printTagList, createTagMapFromList, applyTagsOnCharacterSelect, tag_map, applyTagsOnGroupSelect, printTagFilters, tag_filter_type } from './tags.js';
import { FILTER_TYPES, FilterHelper } from './filters.js';
import { isExternalMediaAllowed } from './chats.js';
import { POPUP_TYPE, Popup, callGenericPopup } from './popup.js';
import { t } from './i18n.js';
// SillyBunny: member actions share the shell's popover / bottom-sheet menu.
import { openActionMenu } from './sillybunny-action-menu.js';
import { MOTION_FAST, animateListChange, applyListChange, captureListChange } from './sillybunny-motion.js';
import { accountStorage } from './util/AccountStorage.js';
import { compressRequest } from './request-compression.js';
import { fetchWithCsrfRetry } from './csrf-token-refresh.js';
import { chat_completion_sources, oai_settings } from './openai.js';
import { getRegexedString, regex_placement } from './extensions/regex/engine.js';
import { ToolManager } from './tool-calling.js';
import { createGroupTurnRouting, getRoutedReplyStatus } from './group-turn-routing.js';
// SillyBunny: group editor controller (Step 4 - explicit save)
import {
    beginGroupEditorLoad,
    openGroupEditorSession,
    openGroupEditorCreateSession,
    captureGroupEditorSave,
    readGroupEditorBaseline,
    isGroupEditorOwner,
    notifyGroupEditorChanged,
    rebaseGroupEditor,
    initGroupEditor,
} from './sillybunny-group-editor.js';

export {
    selected_group,
    openGroupId,
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
    setSelectedGroupSpeakerAvatar,
    updateGroupSpeakerControls,
    groupTurnRoutingApi,
};

let is_group_generating = false; // Group generation flag
let hideMutedSprites = false;
/** @type {Group[]} */
let groups = [];
/** @type {string|null} */
let selected_group = null;
let group_generation_id = null;
let fav_grp_checked = false;
let openGroupId = null;

// SillyBunny: the group editor's unsaved draft (Step 4). While the explicit-save
// editor owns a group, every editable field is written here and never into
// groups[]; Save copies the draft over the live group and calls editGroup().
// EDITABLE_KEYS is the whole surface: it is what the session baselines, what the
// draft backup stores, and what a reconcile merges against the live group.
//
// `newGroupMembers` is kept as an alias of editorDraft.members, because several
// upstream helpers read it directly.
const EDITABLE_KEYS = [
    'name',
    'fav',
    'activation_strategy',
    'generation_mode',
    'generation_mode_join_prefix',
    'generation_mode_join_suffix',
    'allow_self_responses',
    'hideMutedSprites',
    'members',
    'disabled_members',
    'member_models',
];

/** @typedef {Record<string, any>} GroupDraft */

/** @type {GroupDraft|null} */
let editorDraft = null;

/**
 * True when the current group has a custom avatar that can be reverted to the
 * member collage, so the ⋯ menu only offers that action when it applies.
 * @returns {boolean}
 */
export function canRestoreGroupAvatar() {
    const group = getEditedGroup();
    return Boolean(group && isValidImageUrl(group.avatar_url));
}

// ============================================================
// Editor draft (Step 4)
// ============================================================

/** @param {any} value */
function cloneDraftValue(value) {
    return value === undefined ? undefined : structuredClone(value);
}

/**
 * A draft shaped like a group, holding only EDITABLE_KEYS.
 * @param {Group|null} group
 * @returns {GroupDraft}
 */
function createEditorDraft(group) {
    /** @type {GroupDraft} */
    const draft = { id: group?.id ?? null, avatar_url: group?.avatar_url ?? '' };
    for (const key of EDITABLE_KEYS) {
        draft[key] = _draftDefaultFor(key, group);
    }
    return draft;
}

/**
 * @param {string} key
 * @param {Group|null} group
 */
function _draftDefaultFor(key, group) {
    const live = group?.[key];
    switch (key) {
        case 'name': return group?.name ?? '';
        case 'fav': return Boolean(group?.fav);
        case 'activation_strategy': return Number(group?.activation_strategy ?? group_activation_strategy.NATURAL);
        case 'generation_mode': return Number(group?.generation_mode ?? group_generation_mode.SWAP);
        case 'generation_mode_join_prefix': return String(group?.generation_mode_join_prefix ?? '');
        case 'generation_mode_join_suffix': return String(group?.generation_mode_join_suffix ?? '');
        case 'allow_self_responses': return Boolean(group?.allow_self_responses);
        case 'hideMutedSprites': return Boolean(group?.hideMutedSprites);
        case 'members': return Array.isArray(live) ? [...live] : [];
        case 'disabled_members': return Array.isArray(live) ? [...live] : [];
        case 'member_models': return live && typeof live === 'object' && !Array.isArray(live) ? { ...live } : {};
        default: return undefined;
    }
}

/** Start a new draft for the group being loaded; null starts an empty one. */
function resetEditorDraft(group) {
    editorDraft = createEditorDraft(group ?? null);
}

/**
 * True when the editor owns the fields on screen, which covers both an edit
 * session for a persisted group and a create session that has no group yet. In
 * create mode `openGroupId` stays null for the whole session, so every handler
 * that used the old `if (!openGroupId) return` guard must ask this instead or
 * its edits are silently dropped.
 * @returns {boolean}
 */
function isGroupEditorActive() {
    return Boolean(editorDraft);
}

/**
 * The object the editor's member list and fields read. While the editor owns an
 * edit session this is the draft, so `groups[]` never holds an unsaved value.
 * @returns {Group|GroupDraft|null}
 */
function getEditedGroup() {
    const groupId = openGroupId ? String(openGroupId) : null;
    if (editorDraft && groupId && String(editorDraft.id) === groupId) return editorDraft;
    if (editorDraft && !groupId) return editorDraft;
    return openGroupId ? groups.find((x) => x.id == openGroupId) : null;
}

/**
 * Copy every EDITABLE_KEY of the draft onto the live group in place, so the
 * `groups` array identity (and every extension holding a reference) survives.
 * @param {Group} group
 * @param {GroupDraft} draft
 */
function applyDraftToGroup(group, draft) {
    for (const key of EDITABLE_KEYS) {
        group[key] = cloneDraftValue(draft[key]);
    }
    group.avatar_url = draft.avatar_url || group.avatar_url;
}

/**
 * Write the editable fields from the draft (or the live group) into the DOM
 * without dispatching events, so a re-render is never mistaken for a user edit.
 * @param {Group|GroupDraft|null} source
 */
function writeGroupEditorFields(source) {
    if (!source) return;

    const name = $('#rm_group_chat_name');
    if (name.val() !== source.name) name.val(source.name ?? '');

    const strategy = String(source.activation_strategy ?? group_activation_strategy.NATURAL);
    const strategyField = $('#rm_group_activation_strategy');
    if (strategyField.val() !== strategy) strategyField.val(strategy);

    const mode = String(source.generation_mode ?? group_generation_mode.SWAP);
    const modeField = $('#rm_group_generation_mode');
    if (modeField.val() !== mode) modeField.val(mode);

    const prefix = $('#rm_group_generation_mode_join_prefix');
    if (prefix.val() !== (source.generation_mode_join_prefix ?? '')) prefix.val(source.generation_mode_join_prefix ?? '');

    const suffix = $('#rm_group_generation_mode_join_suffix');
    if (suffix.val() !== (source.generation_mode_join_suffix ?? '')) suffix.val(source.generation_mode_join_suffix ?? '');

    $('#rm_group_allow_self_responses').prop('checked', Boolean(source.allow_self_responses));
    $('#rm_group_hidemutedsprites').prop('checked', Boolean(source.hideMutedSprites));
    updateFavButtonState(Boolean(source.fav));

    toggleHiddenControls(source);
    _syncGroupMediaOverrideIcons();
    updateGroupAvatar(source);
    updateGroupHeaderTitle(source.name ?? '');
}

/** The hidden #rm_button_selected_ch h2 mirrors; kept in sync by the editor. */
function updateGroupHeaderTitle(name) {
    $('#rm_button_selected_ch').children('h2').text(name);
}

/**
 * Apply one member action to a group-like object. Pure: it never touches the
 * DOM or the live group, so the same code drives the editor draft and the
 * programmatic path (slash commands, extensions) that still writes straight
 * through.
 * @param {Group|GroupDraft} groupLike
 * @param {'add'|'remove'|'enable'|'disable'} action
 * @param {string} avatarId
 * @returns {boolean} true when the object changed
 */
function applyMemberAction(groupLike, action, avatarId) {
    if (!groupLike || !avatarId) return false;
    groupLike.members = Array.isArray(groupLike.members) ? groupLike.members : [];
    groupLike.disabled_members = Array.isArray(groupLike.disabled_members) ? groupLike.disabled_members : [];

    switch (action) {
        case 'add':
            if (groupLike.members.includes(avatarId)) return false;
            groupLike.members.unshift(avatarId);
            return true;
        case 'remove': {
            const index = groupLike.members.indexOf(avatarId);
            if (index === -1) return false;
            groupLike.members.splice(index, 1);
            const disabledIndex = groupLike.disabled_members.indexOf(avatarId);
            if (disabledIndex !== -1) groupLike.disabled_members.splice(disabledIndex, 1);
            if (groupLike.member_models) delete groupLike.member_models[avatarId];
            return true;
        }
        case 'disable':
            if (groupLike.disabled_members.includes(avatarId)) return false;
            groupLike.disabled_members.push(avatarId);
            return true;
        case 'enable': {
            const index = groupLike.disabled_members.indexOf(avatarId);
            if (index === -1) return false;
            groupLike.disabled_members.splice(index, 1);
            return true;
        }
        default:
            return false;
    }
}

/**
 * Move a member within a group-like object's order.
 * @param {Group|GroupDraft} groupLike
 * @param {number} from
 * @param {number} to
 * @returns {boolean} true when the order changed
 */
function moveGroupMember(groupLike, from, to) {
    const members = groupLike?.members;
    if (!Array.isArray(members)) return false;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || to < 0 || from >= members.length || to >= members.length || from === to) return false;
    const [moved] = members.splice(from, 1);
    members.splice(to, 0, moved);
    return true;
}

let groupChatSaveQueue = Promise.resolve();
const queuedGroupChatIntegrityByFile = new Map();

const GROUP_MEMBER_MODELS_KEY = 'member_models';
const ENTITY_SELECTION_PULSE_CLEANUP_MS = 900;
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
        case chat_completion_sources.GEMINI_INTERACTIONS: return 'google_model';
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

const GROUP_SPEAKER_CONTROLS_HIDDEN_KEY = 'GroupSpeakerControlsHidden';
let selectedGroupSpeakerAvatar = '';
let groupSpeakerControlsInitialized = false;
let activeGroupTypingName = '';
let groupSpeakerAvatarRenderKey = '';

// SillyBunny: one extension at a time may plan who answers ordinary user messages; see group-turn-routing.js.
const groupTurnRouting = createGroupTurnRouting({ getScope: getGroupTurnRoutingScope });
const groupTurnRoutingApi = groupTurnRouting.api;

function getGroupTurnRoutingScope() {
    const group = selected_group ? groups.find(x => x.id === selected_group) : null;
    if (!group) {
        return null;
    }

    return {
        groupId: group.id,
        chatId: group.chat_id,
        strategy: Number(group.activation_strategy ?? group_activation_strategy.NATURAL),
        chat,
    };
}

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

function changeSelectedGroupSpeaker(avatarId) {
    if (selectedGroupSpeakerAvatar === avatarId) {
        return;
    }

    selectedGroupSpeakerAvatar = avatarId;
    eventSource.emit(event_types.GROUP_SPEAKER_SELECTION_CHANGED, avatarId);
}

/**
 * Picks who answers the next group message, the same way clicking the speaker bar does.
 * SillyBunny: exposed through getContext() so extensions such as Group Chat Overhaul can drive the bar.
 * @param {string} avatarId Avatar of an enabled member of the open group, or an empty string to clear the pick
 * @returns {boolean} True if the pick was applied
 */
function setSelectedGroupSpeakerAvatar(avatarId) {
    if (typeof avatarId !== 'string') {
        return false;
    }

    if (avatarId) {
        const group = selected_group ? groups.find(x => x.id === selected_group) : null;
        if (!getGroupEnabledMembers(group).includes(avatarId) || getCharacterIdByAvatar(avatarId) === -1) {
            return false;
        }
    }

    changeSelectedGroupSpeaker(avatarId);
    updateGroupSpeakerControls();
    return true;
}

function getSelectedGroupSpeakerChid(group) {
    if (!selectedGroupSpeakerAvatar) {
        return -1;
    }

    if (!getGroupEnabledMembers(group).includes(selectedGroupSpeakerAvatar)) {
        changeSelectedGroupSpeaker('');
        return -1;
    }

    return getCharacterIdByAvatar(selectedGroupSpeakerAvatar);
}

function buildGroupGreetingMessage(avatarId) {
    const character = characters[getCharacterIdByAvatar(avatarId)];
    if (!character) {
        return null;
    }

    const firstMes = character.first_mes || '';
    const alternateGreetings = character.data?.alternate_greetings;
    const message = {
        name: character.name,
        is_user: false,
        is_system: false,
        force_avatar: getThumbnailUrl('avatar', character.avatar),
        original_avatar: character.avatar,
        send_date: getMessageTimeStamp(),
        mes: getRegexedString(firstMes, regex_placement.AI_OUTPUT),
        extra: {},
    };

    if (Array.isArray(alternateGreetings) && alternateGreetings.length > 0) {
        const swipes = [message.mes, ...(alternateGreetings.map(greeting => getRegexedString(greeting, regex_placement.AI_OUTPUT)))];

        if (!message.mes) {
            swipes.shift();
            message.mes = swipes[0];
        }

        message.swipe_id = 0;
        message.swipes = swipes;
        message.swipe_info = swipes.map(_ => ({
            send_date: message.send_date,
            gen_started: void 0,
            gen_finished: void 0,
            extra: {},
        }));
    }

    return message.mes ? message : null;
}

function getGroupGreetingMember(group, preferredAvatar = '') {
    const members = getGroupEnabledMembers(group);
    const orderedMembers = members.includes(preferredAvatar)
        ? [preferredAvatar, ...members.filter(avatarId => avatarId !== preferredAvatar)]
        : members;

    for (const avatarId of orderedMembers) {
        const message = buildGroupGreetingMessage(avatarId);
        if (message) {
            return { avatarId, message };
        }
    }

    return null;
}

async function emitGroupGreetingMessageEvents(messageId) {
    await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'first_message');
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'first_message');
}

function addFreshGroupGreeting(group) {
    const greeting = getGroupGreetingMember(group, selectedGroupSpeakerAvatar);
    if (!greeting) {
        return -1;
    }

    const messageId = chat.length;
    chat.push(greeting.message);
    return messageId;
}

async function addSelectedGroupGreeting() {
    if (!selected_group || !selectedGroupSpeakerAvatar) {
        toastr.warning(t`Pick a group member first.`);
        return;
    }

    const group = groups.find(x => x.id === selected_group);
    if (!getGroupEnabledMembers(group).includes(selectedGroupSpeakerAvatar)) {
        changeSelectedGroupSpeaker('');
        updateGroupSpeakerControls();
        toastr.warning(t`Pick a group member first.`);
        return;
    }

    const message = buildGroupGreetingMessage(selectedGroupSpeakerAvatar);
    if (!message) {
        toastr.warning(t`Selected group member has no greeting.`);
        return;
    }

    const messageId = chat.length;
    chat.push(message);
    await saveGroupChat(selected_group, false);
    await printMessages();
    await emitGroupGreetingMessageEvents(messageId);
}

function buildContextAwareGroupPrompt(speakerName, options = {}) {
    const targetName = options.targetName || '';
    const targetText = targetName ? ` The immediate call or message is directed at ${speakerName} by ${targetName}; ${speakerName} should answer ${targetName}.` : '';
    return `[Group context: write only as ${speakerName}. Pay attention to who addressed whom in the recent chat. If the user calls for ${speakerName}, answer the user. If another character calls for ${speakerName}, answer that character. Characters may also talk to each other naturally when the context calls for it.${targetText}]`;
}

function findDirectlyAddressedMember(group, text) {
    const lowerText = String(text || '').toLowerCase();
    if (!lowerText || !group) {
        return -1;
    }

    for (const avatar of getGroupEnabledMembers(group)) {
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


function getMessageSpeakerName(message) {
    if (!message) return '';
    return message.is_user ? 'the user' : (message.name || 'another character');
}

function clearSelectedGroupSpeaker() {
    // Unhighlight first: a listener of the change event may already pick the next speaker.
    $('#group_speaker_controls .group_speaker_avatar').removeClass('selected');
    changeSelectedGroupSpeaker('');
}

function limitGroupSpeakersForControl(activatedMembers, forceSingleSpeaker) {
    if (!forceSingleSpeaker || activatedMembers.length <= 1) {
        return activatedMembers;
    }

    return activatedMembers.slice(0, 1);
}

function setGroupTypingIndicator(characterName = '') {
    const nextTypingName = String(characterName || '');
    activeGroupTypingName = nextTypingName;
    const indicator = $('#group_typing_indicator');
    if (!indicator.length) {
        return;
    }

    indicator.text(activeGroupTypingName ? `${activeGroupTypingName} is typing...` : '');
    indicator.toggleClass('displayNone', !activeGroupTypingName);
    $('#group_speaker_controls').toggleClass('is-typing', Boolean(activeGroupTypingName));
}

function isGroupSpeakerControlsHidden() {
    return accountStorage.getItem(GROUP_SPEAKER_CONTROLS_HIDDEN_KEY) === 'true';
}

function setGroupSpeakerControlsHidden(hidden) {
    accountStorage.setItem(GROUP_SPEAKER_CONTROLS_HIDDEN_KEY, String(Boolean(hidden)));
    updateGroupSpeakerControls();
}

function updateGroupSpeakerControls() {
    const container = $('#group_speaker_controls');
    if (!container.length) {
        return;
    }

    const group = selected_group ? groups.find(x => x.id === selected_group) : null;
    const members = getGroupEnabledMembers(group);
    const isAvailable = Boolean(group) && members.length > 0;
    const isHidden = isGroupSpeakerControlsHidden();
    container.toggleClass('displayNone', !isAvailable || isHidden);
    // The wand entry is injected later than this runs, so gate it with a body class instead of a direct toggle.
    // Keyed on the hidden flag alone: the way back must exist whenever the bar is hidden.
    document.body.classList.toggle('groupSpeakerControlsHidden', isHidden);
    if (!isAvailable) {
        clearSelectedGroupSpeaker();
        setGroupTypingIndicator('');
        groupSpeakerAvatarRenderKey = '';
        return;
    }

    // A pick from another group, or of a member muted since, can no longer answer here.
    if (selectedGroupSpeakerAvatar && !members.includes(selectedGroupSpeakerAvatar)) {
        changeSelectedGroupSpeaker('');
    }

    const avatarRenderKey = JSON.stringify({
        groupId: group.id,
        members,
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
            item.toggleClass('selected', avatarId === selectedGroupSpeakerAvatar);
            item.append($('<img alt="">').attr({
                src: getThumbnailUrl('avatar', avatarId),
                loading: 'lazy',
                decoding: 'async',
            }));
            item.append($('<span></span>').text(character.name));
            avatarList.append(item);
        }
    }

    container.find('.group_speaker_avatar').each(function () {
        const avatarId = String($(this).data('avatar') || '');
        $(this).toggleClass('selected', avatarId === selectedGroupSpeakerAvatar);
    });
}

function initGroupSpeakerControls() {
    if (groupSpeakerControlsInitialized) {
        return;
    }

    groupSpeakerControlsInitialized = true;
    const container = $('#group_speaker_controls');
    container.on('click', '.group_speaker_avatar', async function (event) {
        const avatarId = String($(this).data('avatar') || '');
        const alreadySelected = selectedGroupSpeakerAvatar === avatarId;
        changeSelectedGroupSpeaker(alreadySelected ? '' : avatarId);
        updateGroupSpeakerControls();

        if (event.shiftKey && selected_group) {
            const chid = getCharacterIdByAvatar(avatarId);
            if (chid !== -1) {
                Generate('normal', { force_chid: chid });
            }
        }
    });

    container.on('click', '#group_speaker_now', async function () {
        if (!selected_group || !selectedGroupSpeakerAvatar) {
            toastr.warning(t`Pick a group member first.`);
            return;
        }

        const chid = getCharacterIdByAvatar(selectedGroupSpeakerAvatar);
        if (chid !== -1) {
            Generate('normal', { force_chid: chid });
        }
    });

    container.on('click', '#group_add_greeting', addSelectedGroupGreeting);
    container.on('click', '#group_speaker_hide', () => setGroupSpeakerControlsHidden(true));
    $(document).on('click', '#wand_group_speaker_controls', () => setGroupSpeakerControlsHidden(false));
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

export const groupCandidatesFilter = new FilterHelper(debounce(printGroupCandidates, debounce_timeout.quick));
export const groupMembersFilter = new FilterHelper(debounce(printGroupMembers, debounce_timeout.quick));
const saveGroupDebounced = debounce(async (group, reload) => await _save(group, reload), debounce_timeout.relaxed);
/** @type {Map<string, number>} */
let groupChatQueueOrder = new Map();

/**
 * Saves a group to the server.
 * @param {Group} group Group object to save
 * @param {boolean} reload Whether to reload characters after saving
 */
async function _save(group, reload = true) {
    const response = await fetch('/api/groups/edit', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(group),
    });
    // SillyBunny: surface metadata-save failures so chat rename can roll back consistently.
    if (!response.ok) {
        throw new Error(`Could not save group ${group.id}.`);
    }
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
    // SillyBunny: marks the send as Regenerate, which a turn routing owner never plans.
    return generateGroupWrapper(false, 'normal', { signal: abortController.signal, isRegenerate: true });
}

/**
 * Loads group chat messages from the server.
 * @param {string} chatId Chat ID
 * @param {boolean} allowCreate Whether a missing file is an explicitly new chat
 * @returns {Promise<ChatFile>} Array of chat messages
 */
async function loadGroupChat(chatId, allowCreate = false) {
    const response = await fetchWithCsrfRetry('/api/chats/group/get', () => ({
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: chatId, allow_create: allowCreate }),
    }), { refreshCsrfToken });

    // SillyBunny: fail closed instead of replacing missing or corrupt persisted chat data with a greeting.
    if (!response.ok) {
        throw new Error(`Could not load group chat ${chatId}.`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
        throw new Error(`Invalid group chat data for ${chatId}.`);
    }
    return data;
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
        const response = await fetchWithCsrfRetry('/api/chats/group/info', () => ({
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ id: chatId }),
        }), { refreshCsrfToken });

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
 * @param {object} [options] Validation options
 * @param {boolean} [options.trustActiveChat=false] Whether to keep the active chat id even before its JSONL exists
 * @returns {Promise<void>}
 */
async function validateGroup(group, { trustActiveChat = false } = {}) {
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

        // SillyBunny: a newly-created group chat has no JSONL yet, so keep its active branch id.
        if (!trustActiveChat && presentChats.length && !presentChats.includes(String(group.chat_id ?? ''))) {
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
 * @param {boolean} [options.newlyCreated=false] Whether the active group chat was created before loading.
 * @returns {Promise<void>} A promise that resolves when the chat messages have been loaded.
 */
export async function getGroupChat(groupId, reload = false, { switchMenu = true, newlyCreated = false } = {}) {
    incrementChatGeneration();

    const group = groups.find((x) => x.id === groupId);
    if (!group) {
        console.warn('Group not found', groupId);
        return;
    }

    // Run validation before any loading
    await validateGroup(group, { trustActiveChat: newlyCreated });
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
    let data;
    try {
        data = await loadGroupChat(chat_id, newlyCreated || createdChat);
    } catch (error) {
        console.error(error);
        toastr.error(t`Could not load chat data. Try reloading the page.`);
        return;
    }
    const metadata = data?.[0]?.chat_metadata ?? {};

    // Remove chat file header if present
    if (Array.isArray(data) && data.length && Object.hasOwn(data[0], 'chat_metadata')) {
        data.shift();
    }

    // SillyBunny: initialize empty, untainted group chats even when the chat id was created before this load.
    const freshChat = !metadata.tainted && (!Array.isArray(data) || !data.length);

    // SillyBunny: no integrity slug means the server treats the file as intact and mints one on the
    // first real save. Stamping one in on load only dirtied legacy chats into a needless rewrite.
    await loadItemizedPrompts(getCurrentChatId());

    let freshGroupGreetingMessageId = -1;

    if (group && Array.isArray(group.members) && freshChat) {
        chat.splice(0, chat.length);
        chatElement.find('.mes').remove();
        freshGroupGreetingMessageId = addFreshGroupGreeting(group);
        metadata.tainted = true;
        updateChatMetadata(metadata, true);
        const savedFreshGroupChat = await saveGroupChat(groupId, false);
        if (savedFreshGroupChat && chat_metadata.integrity) {
            metadata.integrity = chat_metadata.integrity;
        }
        await printMessages();
    } else if (Array.isArray(data) && data.length) {
        chat.splice(0, chat.length, ...data);
        chat.forEach(ensureMessageMediaIsArray);
        chatElement.find('.mes').remove();
        await printMessages();
    }

    updateChatMetadata(metadata, true);

    if (reload && switchMenu) {
        select_group_chats(groupId, true);
    }

    await eventSource.emit(event_types.CHAT_CHANGED, getCurrentChatId());
    if (freshChat) await eventSource.emit(event_types.GROUP_CHAT_CREATED);
    if (freshGroupGreetingMessageId !== -1) await emitGroupGreetingMessageEvents(freshGroupGreetingMessageId);
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

function cloneGroupChatSavePayload(chatData) {
    return structuredClone(chatData);
}

function applyQueuedGroupChatIntegrity(metadata, chatId, isActiveGroupChatSave) {
    if (isActiveGroupChatSave && typeof chat_metadata.integrity === 'string' && chat_metadata.integrity) {
        metadata.integrity = chat_metadata.integrity;
        return;
    }

    const queuedIntegrity = chatId ? queuedGroupChatIntegrityByFile.get(chatId) : undefined;
    if (typeof queuedIntegrity === 'string' && queuedIntegrity) {
        metadata.integrity = queuedIntegrity;
    }
}

function rememberQueuedGroupChatIntegrity(chatId, integrity) {
    if (chatId && typeof integrity === 'string' && integrity) {
        queuedGroupChatIntegrityByFile.set(chatId, integrity);
    }
}

/**
 * Saves a group chat to the server.
 * @param {string} groupId Group ID
 * @param {boolean} shouldSaveGroup Whether to save the group after saving the chat
 * @param {boolean} force Force the saving on integrity error
 * @param {boolean} throwOnError Rethrow save errors after notifying the user
 * @param {object} [options] Additional save options
 * @param {boolean} [options.deferBackup] Save chat data without creating a regular chat backup yet
 * @returns {Promise<boolean>} A promise that resolves when the group chat has been saved.
 */
function saveGroupChat(groupId, shouldSaveGroup, force = false, throwOnError = false, options = {}) {
    const group = groups.find(x => x.id == groupId);
    if (!group) {
        console.warn('Group not found', groupId);
        return Promise.resolve(false);
    }

    const chatSnapshot = cloneGroupChatSavePayload(chat);
    const metadataSnapshot = structuredClone(chat_metadata);
    const chatIdSnapshot = group.chat_id;
    const currentGeneration = getChatGeneration();
    options = getChatBackupSaveOptions(options, JSON.stringify([groupId, chatIdSnapshot, currentGeneration]), uuidv4);
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
            deferBackup: Boolean(options.deferBackup),
            deferSequenceId: options.deferSequenceId,
            allowShrink: Boolean(options.allowShrink),
            scheduledGeneration: currentGeneration,
        }));

    groupChatSaveQueue = saveTask.catch(() => {});
    return saveTask;
}

/**
 * Waits for saves already queued on the serial group chat save queue to settle.
 * SillyBunny: group saves run on their own queue, so navigation has to drain it separately.
 * @returns {Promise<void>}
 */
export async function waitForQueuedGroupChatSaves() {
    for (let attempt = 0; attempt < 5; attempt++) {
        const queue = groupChatSaveQueue;
        await queue.catch(() => {});
        if (queue === groupChatSaveQueue) {
            return;
        }
    }
}

async function saveGroupChatImmediately({ groupId, shouldSaveGroup, force = false, throwOnError = false, chatId, chatData, metadata, deferBackup = false, deferSequenceId, allowShrink = false, scheduledGeneration }) {
    const group = groups.find(x => x.id == groupId);
    if (!group) {
        console.warn('Group not found', groupId);
        return false;
    }

    // SillyBunny: abort saves whose identity or generation changed while queued to prevent chat cloning.
    const abortReason = getQueuedChatSaveAbortReason({
        scheduledGroupId: groupId,
        currentGroupId: selected_group,
        scheduledChatId: chatId,
        currentChatId: group.chat_id,
        scheduledGeneration,
        currentGeneration: getChatGeneration(),
    });

    if (abortReason) {
        console.warn(`saveGroupChatImmediately aborted, but ${abortReason} changed while queued.`);
        return false;
    }

    if (chatId && Array.isArray(group.chats) && !group.chats.includes(chatId)) {
        group.chats.push(chatId);
        shouldSaveGroup = true;
    }
    group.date_last_chat = Date.now();
    const isActiveGroupChatSave = selected_group === groupId && group.chat_id === chatId;
    const metadataForSave = structuredClone(metadata || chat_metadata);
    applyQueuedGroupChatIntegrity(metadataForSave, chatId, isActiveGroupChatSave);
    /** @type {ChatHeader} */
    const chatHeader = {
        chat_metadata: metadataForSave,
        user_name: 'unused',
        character_name: 'unused',
    };
    const chatMessages = Array.isArray(chatData) ? chatData : cloneGroupChatSavePayload(chat);
    const savePayload = JSON.stringify({ id: chatId, chat: [chatHeader, ...chatMessages], force: force, deferBackup: Boolean(deferBackup), deferSequenceId, allowShrink: Boolean(allowShrink) });
    const buildSaveGroupChatRequest = () => compressRequest({
        method: 'POST',
        headers: getRequestHeaders(),
        body: savePayload,
    });
    // SillyBunny: rebuild compressed save requests after refreshing a stale CSRF token.
    const response = await fetchWithCsrfRetry('/api/chats/group/save', buildSaveGroupChatRequest, { refreshCsrfToken });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
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

        return await saveGroupChatImmediately({ groupId, shouldSaveGroup, force: true, throwOnError, chatId, chatData: chatMessages, metadata: metadataForSave, deferBackup, deferSequenceId, allowShrink, scheduledGeneration });
    }

    const responseData = await response.json().catch(() => ({}));
    rememberQueuedGroupChatIntegrity(chatId, responseData?.integrity);
    if (isActiveGroupChatSave && typeof responseData?.integrity === 'string' && responseData.integrity) {
        chat_metadata.integrity = responseData.integrity;
    }

    if (shouldSaveGroup) {
        // SillyBunny: strict saves cannot acknowledge deferred group metadata writes.
        if (throwOnError && !groups.some(candidate => candidate.id === group.id)) {
            throw new Error('Group not found');
        }
        await editGroup(throwOnError ? group.id : groupId, throwOnError, false);
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

                    // SillyBunny: extensions keep per-chat data about members who never wrote a line (for
                    // example which messages a member missed), so every chat of the group hears the rename.
                    // A listener that changes the chat calls markChanged() on the fourth argument to have it saved.
                    await eventSource.emit(event_types.CHARACTER_RENAMED_IN_PAST_CHAT, messages, oldAvatar, newAvatar, {
                        markChanged: () => { hadChanges = true; },
                    });

                    if (hadChanges) {
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
        $(template).children('.avatar, .missing-avatar').first().replaceWith(avatar);
    }

    return template;
}

/**
 * Updates the avatar display for a given group.
 * @param {Group} group Group object
 */
function updateGroupAvatar(group) {
    $('#group_avatar_preview').empty().append(getGroupAvatar(group));

    // SillyBunny: a create-mode draft has no id, and the old loose `data('id') == group.id`
    // matched the hidden #group_list_template row (undefined == null), stripping its
    // .avatar so every later getGroupBlock() clone rendered the blank placeholder.
    const groupId = group?.id === null || group?.id === undefined ? '' : String(group.id);
    if (groupId) {
        $('#rm_print_characters_block .group_select').each(function () {
            if ($(this).attr('data-grid') === groupId) {
                $(this).children('.avatar, .missing-avatar').first().replaceWith(getGroupAvatar(group));
            }
        });
    }

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
 * @param {boolean} byAutoMode If the generation was triggered programmatically.
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
    /** @type {import('./group-turn-routing.js').GroupRoutedTurn|null} */
    let routedTurn = null;

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
        const userInput = params.suppressUserMessage ? '' : String($('#send_textarea').val());

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
        const enabledMembers = getGroupEnabledMembers(group);
        let activatedMembers = [];

        const selectedSpeakerChid = getSelectedGroupSpeakerChid(group);
        const selectedSpeakerAvatar = selectedSpeakerChid !== -1 ? selectedGroupSpeakerAvatar : '';
        // Only a new reply answers as the pick and uses it up. Swipes and Continue redo or extend the last message,
        // and quiet or Impersonate generations never reply as a member, so they all leave the pick for the next reply.
        // Impersonate still borrows the picked member's card, as it did before the pick could be kept.
        const isNewReply = !['quiet', 'swipe', 'continue', 'impersonate'].includes(type);
        const usesPick = isNewReply || type === 'impersonate';
        const addressedMemberChid = findDirectlyAddressedMember(group, activationText);
        const isWholeGroupAddress = isAddressedToEntireGroup(activationText);
        // SillyBunny: an extension holding the turn routing lease plans who answers an ordinary user message, after
        // the message is saved. Forced speakers and the speaker bar pick still come first, and native routing answers
        // when it declines; native addressing is passed to the owner as a hint instead of taking the turn.
        const isRoutableSend = isUserInput && (!type || type === 'normal') && !params?.isRegenerate && !Array.isArray(params?.force_chids)
            && typeof params?.force_chid != 'number' && selectedSpeakerChid === -1;
        routedTurn = isRoutableSend ? groupTurnRouting.startTurn({ turnId: group_generation_id, text: userInput }) : null;
        if (params && Array.isArray(params.force_chids)) {
            activatedMembers = params.force_chids;
        } else if (params && typeof params.force_chid == 'number') {
            activatedMembers = [params.force_chid];
        } else if (type === 'swipe' || type === 'continue') {
            // SillyBunny: swipes and Continue redo or extend the last message, so its author writes them
            // even when that message or the composer names other members.
            activatedMembers = activateSwipe(enabledMembers, { allowSystem: false });

            if (activatedMembers.length === 0) {
                toastr.warning(t`Deleted group member swiped. To get a reply, add them back to the group.`);
                throw new Error('Deleted group member swiped');
            }
        } else if (type !== 'quiet' && isWholeGroupAddress && isUserInput) {
            activatedMembers = enabledMembers.map(avatar => getCharacterIdByAvatar(avatar)).filter(chid => chid !== -1);
        } else if (type !== 'quiet' && addressedMemberChid !== -1) {
            activatedMembers = [addressedMemberChid];
        } else if (usesPick && selectedSpeakerChid !== -1) {
            activatedMembers = [selectedSpeakerChid];
        } else if (type === 'quiet') {
            activatedMembers = activateSwipe(enabledMembers, { allowSystem: true }).slice(0, 1);

            if (activatedMembers.length === 0) {
                activatedMembers = activateListOrder(enabledMembers.slice(0, 1));
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

        const canUseMultiSpeakerTurn = (params && Array.isArray(params.force_chids)) || (isWholeGroupAddress && isUserInput);
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
            if (routedTurn) {
                // SillyBunny: sendMessageAsUser does not report whether its save went through, so a routed turn saves
                // again before the owner plans against the chat, and writes no replies when the save failed.
                const routedMembers = await routedTurn.prepare({
                    saved: await saveChatConditional(),
                    loadMembers: () => unshallowGroupMembers(group.id),
                    resolveMember: avatar => enabledMembers.includes(avatar) ? getCharacterIdByAvatar(avatar) : -1,
                    addressed: { avatar: characters[addressedMemberChid]?.avatar, wholeGroup: isWholeGroupAddress },
                    // Each reply runs under its member's model override, which decides whether it can call tools.
                    canCallTools: chId => runWithGroupMemberModelOverride(group, characters[chId].avatar, () => ToolManager.canPerformToolCalls('normal')),
                });
                if (routedMembers) {
                    activatedMembers = routedMembers;
                } else {
                    routedTurn = null;
                }
            }
            $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(resolve => requestAnimationFrame(resolve));
        }

        if (activatedMembers.length === 0) {
            routedTurn?.finish('success');
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
            const avatar = characters[chId]?.avatar;
            // SillyBunny: a routed turn stops before the next reply once its owner cancels it or its plan goes stale.
            if (routedTurn && !routedTurn.startReply(avatar)) {
                break;
            }
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
            const contextPrompt = buildContextAwareGroupPrompt(characters[chId]?.name || 'the selected speaker', {
                targetName: addressedMemberChid === chId ? getMessageSpeakerName(lastMessage) : '',
            });
            const mergedParams = { ...(params || {}) };
            mergedParams.quiet_prompt = [mergedParams.quiet_prompt, contextPrompt].filter(Boolean).join('\n');
            mergedParams.quietToLoud = true;
            mergedParams.suppressUserMessage = didRenderUserMessage || mergedParams.suppressUserMessage;
            if (routedTurn) {
                // Each planned member writes one reply, which auto-continue or auto-swipe would add to or redo.
                mergedParams.suppressAutoContinue = true;
                mergedParams.suppressAutoSwipe = true;
            }
            const replyStart = chat.length;
            textResult = await runWithGroupMemberModelOverride(group, characters[chId]?.avatar, () => Generate(generateType, { automatic_trigger: byAutoMode, ...mergedParams }));
            let messageChunk = textResult?.messageChunk;

            if (messageChunk) {
                while (shouldAutoContinue(messageChunk, type === 'impersonate', mergedParams)) {
                    textResult = await runWithGroupMemberModelOverride(group, characters[chId]?.avatar, () => Generate('continue', { automatic_trigger: byAutoMode, ...mergedParams, companionHistoryTarget: undefined }));
                    messageChunk = textResult?.messageChunk;
                }
            }

            if (power_user.show_group_chat_queue) {
                groupChatQueueOrder.delete(characters[chId].avatar);
                groupChatQueueOrder.forEach((value, key, map) => map.set(key, value - 1));
            }
            setGroupTypingIndicator('');

            if (routedTurn && !routedTurn.finishReply(avatar, getRoutedReplyStatus(chat.slice(replyStart), avatar, Boolean(params.signal?.aborted)))) {
                break;
            }
        }

        routedTurn?.finish('success');

        // A pick made while this reply was being written is meant for the reply after it.
        if (selectedSpeakerChid !== -1 && isNewReply && !(params && typeof params.force_chid == 'number')
            && selectedGroupSpeakerAvatar === selectedSpeakerAvatar) {
            clearSelectedGroupSpeaker();
        }
    } finally {
        // SillyBunny: a routed turn always ends, even when Stop or an error cuts it short.
        routedTurn?.finish(params.signal?.aborted ? 'cancelled' : 'failed');
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

/**
 * Modifies a group member by adding or removing them.
 * @param {string} groupId Group ID
 * @param {JQuery<HTMLElement>} groupMember Group member element
 * @param {boolean} isDelete If true, removes the member; otherwise adds the member
 */
async function modifyGroupMember(groupId, groupMember, isDelete) {
    const id = groupMember.data('id') ?? groupMember.attr('data-avatar');
    if (!id) return;

    const action = isDelete ? 'remove' : 'add';
    const unshallow = () => isDelete ? Promise.resolve() : unshallowGroupMembers(groupId);

    // SillyBunny: an owned no-op must not escape the explicit-save draft.
    const draftAction = _applyMemberActionToEditor(action, id, groupId);
    if (draftAction.owned) {
        if (draftAction.changed) await unshallow();
    } else {
        // No editor owns this group: write straight through, as upstream did.
        const thisGroup = groups.find((x) => x.id == groupId);
        if (thisGroup && applyMemberAction(thisGroup, action, id)) {
            await unshallow();
            if (openGroupId) {
                await editGroup(openGroupId, false, false);
                updateGroupAvatar(thisGroup);
            }
        }
    }

    // SillyBunny: data changes synchronously; only the resulting list paint is animated.
    printGroupCandidates({ animate: true });
    printGroupMembers({ animate: true });

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
    const id = groupMember.data('id') ?? groupMember.attr('data-avatar');
    const groupLike = editorDraft ?? groups.find((x) => x.id == groupId);
    const members = groupLike?.members;
    if (!Array.isArray(members)) return;

    const from = members.indexOf(id);
    const to = direction === 'down' ? from + 1 : from - 1;
    if (from === -1) return;

    moveGroupMemberInEditor(groupLike, from, to);
    printGroupMembers({ animate: true });
}

/**
 * Move a member within the editor's draft when it owns the group, otherwise
 * write the reordered array straight to the live group.
 * @param {Group|GroupDraft} groupLike
 * @param {number} from
 * @param {number} to
 */
function moveGroupMemberInEditor(groupLike, from, to) {
    if (groupLike === editorDraft) {
        _editDraft((draft) => moveGroupMember(draft, from, to));
        return;
    }
    if (moveGroupMember(groupLike, from, to) && openGroupId) {
        editGroup(openGroupId, false, false);
        updateGroupAvatar(groupLike);
    }
}

async function onGroupActivationStrategyInput(e) {
    const value = Number(e.target.value);

    if (_editDraft((draft) => { draft.activation_strategy = value; return true; })) {
        // A turn routing lease ends when its group's reply strategy changes.
        groupTurnRouting.refresh();
        toggleHiddenControls(editorDraft);
        return;
    }
    if (!openGroupId) return;

    const _thisGroup = groups.find((x) => x.id == openGroupId);
    if (!_thisGroup) return;
    _thisGroup.activation_strategy = value;
    groupTurnRouting.refresh();
    await editGroup(openGroupId, false, false);
}

async function onGroupGenerationModeInput(e) {
    const value = Number(e.target.value);

    if (_editDraft((draft) => { draft.generation_mode = value; return true; })) {
        toggleHiddenControls(editorDraft);
        return;
    }
    if (!openGroupId) return;

    const _thisGroup = groups.find((x) => x.id == openGroupId);
    if (!_thisGroup) return;
    _thisGroup.generation_mode = value;
    await editGroup(openGroupId, false, false);
    toggleHiddenControls(_thisGroup);
}

async function onGroupGenerationModeTemplateInput(e) {
    const prop = $(e.target).attr('setting');
    const value = String(e.target.value);
    if (!prop) return;

    if (_editDraft((draft) => { draft[prop] = value; return true; }, { immediate: false })) return;
    if (!openGroupId) return;

    const _thisGroup = groups.find((x) => x.id == openGroupId);
    if (!_thisGroup) return;
    _thisGroup[prop] = value;
    await editGroup(openGroupId, false, false);
}

async function onGroupNameInput() {
    const value = String($(this).val() ?? '');

    if (_editDraft((draft) => { draft.name = value; return true; }, { immediate: false })) {
        updateGroupHeaderTitle(value);
        return;
    }
    if (!openGroupId) return;

    const _thisGroup = groups.find((x) => x.id == openGroupId);
    if (!_thisGroup) return;
    _thisGroup.name = value;
    updateGroupHeaderTitle(value);
    await editGroup(openGroupId, false);
}

/**
 * Renames the open group. The legacy flow showed an input popup; the editor's
 * header title is the rename affordance now, so this focuses it and leaves the
 * name as an ordinary unsaved edit.
 */
async function renameOpenGroup() {
    if (menu_type !== 'group_edit' || !openGroupId) {
        return;
    }

    const group = groups.find((x) => x.id == openGroupId);
    if (!group) {
        return;
    }

    const titleButton = document.getElementById('sb_group_editor_title_button');
    if (titleButton && !titleButton.disabled) {
        titleButton.click();
        return;
    }

    // Fallback for a group editor that is not mounted (embedded hosts, tests).
    const newName = await callGenericPopup('<h3>' + t`New name:` + '</h3>', POPUP_TYPE.INPUT, getEditedGroup()?.name ?? group.name);
    if (!newName || newName === group.name) {
        return;
    }

    if (_editDraft((draft) => { draft.name = String(newName); return true; })) {
        writeGroupEditorFields(editorDraft);
        updateGroupHeaderTitle(String(newName));
        return;
    }

    group.name = String(newName);
    writeGroupEditorFields(group);
    await editGroup(openGroupId, true, true);
}

// SillyBunny: the group editor controller is initialised from this module's own
// ready handler, so it no longer needs a global bridge (Step 4).

/**
 * Checks if a character with the given avatar ID is a member of the group.
 * @param {Group} group Group object
 * @param {string} avatarId Avatar ID to check
 * @returns {boolean} True if the avatar is a member of the group, false otherwise
 */
function isGroupMember(group, avatarId) {
    if (group && Array.isArray(group.members)) {
        return group.members.includes(avatarId);
    }
    return Boolean(editorDraft?.members?.includes(avatarId));
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
        const membersArray = thisGroup?.members ?? editorDraft?.members ?? [];

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

    // The editor's draft is the visible truth while an unsaved session owns the
    // group, so the member lists must filter against it rather than groups[].
    const thisGroup = getEditedGroup();

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

function printGroupCandidates({ animate = false } = {}) {
    const storageKey = 'GroupCandidates_PerPage';
    const pageSize = Number(accountStorage.getItem(storageKey)) || 5;
    const sizeChangerOptions = [5, 10, 25, 50, 100, 200, 500, 1000];
    const rows = document.getElementById('rm_group_add_members');
    const pagination = $('#rm_group_add_members_pagination');
    const previousPage = pagination.data('pagination')?.model?.pageNumber;
    const render = () => pagination.pagination({
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
        callback: function (data, model) {
            const renderRows = () => {
                $(rows).empty();
                for (const i of data) {
                    $(rows).append(getGroupCharacterBlock(i.item));
                }
                localizePagination(pagination);
            };
            const pageChanged = !animate && previousPage !== undefined && previousPage !== model.pageNumber;
            if (pageChanged) {
                animateListChange(rows, renderRows, { duration: MOTION_FAST, enterDuration: MOTION_FAST });
                return;
            }
            renderRows();
        },
    });

    if (!animate) return render();
    return animateListChange(rows, render);
}

function printGroupMembers({ animate = false } = {}) {
    const storageKey = 'GroupMembers_PerPage';
    const render = () => {
        $('.rm_group_members_pagination').each(function () {
            const pagination = $(this);
            const previousPage = pagination.data('pagination')?.model?.pageNumber;
            const pageSize = Number(accountStorage.getItem(storageKey)) || 5;
            const sizeChangerOptions = [5, 10, 25, 50, 100, 200, 500, 1000];
            pagination.pagination({
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
                callback: function (data, model) {
                    const renderRows = () => {
                        const order = getEditedGroup()?.members ?? [];
                        $('.rm_group_members').empty();
                        for (const i of data) {
                            $('.rm_group_members').append(getGroupCharacterBlock(i.item, { draftIndex: order.indexOf(i.item.avatar), grip: true }));
                        }
                        localizePagination(pagination);
                        syncGroupMembersFilteredState();
                    };
                    const pageChanged = !animate && previousPage !== undefined && previousPage !== model.pageNumber;
                    if (pageChanged) {
                        animateMemberListRender(renderRows, { duration: MOTION_FAST, enterDuration: MOTION_FAST });
                        return;
                    }
                    renderRows();
                },
            });
        });
    };

    if (!animate) return render();
    return animateMemberListRender(render);
}

function getMemberRowsContainers() {
    return Array.from(document.querySelectorAll('.rm_group_members'));
}

function animateMemberListRender(render, options = {}) {
    const snapshots = getMemberRowsContainers()
        .map(container => captureListChange(container, options));
    const result = render();
    const apply = () => snapshots.forEach(snapshot => applyListChange(snapshot, options));
    if (result && typeof result.then === 'function') {
        return result.then(value => {
            apply();
            return value;
        });
    }
    apply();
    return result;
}

/**
 * Creates a jQuery element representing a group character block.
 * @param {Character} character Character object
 * @param {object} [options]
 * @param {number} [options.draftIndex] Position the row holds in the editor's draft, or -1.
 * @param {boolean} [options.grip] Add the drag handle. Only the reorderable current-members list wants one.
 * @returns {JQuery<HTMLElement>} jQuery element representing the group character block
 */
function getGroupCharacterBlock(character, { draftIndex = -1, grip = false } = {}) {
    const avatar = getThumbnailUrl('avatar', character.avatar);
    const template = $('#group_member_template .group_member').clone();
    const isFav = !!character.fav || character.fav == 'true';
    template.data('id', character.avatar);
    // SillyBunny: the avatar id also lives in the DOM, because the member-list
    // popout is built by cloning these rows and jQuery's data store is not
    // copied with them - the row buttons would then act on `undefined`.
    template.attr('data-avatar', character.avatar);
    // Only the editor's drag-to-reorder reads this: it maps the rows on screen
    // back to the positions they hold in the draft.
    template.attr('data-sb-member-index', String(draftIndex));
    // Appended here rather than shipped in the shared template so the add-members
    // list and the detached popout never render a handle they cannot use.
    if (grip) {
        template.prepend('<div class="sb-group-member-grip ds-entity-row__grip fa-solid fa-grip-vertical" aria-hidden="true"></div>');
    }
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

    // SillyBunny: the switch and menu replace the legacy icon strip on both lists.
    const repliesEnabled = !isGroupMemberDisabled(character.avatar);
    template.toggleClass('disabled', !repliesEnabled);
    const thisGroup = getEditedGroup();
    const isMember = isGroupMember(thisGroup, character.avatar);
    template.toggleClass('sb-group-candidate ds-entity-row--activatable', !isMember);
    template.find('.sb-group-member-switch').prop('checked', repliesEnabled).attr({
        'aria-label': t`Replies from ${character.name}`,
        'aria-checked': String(repliesEnabled),
        'data-action': repliesEnabled ? 'disable' : 'enable',
    });
    template.find('.sb-group-member-menu').attr('aria-label', t`Member actions`);
    template.find('[data-action="add"]').attr('aria-label', t`Add to group`);
    const model = isMember ? getGroupMemberModel(thisGroup, character.avatar) : '';
    template.find('.sb-group-member-model').text(model ? t`Model: ${model}` : '');
    template.find('.ds-entity-row__subtitle').toggle(Boolean(auxFieldValue || model));

    // Display inline tags
    const tagsElement = template.find('.tags').addClass('ds-tag-chips');
    printTagList(tagsElement, { forEntityOrKey: characters.indexOf(character), tagOptions: { isCharacterList: true } });

    // Speak only means something for a persisted group.
    if (!openGroupId) {
        template.find('[data-action="speak"]').hide();
    }

    return template;
}

/**
 * Checks if a group member is disabled.
 * @param {string} avatarId Avatar ID of the group member
 * @returns {boolean} True if the group member is disabled, false otherwise
 */
function isGroupMemberDisabled(avatarId) {
    const thisGroup = getEditedGroup();
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
    if (isGroupEditorActive()) {
        _editDraft((draft) => { draft.fav = fav_grp_checked; return true; });
        favsToHotswap();
        return;
    }
    if (openGroupId) {
        const _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.fav = fav_grp_checked;
        await editGroup(openGroupId, false, false);
        favsToHotswap();
    }
}

async function onGroupSelfResponsesClick() {
    const value = $(this).prop('checked');
    if (isGroupEditorActive()) {
        _editDraft((draft) => { draft.allow_self_responses = value; return true; });
        return;
    }
    if (openGroupId) {
        const _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.allow_self_responses = value;
        await editGroup(openGroupId, false, false);
    }
}

async function onHideMutedSpritesClick(value) {
    if (isGroupEditorActive()) {
        _editDraft((draft) => { draft.hideMutedSprites = value; return true; });
        await eventSource.emit(event_types.GROUP_UPDATED);
        return;
    }
    if (openGroupId) {
        const _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.hideMutedSprites = value;
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
    const mode = generationMode ?? group?.generation_mode;
    const isJoin = [group_generation_mode.APPEND, group_generation_mode.APPEND_DISABLED].includes(Number(mode));
    $('#group_join_templates').toggle(isJoin);

    // Allow-self-responses only applies to natural order, so the row follows the
    // strategy rather than the generation mode.
    const isNatural = Number(group?.activation_strategy ?? group_activation_strategy.NATURAL) === group_activation_strategy.NATURAL;
    $('#rm_group_allow_self_responses_row').toggle(isNatural);

    if (isJoin && !CSS.supports('field-sizing', 'content')) {
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
    // SillyBunny: the member-list styles are a deferred stylesheet (frontend budget);
    // it is preloaded, so activating it here applies before the rows paint.
    window.SillyBunnyLoadStylesheet?.();
    const loadResult = beginGroupEditorLoad(groupId ?? null);
    openGroupId = groupId;
    const group = openGroupId && groups.find((x) => x.id == openGroupId);

    // SillyBunny: re-selecting the group the editor already owns only reconciles
    // the pending draft with the live group. Nothing is reset, so an unsaved
    // draft neither loses its edits nor scrolls the panel back to the top.
    const reconciled = loadResult === 'reconciled';
    if (reconciled) {
        if (group) reconcileEditorDraft(group);
        else syncGroupEditorFields();
    } else {
        resetEditorDraft(group);
    }

    const groupName = group?.name ?? '';

    setMenuType(group ? 'group_edit' : 'group_create');

    if (!skipAnimation) {
        selectRightMenuWithAnimation('rm_group_chats_block');
    }

    if (!reconciled) {
        $('#rm_group_filter').val('').trigger('input');
        $('#rm_group_members_filter').val('').trigger('input');
        $('#group_avatar_preview').empty().append(getGroupAvatar(group));
        $('#rm_group_restore_avatar').toggle(!!group && isValidImageUrl(group.avatar_url));
    }

    // The draft is the truth for every editable field; writeGroupEditorFields()
    // skips values that already match, so a reconcile does not disturb what the
    // user is currently typing into.
    writeGroupEditorFields(editorDraft ?? group);

    // render tags
    applyTagsOnGroupSelect(groupId);

    // render characters list
    printGroupCandidates();
    printGroupMembers();

    updateGroupSubmitState();

    // Bottom buttons and the ⋯ menu's entries. Overrides and Lorebook only apply
    // to a group that exists, so their whole section hides in create mode.
    const isEdit = Boolean(group);
    $('#rm_group_submit').toggle(!isEdit);
    $('#rm_group_delete').toggle(isEdit);
    $('#rm_group_chats_block [data-sb-section="overrides"]').toggle(isEdit);
    $('#rm_group_chats_block [data-sb-section="lorebook"]').toggle(isEdit);
    updateGroupAvatar(editorDraft ?? group);

    updateFavButtonState(Boolean(editorDraft?.fav ?? group?.fav));

    // top bar
    if (group) {
        updateGroupHeaderTitle(groupName);
    }

    // Toggle textbox sizes, as input events have not fired here
    if (!CSS.supports('field-sizing', 'content')) {
        $('#rm_group_chats_block .autoSetHeight').each(element => {
            resetScrollHeight(element);
        });
    }

    hideMutedSprites = Boolean(editorDraft?.hideMutedSprites ?? group?.hideMutedSprites);

    updateGroupSpeakerControls();
    eventSource.emit('groupSelected', { detail: { id: openGroupId, group: group } });
    // SillyBunny: open the explicit-save editor session once the fields are set
    if (openGroupId) {
        openGroupEditorSession(openGroupId);
    } else {
        openGroupEditorCreateSession();
    }
}

/**
 * The member list's order is the saved order while a filter is active, so the
 * drag handle is inert then. Mirrors the condition used for the filter-based
 * sort in getGroupCharacters().
 */
function syncGroupMembersFilteredState() {
    $('#rm_group_members').toggleClass('is-filtered', Boolean($('#rm_group_members_filter').val()));
}

/**
 * Create is only possible with at least one member, so the Create button in the
 * header follows the draft's member count.
 */
function updateGroupSubmitState() {
    const groupHasMembers = getGroupCharacters({ doFilter: false, onlyMembers: true }).length > 0;
    $('#rm_group_submit').prop('disabled', !groupHasMembers);
}

/**
 * Mirrors isExternalMediaAllowed() into the editor's External media row.
 */
function _syncGroupMediaOverrideIcons() {
    const isMediaAllowed = isExternalMediaAllowed();
    $('#group_media_allowed_icon').toggle(isMediaAllowed);
    $('#group_media_forbidden_icon').toggle(!isMediaAllowed);
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

    const draft = editorDraft;
    const groupId = openGroupId;
    const result = await getBase64Async(file);

    $('#dialogue_popup').addClass('large_dialogue_popup wide_dialogue_popup');

    const croppedImage = power_user.never_resize_avatars ? result :
        await callGenericPopup('Set the crop position of the avatar image', POPUP_TYPE.CROP, '', { cropImage: result });

    if (!croppedImage) {
        return;
    }

    let thumbnail = await createThumbnail(String(croppedImage), 300, 300);
    //remove data:image/whatever;base64
    thumbnail = thumbnail.replace(/^data:image\/[a-z]+;base64,/, '');
    // filename should be group id + human readable timestamp
    const filename = groupId ? `${groupId}_${humanizedDateTime()}` : humanizedDateTime();
    let thumbnailUrl = await saveBase64AsFile(thumbnail, String(groupId ?? ''), filename, 'jpg');
    if (!groupId) {
        // Create mode: the preview follows the draft, which carries the avatar
        // into the create payload.
        if (editorDraft !== draft || !draft) return;
        draft.avatar_url = thumbnailUrl;
        writeGroupEditorFields(draft);
        return;
    }

    // Uploading is its own endpoint, so it writes the live group directly; the
    // draft and the editor's baseline follow, otherwise Save would consider the
    // new avatar an unsaved change. The baseline is taken from the group rather
    // than from the draft, so any other pending edit stays unsaved.
    const group = groups.find((x) => x.id == groupId);
    if (!group) return;
    group.avatar_url = thumbnailUrl;
    const savedSnapshot = createEditorDraft(group);
    if (editorDraft === draft && draft) {
        draft.avatar_url = thumbnailUrl;
        writeGroupEditorFields(draft);
    }
    await editGroup(groupId, true, true);
    if (editorDraft === draft && isGroupEditorOwner(groupId)) rebaseGroupEditor(savedSnapshot);
}

async function restoreGroupAvatar() {
    const draft = editorDraft;
    const groupId = openGroupId;
    const confirm = await Popup.show.confirm('Are you sure you want to restore the group avatar?', 'Your custom image will be deleted, and a collage will be used instead.');
    if (!confirm) {
        return;
    }

    if (!groupId) {
        if (editorDraft !== draft || !draft) return;
        draft.avatar_url = '';
        writeGroupEditorFields(draft);
        return;
    }

    const group = groups.find((x) => x.id == groupId);
    if (!group) return;
    group.avatar_url = '';
    const savedSnapshot = createEditorDraft(group);
    if (editorDraft === draft && draft) {
        draft.avatar_url = '';
        writeGroupEditorFields(draft);
    }
    await editGroup(groupId, true, true);
    if (editorDraft === draft && isGroupEditorOwner(groupId)) rebaseGroupEditor(savedSnapshot);
}

async function onGroupActionClick(event) {
    event.stopPropagation();
    const action = $(this).data('action');
    const member = $(this).closest('.group_member');
    await runGroupMemberAction(action, member);
}

// SillyBunny: delegated clicks, switches and menus use one action path, including
// detached rows whose jQuery data store was not copied by the popout.
async function runGroupMemberAction(action, member) {
    const focus = captureGroupMemberFocus(member);
    if (action === 'remove') {
        await modifyGroupMember(openGroupId, member, true);
    }

    if (action === 'add') {
        await modifyGroupMember(openGroupId, member, false);
    }

    if (action === 'enable' || action === 'disable') {
        const avatarId = member.data('id') ?? member.attr('data-avatar');
        const rows = $('.group_member').filter(function () {
            return ($(this).data('id') ?? $(this).attr('data-avatar')) === avatarId;
        });
        rows.toggleClass('disabled', action === 'disable');
        rows.find('.sb-group-member-switch').prop('checked', action === 'enable')
            .attr('aria-checked', String(action === 'enable')).attr('data-action', action === 'enable' ? 'disable' : 'enable');
        if (isGroupEditorActive()) {
            _editDraft((draft) => applyMemberAction(draft, action, avatarId));
        } else if (openGroupId) {
            const _thisGroup = groups.find(x => x.id === openGroupId);
            const index = _thisGroup.disabled_members.indexOf(avatarId);
            if (action === 'enable' && index !== -1) {
                _thisGroup.disabled_members.splice(index, 1);
            } else if (action === 'disable' && index === -1) {
                _thisGroup.disabled_members.push(avatarId);
            } else {
                return;
            }
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
    if (['up', 'down', 'remove', 'enable', 'disable'].includes(action)) {
        restoreGroupMemberFocus(focus, {
            removed: action === 'remove',
            control: action === 'enable' || action === 'disable' ? '.sb-group-member-switch' : '.sb-group-member-menu',
        });
    }
}

// SillyBunny: use DOM identity and the originating list so re-rendered controls
// regain focus in the sheet or its HTML-only popout, never in a newer session.
function captureGroupMemberFocus(member) {
    const list = member[0]?.closest('.rm_group_members');
    return {
        list,
        avatar: member.data('id') ?? member.attr('data-avatar'),
        index: list ? Array.from(list.querySelectorAll('.group_member')).indexOf(member[0]) : -1,
        draft: editorDraft,
        groupId: openGroupId,
    };
}

function restoreGroupMemberFocus(focus, { removed = false, control = '.sb-group-member-menu' } = {}) {
    if (!focus.list?.isConnected || focus.draft !== editorDraft || focus.groupId !== openGroupId) return;
    const rows = Array.from(focus.list.querySelectorAll('.group_member'));
    const member = removed
        ? rows[Math.min(focus.index, rows.length - 1)]
        : rows.find(row => row.getAttribute('data-avatar') === focus.avatar);
    const target = member?.querySelector(control)
        ?? focus.list.closest('.ds-entity-list')?.querySelector('[id="rm_group_members_filter"]');
    target?.focus({ preventScroll: true });
}

function isGroupCandidateRowClick(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    // SillyBunny: a11y marks static chips as buttons too; only actionable chips
    // (including the tag expander) and actual controls consume the row click.
    return Boolean(target && !target.closest('.right_menu_button, input, button, select, textarea, a, label, [role="button"]:not(.tag), .tag:is(.actionable, .clickable-action, .placeholder-expander, .interactable), .tag_remove'));
}

async function onGroupCandidateRowClick(event) {
    if (!isGroupCandidateRowClick(event)) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    await runGroupMemberAction('add', $(this));
}

async function onGroupMemberSwitchChange() {
    await runGroupMemberAction(this.checked ? 'enable' : 'disable', $(this).closest('.group_member'));
}

function onGroupMemberMenuClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const member = $(this).closest('.group_member');
    const avatarId = member.data('id') ?? member.attr('data-avatar');
    const order = getEditedGroup()?.members ?? [];
    const index = order.indexOf(avatarId);
    if (index < 0) return;

    const actionItem = (label, icon, action, extra = {}) => ({
        label,
        icon: `fa-solid fa-${icon}`,
        onSelect: () => void runGroupMemberAction(action, member),
        ...extra,
    });
    const actions = [];
    if (openGroupId) actions.push(actionItem(t`Speak now`, 'comment', 'speak'));
    actions.push(actionItem(t`View character`, 'image-portrait', 'view'));
    actions.push({ label: t`Model override…`, icon: 'fa-solid fa-microchip', onSelect: () => void editGroupMemberModel(member) });
    openActionMenu({
        trigger: this,
        title: member.find('.ch_name').text(),
        sections: [
            { items: actions },
            { items: [
                actionItem(t`Move up`, 'arrow-up', 'up', { disabled: index === 0 }),
                actionItem(t`Move down`, 'arrow-down', 'down', { disabled: index === order.length - 1 }),
            ] },
            { items: [actionItem(t`Remove`, 'minus', 'remove', { danger: true })] },
        ],
    });
}

/**
 * Apply a member action to the editor's draft when the editor owns this group.
 * Draft edits are never written to groups[]; Save does that.
 * @param {'add'|'remove'|'enable'|'disable'} action
 * @param {string} avatarId
 * @param {string|null} [groupId] Group whose member is being changed
 * @returns {{ owned: boolean, changed: boolean }} Ownership is independent of mutation.
 */
function _applyMemberActionToEditor(action, avatarId, groupId = openGroupId) {
    if (!editorDraft) return { owned: false, changed: false };
    // Create mode has no group id yet, so the draft is the only owner.
    if (groupId && String(editorDraft.id) !== String(groupId)) return { owned: false, changed: false };
    return { owned: true, changed: _editDraft((draft) => applyMemberAction(draft, action, avatarId)) };
}

/**
 * Reorder the editor's members to match a drag in the rendered list.
 * @param {number[]} from  Draft indices of the dragged rows, in their old on-screen order.
 * @param {number[]} to    The same indices in their new on-screen order.
 * @returns {boolean} true when the draft changed
 */
function reorderMembersByIndices(from, to) {
    if (from.length !== to.length || !from.length) return false;
    const moved = _editDraft((draft) => {
        if (!Array.isArray(draft.members)) return false;
        // The dragged rows keep the slot numbers they came from; only which
        // member sits in them changes. `from` arrives in ascending slot order
        // because the rendered list is sorted by slot, so position p maps to
        // slot from[p] and takes the member that now sits at to[p]. Sort the
        // slots before writing so a drag that moves rows upward cannot overwrite
        // a value it still needs.
        const slots = [...from].sort((a, b) => a - b);
        const values = to.map((index) => draft.members[index]);
        if (values.some((value) => value === undefined)) return false;
        if (slots.every((slot, position) => draft.members[slot] === values[position])) return false;
        slots.forEach((slot, position) => { draft.members[slot] = values[position]; });
        return true;
    });

    if (moved) printGroupMembers({ animate: true });
    return moved;
}

/**
 * Run a mutation against the draft and report it to the editor. Every
 * editor-owned handler funnels through here, so "the draft changed" and "the
 * editor is dirty" can never drift apart.
 * @param {(draft: GroupDraft) => boolean} mutate  Returns true when it changed something.
 * @param {{ immediate?: boolean }} [options]
 * @returns {boolean} true when the draft changed
 */
function _editDraft(mutate, options = { immediate: true }) {
    if (!editorDraft || !mutate(editorDraft)) return false;
    notifyGroupEditorChanged(options);
    return true;
}

/**
 * Saves the editor's draft to an existing group. The caller (the shared editor
 * session) owns the timing; this only performs the write.
 *
 * Live-only fields the draft does not cover (chat_id, chats, conversation
 * settings, tag maps) are never touched. The live object only adopts values
 * after confirmation, so a reselect during the request cannot baseline them.
 * @param {string} groupId
 * @param {GroupDraft} snapshot
 * @returns {Promise<boolean>} whether the save landed
 */
async function saveDraft(groupId, snapshot) {
    const group = groups.find((x) => x.id == groupId);
    if (!group || !snapshot || String(snapshot.id) !== String(groupId)) return false;
    const submittedGroup = { ...group };
    applyDraftToGroup(submittedGroup, snapshot);
    await _save(submittedGroup);
    applyDraftToGroup(group, snapshot);
    // A turn routing lease ends when its group's reply strategy changes.
    groupTurnRouting.refresh();
    favsToHotswap();
    if (isGroupEditorOwner(groupId)) {
        updateGroupAvatar(editorDraft);
        updateGroupHeaderTitle(editorDraft.name);
        hideMutedSprites = Boolean(editorDraft.hideMutedSprites);
    }
    await eventSource.emit(event_types.GROUP_UPDATED);
    return true;
}

/**
 * The group editor's draft as the shared session sees it: the same object the
 * controller baselines, backs up every 5s, and compares for dirtiness.
 * @returns {object}
 */
function captureEditorSnapshot() {
    return editorDraft ? structuredClone(editorDraft) : {};
}

/**
 * Write a snapshot back into the editor: draft first, then the fields, so the
 * two never disagree. Does not mark anything dirty.
 * @param {object} snapshot
 */
function applyEditorSnapshot(snapshot) {
    if (!editorDraft || !snapshot) return;
    // v1 backups from the DOM-based controller used field IDs and underscored
    // member keys. Only known editable values may cross the restore boundary.
    const legacyKeys = {
        name: 'rm_group_chat_name',
        activation_strategy: 'rm_group_activation_strategy',
        generation_mode: 'rm_group_generation_mode',
        generation_mode_join_prefix: 'rm_group_generation_mode_join_prefix',
        generation_mode_join_suffix: 'rm_group_generation_mode_join_suffix',
        allow_self_responses: '_allow_self',
        hideMutedSprites: '_hide_muted',
        fav: '_fav',
        members: '_members',
        disabled_members: '_disabled',
        member_models: '_models',
    };
    for (const key of EDITABLE_KEYS) {
        const storedKey = Object.hasOwn(snapshot, key) ? key : legacyKeys[key];
        if (!Object.hasOwn(snapshot, storedKey)) continue;
        editorDraft[key] = _draftDefaultFor(key, { [key]: snapshot[storedKey] });
    }
    if (typeof snapshot.avatar_url === 'string') editorDraft.avatar_url = snapshot.avatar_url;
    writeGroupEditorFields(editorDraft);
    printGroupCandidates();
    printGroupMembers();
}

/** Re-render the fields from the draft; used after a discard or a reconcile. */
function syncGroupEditorFields() {
    writeGroupEditorFields(editorDraft ?? getEditedGroup());
    printGroupMembers();
}

/**
 * Merge a re-selected group into the editor's pending draft.
 *
 * Three-way merge: the editor's baseline is the state last saved, the draft
 * holds the user's edits, and the live group is the truth for everything the
 * user did not touch (another tab, a slash command, an extension). Unchanged
 * keys adopt the live value; edited keys keep the draft's.
 * @param {Group} group
 * @returns {boolean} true when anything was adopted from the live group
 */
function reconcileEditorDraft(group) {
    if (!editorDraft) return false;
    const baseline = readGroupEditorBaseline();
    let adopted = false;
    for (const key of EDITABLE_KEYS) {
        const draftValue = editorDraft[key];
        const baselineValue = baseline?.[key];
        const liveValue = _draftDefaultFor(key, group);
        const untouched = JSON.stringify(draftValue) === JSON.stringify(baselineValue);
        if (untouched && JSON.stringify(draftValue) !== JSON.stringify(liveValue)) {
            editorDraft[key] = cloneDraftValue(liveValue);
            adopted = true;
        }
    }
    // The baseline is what the live group holds, not the merge result: the merge
    // deliberately keeps the user's edited keys, and baselining those would
    // report the unsaved edits as saved, so Save would skip them and a later
    // discard would revert to them instead of the stored group.
    const liveSnapshot = createEditorDraft(group);
    rebaseGroupEditor(liveSnapshot);
    writeGroupEditorFields(editorDraft);
    printGroupCandidates();
    printGroupMembers();
    return adopted;
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
    const searchValue = String($(this).val());
    // SillyBunny: the editor and its popout share one filter, including the search-order input.
    $('[id="rm_group_members_filter"]').not(this).val(searchValue);
    groupMembersFilter.setFilterData(FILTER_TYPES.SEARCH, searchValue.toLowerCase());
    syncGroupMembersFilteredState();
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

// SillyBunny: model overrides are available on mobile through the member menu.
async function editGroupMemberModel(member) {
    const avatarId = member.data('id') ?? member.attr('data-avatar');
    if (!avatarId) return;
    const group = getEditedGroup();
    const draft = editorDraft;
    const groupId = openGroupId;
    const focus = captureGroupMemberFocus(member);
    const input = await Popup.show.input(t`Model override`, '', getGroupMemberModel(group, avatarId));
    if (draft !== editorDraft || groupId !== openGroupId) return;
    if (input === null) {
        restoreGroupMemberFocus(focus);
        return;
    }
    if (!getEditedGroup()?.members?.includes(avatarId)) return;
    const value = String(input).trim();
    await updateGroupMemberModel(avatarId, value);
    printGroupMembers({ animate: true });
    restoreGroupMemberFocus(focus);
}

async function updateGroupMemberModel(avatarId, value) {
    if (isGroupEditorActive()) {
        _editDraft((draft) => {
            if (!draft.members.includes(avatarId)) return false;
            if ((draft.member_models[avatarId] ?? '') === value) return false;
            if (value) draft.member_models[avatarId] = value;
            else delete draft.member_models[avatarId];
            return true;
        });
        return;
    }

    if (!openGroupId) return;
    const group = groups.find(x => x.id === openGroupId);
    if (!group || getGroupMemberModel(group, avatarId) === value.trim()) return;
    setGroupMemberModel(group, avatarId, value);
    await editGroup(openGroupId, false, false);
}

async function createGroup(receipt = captureGroupEditorSave()) {
    if (!receipt?.isCurrent()) return false;
    const draft = receipt.snapshot;
    const pendingDraft = editorDraft;
    const members = (draft.members ?? []).filter(onlyUnique);
    const existingGroup = findGroupByMembers(members);
    if (existingGroup) {
        await createNewGroupChat(existingGroup.id);
        toastr.info(t`Opened a new chat branch for the existing group.`);
        return false;
    }

    const memberNames = characters.filter(x => members.includes(x.avatar)).map(x => x.name).join(', ');
    const name = String(draft.name || '').trim() || t`Group: ${memberNames}`;
    const allowSelfResponses = Boolean(draft.allow_self_responses);
    const activationStrategy = Number(draft.activation_strategy ?? group_activation_strategy.NATURAL);
    const generationMode = Number(draft.generation_mode ?? group_generation_mode.SWAP);

    const avatarUrl = draft.avatar_url || $('#group_avatar_preview img').attr('src');
    const chatName = humanizedDateTime();
    const chats = [chatName];

    /** @type {Omit<Group, 'id'>} */
    const groupCreateModel = {
        name: name,
        members: members,
        avatar_url: isValidImageUrl(avatarUrl) ? avatarUrl : default_avatar,
        allow_self_responses: allowSelfResponses,
        hideMutedSprites: Boolean(draft.hideMutedSprites),
        activation_strategy: activationStrategy,
        generation_mode: generationMode,
        // SillyBunny: the join templates and per-member model overrides used to
        // be dropped here even though the backend accepts them (Step 4 fix).
        generation_mode_join_prefix: String(draft.generation_mode_join_prefix ?? ''),
        generation_mode_join_suffix: String(draft.generation_mode_join_suffix ?? ''),
        disabled_members: [...(draft.disabled_members ?? [])],
        [GROUP_MEMBER_MODELS_KEY]: { ...(draft.member_models ?? {}) },
        fav: Boolean(draft.fav),
        chat_id: chatName,
        chats: chats,
        conversation_settings: {},
    };

    const tagList = $('#groupTagList').clone();
    const createGroupResponse = await fetch('/api/groups/create', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(groupCreateModel),
    });

    if (!createGroupResponse.ok) return false;
    const data = await createGroupResponse.json();
    createTagMapFromList(tagList, data.id);
    if (receipt.isCurrent() && editorDraft === pendingDraft) {
        const savedSnapshot = createEditorDraft(data);
        // Adopt server defaults without overwriting edits made after submission.
        for (const key of ['avatar_url', ...EDITABLE_KEYS]) {
            if (JSON.stringify(editorDraft[key]) === JSON.stringify(draft[key])) {
                editorDraft[key] = cloneDraftValue(savedSnapshot[key]);
            }
        }
        editorDraft.id = data.id;
        openGroupId = data.id;
        receipt.markSaved({ entityId: String(data.id), mode: 'edit' }, savedSnapshot);
    }
    await getCharacters();
    if (editorDraft === pendingDraft && isGroupEditorOwner(data.id)) select_rm_info('group_create', data.id);
    return true;
}

/**
 * Creates a new group chat within the specified group.
 * @param {string} groupId Group ID
 * @param {object} [options] Creation options
 * @param {boolean} [options.chatAlreadyPrepared=false] Whether the caller already flushed saves and cleared the current chat.
 * @returns {Promise<void>} Promise that resolves when the new group chat is created
 */
export async function createNewGroupChat(groupId, { chatAlreadyPrepared = false } = {}) {
    const group = groups.find(x => x.id === groupId);

    if (!group) {
        return;
    }

    if (!chatAlreadyPrepared) {
        if (!await flushPendingChatSavesForNavigation()) {
            return;
        }

        await clearChat({ clearData: true });
    }

    const newChatName = humanizedDateTime();
    group.chats = Array.isArray(group.chats) ? group.chats : [];
    group.chats.push(newChatName);
    group.chat_id = newChatName;
    updateChatMetadata({ integrity: uuidv4() }, true);

    await editGroup(group.id, true, false);
    await getGroupChat(group.id, false, { newlyCreated: true });
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
        throw new Error(`Group chat ${oldChatId} is not registered in group ${groupId}.`);
    }

    const previousChatId = group.chat_id;
    const previousChats = [...group.chats];

    if (group.chat_id === oldChatId) {
        group.chat_id = newChatId;
    }

    group.chats.splice(group.chats.indexOf(oldChatId), 1);
    group.chats.push(newChatId);

    try {
        await editGroup(groupId, true, false);
    } catch (error) {
        group.chat_id = previousChatId;
        group.chats = previousChats;
        throw error;
    }
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

/**
 * Clones the current-members list into a floating window. This is the same list
 * node the panel renders, so the clone inherits the row markup as-is; the
 * sortable instance is not cloned with it, so the popout expects the up/down
 * buttons.
 */
function doCurMemberListPopout() {
    if ($('#groupMemberListPopout').length === 0) {
        console.debug('did not see popout yet, creating');
        const memberListClone = $('#currentGroupMembers').clone();
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

        // The clone shares ids with the panel, including #currentGroupMembers;
        // the popout gets its own list id so printGroupMembers() can target it.
        memberListClone.attr('id', 'sb-group-members-popout-list');
        newElement.find('#rm_group_members').attr('id', '').addClass('rm_group_members');

        // SillyBunny: HTML copies do not retain the search input's current value.
        newElement.find('#rm_group_members_filter').val($('#rm_group_members_filter').val());

        // Remove pagination from popout
        newElement.find('.group_pagination').empty();

        $('#movingDivs').append(newElement);
        loadMovingUIState();
        $('#groupMemberListPopout').fadeIn(animation_duration);
        dragElement(newElement);
        $('#groupMemberListPopoutClose').off('click').on('click', function () {
            $('#groupMemberListPopout').fadeOut(animation_duration, () => { $('#groupMemberListPopout').remove(); });
        });
    } else {
        console.debug('saw existing popout, removing');
        $('#groupMemberListPopout').fadeOut(animation_duration, () => { $('#groupMemberListPopout').remove(); });
    }
}

jQuery(() => {
    initGroupSpeakerControls();
    // SillyBunny: the group editor controller lives with the group state it edits
    // (Step 4). It owns the session, the draft store and the chrome, and calls
    // back into this module for anything that has to touch groups[].
    initGroupEditor({
        captureSnapshot: captureEditorSnapshot,
        applySnapshot: applyEditorSnapshot,
        writeDomFromDraft: syncGroupEditorFields,
        saveDraft,
        createGroup,
        getGroupName: (groupId) => groups.find((x) => x.id == groupId)?.name ?? null,
        getDraftName: () => editorDraft?.name ?? '',
        canCreate: () => getGroupCharacters({ doFilter: false, onlyMembers: true }).length > 0,
        canRestoreAvatar: canRestoreGroupAvatar,
        reorderMembers: reorderMembersByIndices,
    });
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
    // SillyBunny: include the search field created later by the native popout.
    $(document).on('input', '#rm_group_members_filter', filterGroupMemberList);
    $('#rm_group_submit').on('click', () => void createGroup());
    $('#rm_group_scenario').on('click', setCharacterSettingsOverrides);
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
    $('#rm_group_generation_mode_join_prefix').on('input', onGroupGenerationModeTemplateInput);
    $('#rm_group_generation_mode_join_suffix').on('input', onGroupGenerationModeTemplateInput);
    $('#group_avatar_button').on('input', uploadGroupAvatar);
    $('#rm_group_restore_avatar').on('click', restoreGroupAvatar);
    $(document).on('click', '.group_member .right_menu_button', onGroupActionClick);
    // SillyBunny: document delegation survives detached-list HTML cloning.
    $(document).on('click', '.group_member .sb-group-member-menu', onGroupMemberMenuClick);
    $(document).on('change', '.group_member .sb-group-member-switch', onGroupMemberSwitchChange);
    $(document).on('click', '#rm_group_add_members .group_member', onGroupCandidateRowClick);
    eventSource.on(event_types.CHAT_CHANGED, updateGroupSpeakerControls);
    eventSource.on(event_types.GROUP_UPDATED, updateGroupSpeakerControls);
    // SillyBunny: a turn routing lease ends when its chat or group changes.
    eventSource.on(event_types.CHAT_CHANGED, () => groupTurnRouting.refresh());
    eventSource.on(event_types.GROUP_UPDATED, () => groupTurnRouting.refresh());
    // SillyBunny: the More menu's "Rename Group" entry asks the editor's header
    // title to start an inline rename, instead of reaching into group state from
    // world-info.js (Step 4).
    document.addEventListener('sb-group-rename-requested', () => {
        void renameOpenGroup();
    });
});
