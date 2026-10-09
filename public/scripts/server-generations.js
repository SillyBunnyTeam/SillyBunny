/**
 * SillyBunny: chat replies the server can finish without this page.
 *
 * Every main chat generation carries a commit plan (generation-commit-plan.js). If this page goes
 * away mid-generation, the server writes the reply into the chat itself (src/generation-commit.js).
 * This module builds those plans, finishes server-written replies when their chat is opened (the
 * same cleanup a live reply gets, then the rest of an interrupted group round), and follows the
 * open chat's generations over a server event stream: replies a previous page left running, and
 * replies a server restart lost.
 */

import {
    characters,
    chat,
    cleanUpMessage,
    event_types,
    eventSource,
    getCurrentChatId,
    getGeneratingApi,
    getGeneratingModel,
    getRequestHeaders,
    getThumbnailUrl,
    isGenerating,
    main_api,
    name2,
    reloadCurrentChat,
    saveChatConditional,
    swipe,
    this_chid,
    updateMessageBlock,
    updateMessageTokenAccounting,
} from '../script.js';
import { SWIPE_DIRECTION } from './constants.js';
import { getGroupRoundRemaining, group_generation_id, resumeGroupRound, selected_group } from './group-chats.js';
import { GENERATION_COMMIT_PLAN_VERSION, getMessageIdentity, hashCommitText } from './generation-commit-plan.js';
import { t } from './i18n.js';
import { getCurrentReasoningEffort } from './openai.js';
import { parseAutoReasoningFromString, parseReasoningInSwipes } from './reasoning.js';
import { getActiveGenerationIds, pageId } from './resumable-generation.js';

const EVENTS_URL = '/api/resumable-generations/events';
const ACKNOWLEDGE_URL = '/api/resumable-generations/acknowledge';
const CANCEL_URL = '/api/resumable-generations/cancel';
/** How often a reply that arrived during a live generation checks whether it can load yet. */
const IDLE_CHECK_INTERVAL_MS = 1000;
/** Generation types whose reply becomes a chat message the server can place. */
const COMMITTABLE_TYPES = new Set([undefined, 'normal', 'regenerate', 'swipe', 'continue']);
/** Commit refusals that mean the chat moved on while the reply was generated. */
const CHAT_CHANGED_REASONS = new Set(['anchor-changed', 'chat-changed', 'target-changed', 'swipes-changed', 'text-changed']);

/** @type {EventSource|null} */
let chatEvents = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let idleTimer = null;
/** Chat the watcher is following; a chat switch makes older events stale. */
let watchedChatKey = '';
/** @type {JQuery<HTMLElement>|null} */
let runningToast = null;
/** Ids of server-written replies already present in the loaded chat. */
const loadedCommitIds = new Set();
/** Ids whose outcome this page already showed; the server can repeat them until the acknowledgement lands. */
const shownIds = new Set();

/**
 * @returns {{ chat: { avatar?: string, group?: string }, file: string }|null} Where the open chat lives on disk
 */
function getOpenChatTarget() {
    if (selected_group) {
        const chatId = getCurrentChatId();
        return chatId ? { chat: { group: String(selected_group) }, file: String(chatId) } : null;
    }
    const character = this_chid !== undefined ? characters[this_chid] : null;
    if (!character?.avatar || !character.chat) {
        return null;
    }
    return { chat: { avatar: character.avatar }, file: String(character.chat) };
}

/**
 * @param {{ chat: { avatar?: string, group?: string }, file: string }} target Open chat
 * @returns {string}
 */
function getTargetKey(target) {
    return JSON.stringify([target.chat.avatar ?? '', target.chat.group ?? '', target.file]);
}

/**
 * Describes where the reply of a generation that is about to be sent lands in the open chat.
 * Call right before the request, after the chat has been prepared for the reply.
 * @param {object} options Generation
 * @param {string|undefined} options.type Generate() type
 * @param {Date} options.started Generation start
 * @param {string|null} [options.replaces] Identity of the message a regenerate removed
 * @returns {import('./generation-commit-plan.js').GenerationCommitPlan|null} Plan, or null when the server must not write this reply
 */
export function createGenerationCommitPlan({ type, started, replaces = null }) {
    const target = getOpenChatTarget();
    if (!target || !COMMITTABLE_TYPES.has(type) || main_api === 'koboldhorde') {
        return null;
    }
    const last = chat[chat.length - 1];
    const isSwipe = type === 'swipe' && last && !last.is_user && last.swipe_id !== undefined;
    const kind = type === 'continue' ? 'continue' : isSwipe ? 'swipe' : 'append';
    if (kind === 'continue' && (!last || last.is_user)) {
        return null;
    }
    const index = kind === 'append' ? chat.length : chat.length - 1;
    const character = characters[this_chid];
    const avatar = character?.avatar && character.avatar !== 'none' ? character.avatar : null;
    return {
        v: GENERATION_COMMIT_PLAN_VERSION,
        chat: target.chat,
        file: target.file,
        kind,
        index,
        anchor: kind === 'append' && index > 0 ? getMessageIdentity(chat[index - 1]) : null,
        replaces: kind === 'append' ? replaces : null,
        target: kind === 'append' ? null : getMessageIdentity(last),
        swipes: kind === 'swipe' ? (Array.isArray(last.swipes) ? last.swipes.length : 1) : 0,
        prefix: kind === 'continue' ? hashCommitText(String(last.mes ?? '')) : null,
        prefix_length: kind === 'continue' ? String(last.mes ?? '').length : 0,
        started: started.toISOString(),
        page: pageId,
        round: selected_group ? getGroupRoundRemaining() : [],
        message: {
            name: kind === 'append' ? String(name2 ?? '') : String(last.name ?? ''),
            force_avatar: selected_group && kind === 'append' ? (avatar ? getThumbnailUrl('avatar', avatar) : 'img/ai4.png') : null,
            original_avatar: selected_group && kind === 'append' ? avatar : null,
            extra: {
                api: getGeneratingApi(),
                model: getGeneratingModel(),
                reasoning_effort: getCurrentReasoningEffort() || null,
                gen_id: selected_group && kind === 'append' && Number.isFinite(group_generation_id) ? group_generation_id : null,
            },
        },
    };
}

/**
 * Cleans the extra completions of a multi-swipe reply, as extractMultiSwipes() and saveReply() do.
 * @param {any} message Server-written message
 * @param {number} count Extra swipes the server added after the reply's own swipe
 */
function finalizeExtraSwipes(message, count) {
    if (!(count > 0) || !Array.isArray(message.swipes) || !Number.isInteger(message.swipe_id)) {
        return;
    }
    const start = message.swipe_id + 1;
    const swipes = message.swipes.slice(start, start + count)
        .map(text => cleanUpMessage({ getMessage: String(text ?? ''), isImpersonate: false, isContinue: false, displayIncompleteSentences: false }));
    const swipeInfo = Array.isArray(message.swipe_info) ? message.swipe_info.slice(start, start + count) : [];
    parseReasoningInSwipes(swipes, swipeInfo, message.extra?.reasoning_duration);
    message.swipes.splice(start, swipes.length, ...swipes);
}

/**
 * Gives server-written replies the cleanup a live reply gets in saveReply(): reasoning parsing,
 * stop strings, regex scripts, trimming and token counts.
 * @returns {Promise<{ ids: string[], round: string[] }>} Ids of the replies finished, and the members
 * still to speak when the last message ended a group round early
 */
async function finalizeServerCommittedReplies() {
    const finished = [];
    for (let index = 0; index < chat.length; index++) {
        const message = chat[index];
        const marker = message?.extra?.server_generation;
        if (!marker || typeof marker !== 'object') {
            continue;
        }
        loadedCommitIds.add(String(marker.id));
        if (!marker.pending) {
            continue;
        }

        const isContinue = marker.kind === 'continue';
        const prefixLength = Number(marker.prefix_length) || 0;
        const prefix = String(message.mes ?? '').slice(0, prefixLength);
        let reply = String(message.mes ?? '').slice(prefixLength);
        const parsed = parseAutoReasoningFromString(reply);
        if (parsed?.reasoning) {
            message.extra.reasoning = [message.extra.reasoning, parsed.reasoning].filter(Boolean).join('\n\n');
            reply = parsed.content;
        }
        message.mes = prefix + cleanUpMessage({ getMessage: reply, isImpersonate: false, isContinue });
        delete message.extra.server_generation;
        await updateMessageTokenAccounting(message, { reasoning: message.extra.reasoning ?? '' });
        if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
            message.swipes[message.swipe_id] = message.mes;
            if (Array.isArray(message.swipe_info) && message.swipe_info[message.swipe_id]) {
                message.swipe_info[message.swipe_id].extra = structuredClone(message.extra);
            }
        }
        finalizeExtraSwipes(message, Number(marker.extra_swipes) || 0);
        await updateMessageBlock(index, message);
        finished.push({ id: String(marker.id), index, kind: marker.kind, round: Array.isArray(marker.round) ? marker.round.map(String) : [] });
    }
    if (!finished.length) {
        return { ids: [], round: [] };
    }
    if (await saveChatConditional() !== true) {
        // Left pending on disk; the next load of this chat tries again.
        return { ids: [], round: [] };
    }
    for (const { index, kind } of finished) {
        const type = kind === 'append' ? 'normal' : kind;
        await eventSource.emit(event_types.MESSAGE_RECEIVED, index, type);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, index, type);
    }
    const last = finished[finished.length - 1];
    return { ids: finished.map(item => item.id), round: last.index === chat.length - 1 ? last.round : [] };
}

/**
 * @param {string} url Control endpoint
 * @param {object} body Request body
 * @returns {Promise<Response>}
 */
function post(url, body) {
    return fetch(url, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body), cache: 'no-store' });
}

/**
 * @param {string[]} ids Generation ids the user has seen the outcome of
 */
function acknowledge(ids) {
    if (ids.length) {
        post(ACKNOWLEDGE_URL, { ids }).catch(() => undefined);
    }
}

function clearRunningToast() {
    if (runningToast) {
        toastr.clear(runningToast);
        runningToast = null;
    }
}

/**
 * @param {string[]} ids Running generations
 */
function showRunningToast(ids) {
    if (runningToast) {
        return;
    }
    const content = $('<div></div>')
        .append($('<div></div>').text(t`A reply for this chat is still being written. It will appear here when it is done.`))
        .append($('<a href="javascript:void(0)"></a>').text(t`Stop and keep what is written`).on('click', (event) => {
            event.stopPropagation();
            for (const id of ids) {
                post(CANCEL_URL, { id, commitPartial: true }).catch(() => undefined);
            }
        }));
    runningToast = toastr.info(content, t`Reply in progress`, { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, escapeHtml: false });
}

/**
 * The same action the user would take by hand to get a lost reply again, if the chat still ends
 * where that reply would have gone.
 * @param {any} item Lost generation, as listed by the server
 * @returns {(() => unknown)|null}
 */
function getLostReplyRetry(item) {
    const lastIndex = chat.length - 1;
    const last = chat[lastIndex];
    if (!last) {
        return null;
    }
    // A save during the stream may have put the unfinished reply on disk.
    const isOwnPlaceholder = !last.is_user && Boolean(item.started) && last.gen_started === item.started;
    const identity = getMessageIdentity(last);

    if (item.kind === 'append') {
        if (selected_group && item.member && chat.length === item.index && identity === item.anchor) {
            return () => resumeGroupRound([item.member, ...(Array.isArray(item.round) ? item.round : [])]);
        }
        if (isOwnPlaceholder || (chat.length === item.index && identity === item.anchor)) {
            // Regenerating onto a user message generates a new reply instead.
            return () => $('#option_regenerate').trigger('click');
        }
        return null;
    }
    if (lastIndex !== item.index || !(isOwnPlaceholder || identity === item.target)) {
        return null;
    }
    if (item.kind === 'swipe') {
        return () => swipe(null, SWIPE_DIRECTION.RIGHT, { forceMesId: lastIndex, forceSwipeId: last.swipes?.length ?? 1, message: last });
    }
    return () => $('#option_continue').trigger('click');
}

/**
 * @param {any} item Generation a server restart lost
 */
function showLostToast(item) {
    const retry = getLostReplyRetry(item);
    const content = $('<div></div>').append($('<div></div>').text(retry
        ? t`The server restarted while a reply for this chat was being written, so the reply was lost.`
        : t`The server restarted while a reply for this chat was being written, so the reply was lost. The chat has changed since, so it cannot be regenerated in place.`));
    /** @type {JQuery<HTMLElement>|null} */
    let toast = null;
    if (retry) {
        content.append($('<a href="javascript:void(0)"></a>').text(t`Regenerate`).on('click', (event) => {
            event.stopPropagation();
            if (toast) {
                toastr.clear(toast);
            }
            if (isGenerating()) {
                toastr.warning(t`Wait for the current reply to finish, then regenerate.`);
                return;
            }
            retry();
        }));
    }
    toast = toastr.warning(content, t`Reply lost`, { timeOut: 0, extendedTimeOut: 0, tapToDismiss: !retry, closeButton: true, escapeHtml: false });
}

/**
 * Reloads the chat for a reply the server wrote, once no live generation would be cut off by it.
 * @param {string} chatKey Chat the reply belongs to
 */
function reloadWhenIdle(chatKey) {
    clearTimeout(idleTimer ?? undefined);
    idleTimer = null;
    if (chatKey !== watchedChatKey) {
        return;
    }
    if (isGenerating()) {
        idleTimer = setTimeout(() => reloadWhenIdle(chatKey), IDLE_CHECK_INTERVAL_MS);
        return;
    }
    // The reload fires CHAT_CHANGED, which finalizes the reply and reconnects the event stream.
    reloadCurrentChat().catch(error => console.warn('Could not load a server-written reply:', error));
}

/**
 * Acts on the server's list of generations for the open chat that this page does not own.
 * @param {string} chatKey Chat the list is for
 * @param {any[]} pending Generations
 */
function onPendingGenerations(chatKey, pending) {
    if (chatKey !== watchedChatKey || !Array.isArray(pending)) {
        return;
    }
    const own = new Set(getActiveGenerationIds());
    const foreign = pending.filter(item => !own.has(item.id) && item.page !== pageId);
    const running = foreign.filter(item => ['running', 'waiting', 'committing'].includes(item.state));
    const committed = foreign.filter(item => item.state === 'committed');
    const outcomes = foreign.filter(item => (item.state === 'failed' || item.state === 'lost') && !shownIds.has(item.id));

    for (const item of outcomes) {
        shownIds.add(item.id);
        if (item.state === 'lost') {
            showLostToast(item);
        } else if (CHAT_CHANGED_REASONS.has(item.reason)) {
            toastr.warning(t`A reply generated while this chat was closed was not added, because the chat changed in the meantime.`, t`Reply discarded`);
        } else {
            toastr.error(t`A reply generated while this chat was closed failed and was not added.`, t`Reply failed`);
        }
    }
    acknowledge(outcomes.map(item => item.id));
    acknowledge(committed.filter(item => loadedCommitIds.has(item.id)).map(item => item.id));

    if (running.length) {
        showRunningToast(running.map(item => item.id));
    } else {
        clearRunningToast();
    }
    if (committed.some(item => !loadedCommitIds.has(item.id))) {
        reloadWhenIdle(chatKey);
    }
}

function closeChatEvents() {
    chatEvents?.close();
    chatEvents = null;
}

/**
 * @param {{ chat: { avatar?: string, group?: string }, file: string }} target Open chat
 * @param {string} chatKey Its key
 */
function openChatEvents(target, chatKey) {
    const query = new URLSearchParams({ ...target.chat, file: target.file, page: pageId });
    chatEvents = new EventSource(`${EVENTS_URL}?${query}`);
    chatEvents.addEventListener('message', (event) => {
        try {
            onPendingGenerations(chatKey, JSON.parse(event.data).pending);
        } catch (error) {
            console.warn('Could not read server-side generation events:', error);
        }
    });
}

async function onChatChanged() {
    closeChatEvents();
    clearTimeout(idleTimer ?? undefined);
    idleTimer = null;
    clearRunningToast();
    loadedCommitIds.clear();
    const target = getOpenChatTarget();
    watchedChatKey = target ? getTargetKey(target) : '';
    if (!target) {
        return;
    }
    const chatKey = watchedChatKey;
    const { ids, round } = await finalizeServerCommittedReplies();
    acknowledge(ids);
    if (chatKey !== watchedChatKey) {
        return;
    }
    openChatEvents(target, chatKey);
    if (round.length && selected_group && !isGenerating()) {
        toastr.info(t`Continuing the group round that was interrupted.`);
        resumeGroupRound(round).catch(error => console.warn('Could not continue the group round:', error));
    }
}

export function initServerGenerations() {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        onChatChanged().catch(error => console.warn('Could not check server-side generations:', error));
    });
}
