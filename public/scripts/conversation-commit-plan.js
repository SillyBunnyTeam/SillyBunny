/**
 * SillyBunny: the commit plan of a conversation-mode reply, for the server-owned generation path.
 *
 * A reply of conversation mode keeps the envelope of a roleplay plan (generation-commit-plan.js) and
 * adds one `reply` object. The owner is `chat: { conversation }` and the chat file is the chat id.
 * Shared by the browser and by src/generation-commit.js; keep it free of browser and Node APIs and
 * of imports from the conversation mode, so that the generic plan file can depend on it.
 */

export const CONVERSATION_REPLY_KIND = 'reply';
/** Phase 4 sends `reply` only; the others are reserved for the automatic messages that a later phase moves to the server. */
export const CONVERSATION_REPLY_ORIGINS = Object.freeze(['reply', 'auto', 'chime', 'auto_chat', 'reminder']);
/** `profile`: the connection profile route. `raw`: generateRaw(). The route decides which text clean-up the page applies later. */
export const CONVERSATION_REPLY_ROUTES = Object.freeze(['profile', 'raw']);
export const MAX_CONVERSATION_ROUND = 2;
export const MAX_REPLY_TRIGGERS = 24;

/** Every chat key of a conversation chat starts with this; roleplay keys start with `character:` or `group:`. */
export const CONVERSATION_CHAT_KEY_PREFIX = 'conversation:';

const MAX_ID_LENGTH = 64;
const MAX_AVATAR_LENGTH = 255;
const MAX_NAME_LENGTH = 120;
const MAX_ENVELOPE_TEXT_LENGTH = 1024;
const TOKEN_PATTERN = /^[0-9a-f]{16,32}$/;
const REVISION_PATTERN = /^[0-9a-f]{8}$/;

/**
 * @param {unknown} value Candidate
 * @param {number} maxLength Longest accepted text
 * @returns {string|null} The text when it is a non-empty string of at most `maxLength` characters
 */
function boundedText(value, maxLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

/**
 * A conversation id and a chat id never hold a colon (the store's id patterns), so a key built from
 * both splits back into them. A value with a colon is refused here because the key would not.
 * @param {unknown} value Candidate
 * @returns {string|null}
 */
function keyPart(value) {
    const text = boundedText(value, MAX_ID_LENGTH);
    return text !== null && !text.includes(':') ? text : null;
}

/**
 * @param {unknown} value Candidate
 * @returns {{ id: string, rev: string }|null} A message id with the 8-hex hash of its revision
 */
function messageStamp(value) {
    const stamp = /** @type {any} */ (value);
    if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp)) {
        return null;
    }
    const id = boundedText(stamp.id, MAX_ID_LENGTH);
    return id !== null && typeof stamp.rev === 'string' && REVISION_PATTERN.test(stamp.rev) ? { id, rev: stamp.rev } : null;
}

/**
 * @param {string} conversation Conversation id
 * @param {string} file Chat id
 * @returns {string} Stable key for matching generations to a conversation chat
 */
export function getConversationChatKey(conversation, file) {
    return `${CONVERSATION_CHAT_KEY_PREFIX}${conversation}:${file}`;
}

/**
 * @param {unknown} chatKey A key from getCommitChatKey()
 * @returns {{ conversation: string, chat: string }|null} The two ids, or null for any key that is not a conversation chat's
 */
export function parseConversationChatKey(chatKey) {
    if (typeof chatKey !== 'string' || !chatKey.startsWith(CONVERSATION_CHAT_KEY_PREFIX)) {
        return null;
    }
    const parts = chatKey.slice(CONVERSATION_CHAT_KEY_PREFIX.length).split(':');
    return parts.length === 2 && parts[0] && parts[1] ? { conversation: parts[0], chat: parts[1] } : null;
}

/**
 * Validates and normalizes a plan whose owner is a conversation. Anything unexpected makes the whole
 * plan invalid. The caller has checked the plan version.
 * @param {any} plan Candidate plan with a `chat.conversation` field
 * @returns {import('./generation-commit-plan.js').GenerationCommitPlan|null}
 */
export function normalizeConversationPlan(plan) {
    if (plan.chat.avatar !== undefined || plan.chat.group !== undefined) {
        return null;
    }
    const conversation = keyPart(plan.chat.conversation);
    const file = keyPart(plan.file);
    if (conversation === null || file === null || plan.kind !== CONVERSATION_REPLY_KIND) {
        return null;
    }
    if (!Number.isInteger(plan.index) || plan.index < 0) {
        return null;
    }

    const round = plan.round ?? [];
    if (!Array.isArray(round) || round.length > MAX_CONVERSATION_ROUND || !round.every(avatar => boundedText(avatar, MAX_AVATAR_LENGTH))) {
        return null;
    }

    const reply = plan.reply;
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
        return null;
    }
    const speaker = boundedText(reply.speaker, MAX_AVATAR_LENGTH);
    const anchor = boundedText(reply.anchor, MAX_AVATAR_LENGTH);
    const triggers = Array.isArray(reply.triggers) && reply.triggers.length <= MAX_REPLY_TRIGGERS ? reply.triggers.map(messageStamp) : null;
    const hasTarget = reply.target !== null && reply.target !== undefined;
    const target = hasTarget ? messageStamp(reply.target) : null;
    if (speaker === null || anchor === null || !triggers || !triggers.every(Boolean) || (hasTarget && target === null)) {
        return null;
    }
    if (typeof reply.token !== 'string' || !TOKEN_PATTERN.test(reply.token)
        || !CONVERSATION_REPLY_ORIGINS.includes(reply.origin) || !CONVERSATION_REPLY_ROUTES.includes(reply.route)
        || typeof reply.needs_user !== 'boolean' || !Number.isSafeInteger(reply.round_started) || reply.round_started < 0) {
        return null;
    }

    const message = plan.message && typeof plan.message === 'object' ? plan.message : {};
    const name = boundedText(message.name, MAX_NAME_LENGTH);
    const namedAvatar = message.original_avatar ?? speaker;
    if (name === null || namedAvatar !== speaker) {
        return null;
    }

    return {
        v: plan.v,
        chat: { conversation },
        file,
        kind: CONVERSATION_REPLY_KIND,
        index: plan.index,
        anchor: null,
        replaces: null,
        target: null,
        swipes: 0,
        prefix: null,
        prefix_length: 0,
        started: typeof plan.started === 'string' && plan.started.length <= MAX_ENVELOPE_TEXT_LENGTH ? plan.started : '',
        page: typeof plan.page === 'string' && plan.page.length <= MAX_ENVELOPE_TEXT_LENGTH ? plan.page : '',
        round: [...round],
        message: {
            name,
            force_avatar: null,
            original_avatar: speaker,
            extra: { api: '', model: '', reasoning_effort: null, gen_id: null },
        },
        reply: {
            token: reply.token,
            speaker,
            anchor,
            origin: reply.origin,
            route: reply.route,
            triggers: /** @type {{ id: string, rev: string }[]} */ (triggers),
            target,
            needs_user: reply.needs_user,
            round_started: reply.round_started,
        },
    };
}
