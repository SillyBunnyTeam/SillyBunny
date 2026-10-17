/**
 * SillyBunny: writes a finished generation's reply into its chat when the page that asked for it is
 * gone. The reply is only written if the chat still has the state the generation was made for (see
 * generation-commit-plan.js); otherwise it is dropped rather than misplaced.
 *
 * The browser finishes the job when the chat is next opened: committed messages carry
 * `extra.server_generation.pending`, and server-generations.js applies the client-side cleanup
 * (regex scripts, stop strings, reasoning parsing, token counts) and clears it.
 *
 * A page that was only frozen can still come back for a reply the server already committed. The
 * commit is then undone, restoring the chat file and its integrity slug exactly, so that page's
 * own save goes through as if the server had never written anything.
 */

import { getMessageIdentity, hashCommitText } from '../public/scripts/generation-commit-plan.js';
import { updateChatRecords } from './endpoints/chats.js';

/**
 * @typedef {import('../public/scripts/generation-commit-plan.js').GenerationCommitPlan} GenerationCommitPlan
 * @typedef {{ text: string, reasoning: string, swipes?: string[] }} GenerationReply
 * @typedef {{ id: string, finishedAt: Date }} GenerationCommitContext
 * @typedef {{ records: object[], integrity: string, committedIntegrity: string }} GenerationCommitUndo
 */

/**
 * @param {any} message Chat message
 * @returns {object} The message's extra, created if missing
 */
function ensureExtra(message) {
    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    return message.extra;
}

/**
 * @param {any} message Message whose current swipe changed
 */
function syncCurrentSwipe(message) {
    if (!Array.isArray(message.swipes)) {
        message.swipes = [];
        message.swipe_id = 0;
    }
    if (!Array.isArray(message.swipe_info)) {
        message.swipe_info = [];
    }
    const swipeId = Number.isInteger(message.swipe_id) ? message.swipe_id : message.swipes.length;
    message.swipe_id = swipeId;
    message.swipes[swipeId] = message.mes;
    message.swipe_info[swipeId] = {
        send_date: message.send_date,
        gen_started: message.gen_started,
        gen_finished: message.gen_finished,
        extra: structuredClone(message.extra),
    };
}

/**
 * Adds the extra completions of a multi-swipe request after the reply's own swipe, as saveReply()
 * does in the browser.
 * @param {any} message Message that received the reply
 * @param {string[]} swipes Extra completions
 */
function addExtraSwipes(message, swipes) {
    const swipeExtra = structuredClone(message.extra ?? {});
    for (const key of ['token_count', 'reasoning', 'reasoning_duration', 'reasoning_tokens', 'server_generation']) {
        delete swipeExtra[key];
    }
    for (const text of swipes) {
        message.swipes.push(text);
        message.swipe_info.push({
            send_date: message.send_date,
            gen_started: message.gen_started,
            gen_finished: message.gen_finished,
            extra: structuredClone(swipeExtra),
        });
    }
}

/**
 * @param {any} message Message receiving generated text
 * @param {GenerationCommitPlan} plan Plan
 * @param {GenerationCommitContext} context Commit context
 */
function stampGeneration(message, plan, { finishedAt }) {
    const extra = ensureExtra(message);
    message.send_date = finishedAt.toISOString();
    message.gen_started = plan.started || finishedAt.toISOString();
    message.gen_finished = finishedAt.toISOString();
    extra.api = plan.message.extra.api;
    extra.model = plan.message.extra.model;
    extra.reasoning_effort = plan.message.extra.reasoning_effort;
    extra.reasoning_duration = null;
    delete extra.token_count;
    delete extra.reasoning_tokens;
}

/**
 * The browser writes a reply's message before the reply is done (streaming placeholder), and any
 * save during the stream puts it on disk. It is recognized by carrying this generation's start time.
 * @param {any} message Chat message
 * @param {GenerationCommitPlan} plan Plan
 * @returns {boolean}
 */
function isOwnPlaceholder(message, plan) {
    return Boolean(message) && !message.is_user && Boolean(plan.started) && message.gen_started === plan.started;
}

/**
 * Places a reply into parsed chat records. Pure: returns new records or why it refused.
 * @param {object[]} records Chat file records, header first
 * @param {GenerationCommitPlan} plan Plan
 * @param {GenerationReply} reply Reply
 * @param {GenerationCommitContext} context Commit context
 * @returns {{ records: object[] } | { reason: string }}
 */
export function applyGenerationReply(records, plan, reply, context) {
    const [header, ...source] = structuredClone(records);
    const messages = /** @type {any[]} */ (source);
    const extraSwipes = plan.kind === 'continue' ? [] : (reply.swipes ?? []).filter(text => typeof text === 'string');
    const marker = { id: context.id, kind: plan.kind, pending: true, prefix_length: 0, round: plan.round ?? [], extra_swipes: extraSwipes.length };

    if (plan.kind === 'append') {
        const previous = plan.index > 0 ? messages[plan.index - 1] : null;
        if (plan.index > 0 && getMessageIdentity(previous) !== plan.anchor) {
            return { reason: 'anchor-changed' };
        }
        const occupant = messages[plan.index];
        const canReplace = messages.length === plan.index + 1
            && ((plan.replaces && getMessageIdentity(occupant) === plan.replaces) || isOwnPlaceholder(occupant, plan));
        if (messages.length !== plan.index && !canReplace) {
            return { reason: 'chat-changed' };
        }
        const message = {
            name: plan.message.name,
            is_user: false,
            send_date: '',
            mes: reply.text,
            extra: { reasoning: reply.reasoning, reasoning_signature: null, server_generation: marker },
        };
        if (plan.message.force_avatar) {
            message.force_avatar = plan.message.force_avatar;
        }
        if (plan.message.original_avatar) {
            message.original_avatar = plan.message.original_avatar;
        }
        if (plan.message.extra.gen_id !== null) {
            message.extra.gen_id = plan.message.extra.gen_id;
        }
        stampGeneration(message, plan, context);
        syncCurrentSwipe(message);
        addExtraSwipes(message, extraSwipes);
        messages[plan.index] = message;
        return { records: [header, ...messages] };
    }

    const message = messages[plan.index];
    const ownPlaceholder = isOwnPlaceholder(message, plan);
    if (messages.length !== plan.index + 1 || !(ownPlaceholder || getMessageIdentity(message) === plan.target)) {
        return { reason: 'target-changed' };
    }

    if (plan.kind === 'swipe') {
        const swipes = Array.isArray(message.swipes) ? message.swipes : [message.mes];
        if (ownPlaceholder && swipes.length === plan.swipes + 1) {
            swipes.length = plan.swipes;
            message.swipe_info?.splice(plan.swipes);
        }
        if (swipes.length !== plan.swipes) {
            return { reason: 'swipes-changed' };
        }
        message.swipes = swipes;
        message.swipe_id = swipes.length;
        message.mes = reply.text;
        ensureExtra(message).reasoning = reply.reasoning;
        message.extra.reasoning_signature = null;
        message.extra.server_generation = marker;
        stampGeneration(message, plan, context);
        syncCurrentSwipe(message);
        addExtraSwipes(message, extraSwipes);
        return { records: [header, ...messages] };
    }

    const prefix = String(message.mes ?? '').slice(0, plan.prefix_length);
    const isExactPrefix = String(message.mes ?? '').length === plan.prefix_length;
    if (hashCommitText(prefix) !== plan.prefix || !(isExactPrefix || ownPlaceholder)) {
        return { reason: 'text-changed' };
    }
    marker.prefix_length = prefix.length;
    message.mes = prefix + reply.text;
    const extra = ensureExtra(message);
    extra.reasoning = reply.reasoning;
    extra.reasoning_signature = null;
    extra.server_generation = marker;
    stampGeneration(message, plan, context);
    syncCurrentSwipe(message);
    return { records: [header, ...messages] };
}

/**
 * @param {GenerationCommitPlan} plan Plan
 * @returns {Parameters<typeof updateChatRecords>[1]}
 */
function getChatTarget(plan) {
    return plan.chat.group
        ? { groupChatId: plan.file }
        : { avatarUrl: plan.chat.avatar, fileName: plan.file };
}

/**
 * Writes a finished reply into the chat named by its plan.
 * @param {Parameters<typeof updateChatRecords>[0]} user Owner of the generation
 * @param {GenerationCommitPlan} plan Plan
 * @param {GenerationReply} reply Reply
 * @param {GenerationCommitContext} context Commit context
 * @returns {Promise<{ committed: true, undo: GenerationCommitUndo } | { committed: false, reason: string }>}
 */
export async function commitGenerationReply(user, plan, reply, context) {
    let refusal = '';
    /** @type {object[]} */
    let before = [];
    const result = await updateChatRecords(user, getChatTarget(plan), (records) => {
        const applied = applyGenerationReply(records, plan, reply, context);
        if ('reason' in applied) {
            refusal = applied.reason;
            return null;
        }
        before = records;
        return { records: applied.records };
    });
    if (result.status === 'saved') {
        return { committed: true, undo: { records: before, integrity: result.previousIntegrity, committedIntegrity: result.integrity } };
    }
    return { committed: false, reason: refusal || result.reason || result.status };
}

/**
 * Puts the chat back the way it was before a commit, if nothing has saved over the commit since.
 * @param {Parameters<typeof updateChatRecords>[0]} user Owner of the generation
 * @param {GenerationCommitPlan} plan Plan
 * @param {GenerationCommitUndo} undo What the commit replaced
 * @returns {Promise<boolean>} Whether the commit was undone
 */
export async function revertGenerationCommit(user, plan, undo) {
    const result = await updateChatRecords(user, getChatTarget(plan), (records) => {
        const integrity = /** @type {any} */ (records[0])?.chat_metadata?.integrity;
        return integrity === undo.committedIntegrity ? { records: undo.records, integrity: undo.integrity, allowShrink: true } : null;
    });
    return result.status === 'saved';
}
