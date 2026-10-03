/**
 * SillyBunny: chat replies the server can finish without this page.
 *
 * Every main chat generation carries a commit plan (generation-commit-plan.js). If this page goes
 * away mid-generation, the server writes the reply into the chat itself (src/generation-commit.js).
 * This module builds those plans, finishes server-written replies when their chat is opened (the
 * same cleanup a live reply gets), and tells the user about generations a previous page left running.
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
    this_chid,
    updateMessageBlock,
    updateMessageTokenAccounting,
} from '../script.js';
import { group_generation_id, selected_group } from './group-chats.js';
import { GENERATION_COMMIT_PLAN_VERSION, getMessageIdentity, hashCommitText } from './generation-commit-plan.js';
import { t } from './i18n.js';
import { getCurrentReasoningEffort } from './openai.js';
import { parseAutoReasoningFromString } from './reasoning.js';
import { getActiveGenerationIds, pageId } from './resumable-generation.js';

const PENDING_URL = '/api/resumable-generations/pending';
const ACKNOWLEDGE_URL = '/api/resumable-generations/acknowledge';
const CANCEL_URL = '/api/resumable-generations/cancel';
const POLL_INTERVAL_MS = 2000;
/** Generation types whose reply becomes a chat message the server can place. */
const COMMITTABLE_TYPES = new Set([undefined, 'normal', 'regenerate', 'swipe', 'continue']);
/** Commit refusals that mean the chat moved on while the reply was generated. */
const CHAT_CHANGED_REASONS = new Set(['anchor-changed', 'chat-changed', 'target-changed', 'swipes-changed', 'text-changed']);

/** @type {ReturnType<typeof setTimeout>|null} */
let pollTimer = null;
/** Chat the watcher is following; a chat switch makes older polls stale. */
let watchedChatKey = '';
/** @type {JQuery<HTMLElement>|null} */
let runningToast = null;
/** Ids of server-written replies already present in the loaded chat. */
const loadedCommitIds = new Set();

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
 * Gives server-written replies the cleanup a live reply gets in saveReply(): reasoning parsing,
 * stop strings, regex scripts, trimming and token counts.
 * @returns {Promise<string[]>} Ids of the replies finished
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
        await updateMessageBlock(index, message);
        finished.push({ id: String(marker.id), index, kind: marker.kind });
    }
    if (!finished.length) {
        return [];
    }
    if (await saveChatConditional() !== true) {
        // Left pending on disk; the next load of this chat tries again.
        return [];
    }
    for (const { index, kind } of finished) {
        const type = kind === 'append' ? 'normal' : kind;
        await eventSource.emit(event_types.MESSAGE_RECEIVED, index, type);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, index, type);
    }
    return finished.map(item => item.id);
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
 * Asks the server about generations for the open chat that this page does not own.
 * @param {string} chatKey Chat this poll is for
 */
async function checkPendingGenerations(chatKey) {
    pollTimer = null;
    const target = getOpenChatTarget();
    if (!target || getTargetKey(target) !== chatKey || chatKey !== watchedChatKey) {
        return;
    }

    let pending;
    try {
        const response = await post(PENDING_URL, { ...target, page: pageId });
        if (!response.ok) {
            return;
        }
        ({ pending } = await response.json());
    } catch {
        return;
    }
    if (chatKey !== watchedChatKey || !Array.isArray(pending)) {
        return;
    }

    const own = new Set(getActiveGenerationIds());
    const foreign = pending.filter(item => !own.has(item.id) && item.page !== pageId);
    const running = foreign.filter(item => ['running', 'waiting', 'committing'].includes(item.state));
    const committed = foreign.filter(item => item.state === 'committed');
    const failed = foreign.filter(item => item.state === 'failed');

    for (const item of failed) {
        if (CHAT_CHANGED_REASONS.has(item.reason)) {
            toastr.warning(t`A reply generated while this chat was closed was not added, because the chat changed in the meantime.`, t`Reply discarded`);
        } else {
            toastr.error(t`A reply generated while this chat was closed failed and was not added.`, t`Reply failed`);
        }
    }
    acknowledge(failed.map(item => item.id));

    const unseen = committed.filter(item => !loadedCommitIds.has(item.id));
    acknowledge(committed.filter(item => loadedCommitIds.has(item.id)).map(item => item.id));

    if (running.length) {
        showRunningToast(running.map(item => item.id));
    } else {
        clearRunningToast();
    }

    if (unseen.length) {
        if (isGenerating()) {
            // Reloading now would stop the live generation; look again once it is done.
            pollTimer = setTimeout(() => checkPendingGenerations(chatKey), POLL_INTERVAL_MS);
            return;
        }
        // The reload fires CHAT_CHANGED, which finalizes the reply and restarts this check.
        await reloadCurrentChat();
        return;
    }

    if (running.length) {
        pollTimer = setTimeout(() => checkPendingGenerations(chatKey), POLL_INTERVAL_MS);
    }
}

async function onChatChanged() {
    clearTimeout(pollTimer ?? undefined);
    pollTimer = null;
    clearRunningToast();
    loadedCommitIds.clear();
    const target = getOpenChatTarget();
    watchedChatKey = target ? getTargetKey(target) : '';
    if (!target) {
        return;
    }
    const chatKey = watchedChatKey;
    acknowledge(await finalizeServerCommittedReplies());
    if (chatKey === watchedChatKey) {
        await checkPendingGenerations(chatKey);
    }
}

export function initServerGenerations() {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        onChatChanged().catch(error => console.warn('Could not check server-side generations:', error));
    });
}
