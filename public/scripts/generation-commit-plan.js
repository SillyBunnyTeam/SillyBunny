/**
 * SillyBunny: where a server-owned generation writes its reply when no page is left to do it.
 *
 * The browser attaches a commit plan to a chat generation (X-Generation-Commit header). The plan
 * names the chat file and the exact chat state the reply was generated against, so the server can
 * refuse to write into a chat that moved on. Shared by public/scripts/resumable-generation.js and
 * src/generation-commit.js; keep it free of browser and Node APIs.
 */

export const GENERATION_COMMIT_HEADER = 'x-generation-commit';
export const GENERATION_COMMIT_PLAN_VERSION = 1;
export const GENERATION_COMMIT_KINDS = Object.freeze(['append', 'swipe', 'continue']);

const MAX_PLAN_TEXT_LENGTH = 1024;
const MAX_HEADER_LENGTH = 8192;
const MAX_ROUND_SPEAKERS = 32;

/**
 * 32-bit FNV-1a over UTF-16 code units, as hex. Identical in the browser and in Node.
 * @param {string} text Text to hash
 * @returns {string}
 */
export function hashCommitText(text) {
    let hash = 0x811c9dc5;
    const value = String(text ?? '');
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Identifies a chat message by the fields that survive edits, swipes and save round trips.
 * @param {object|null|undefined} message Chat message
 * @returns {string|null}
 */
export function getMessageIdentity(message) {
    if (!message || typeof message !== 'object') {
        return null;
    }
    return hashCommitText(JSON.stringify([String(message.name ?? ''), Boolean(message.is_user), String(message.send_date ?? '')]));
}

/**
 * @param {{ avatar?: string, group?: string }} chat Chat owner
 * @param {string} file Chat file name without extension
 * @returns {string} Stable key for matching generations to an open chat
 */
export function getCommitChatKey(chat, file) {
    return chat?.group ? `group:${chat.group}:${file}` : `character:${chat?.avatar ?? ''}:${file}`;
}

/**
 * @param {unknown} value Candidate
 * @returns {string|null} Bounded string, or null
 */
function optionalText(value) {
    return typeof value === 'string' && value.length <= MAX_PLAN_TEXT_LENGTH ? value : null;
}

/**
 * Validates and normalizes a plan. Anything unexpected makes the whole plan invalid.
 * @param {any} plan Candidate plan
 * @returns {GenerationCommitPlan|null}
 */
export function normalizeCommitPlan(plan) {
    if (!plan || typeof plan !== 'object' || plan.v !== GENERATION_COMMIT_PLAN_VERSION) {
        return null;
    }
    const kind = GENERATION_COMMIT_KINDS.includes(plan.kind) ? plan.kind : null;
    const avatar = optionalText(plan.chat?.avatar);
    const group = optionalText(plan.chat?.group);
    const file = optionalText(plan.file);
    const index = Number(plan.index);
    if (!kind || !file || (!avatar && !group) || !Number.isInteger(index) || index < 0) {
        return null;
    }
    if (kind !== 'append' && !optionalText(plan.target)) {
        return null;
    }
    if (kind === 'swipe' && !(Number.isInteger(plan.swipes) && plan.swipes > 0)) {
        return null;
    }
    if (kind === 'continue' && !(optionalText(plan.prefix) && Number.isInteger(plan.prefix_length) && plan.prefix_length >= 0)) {
        return null;
    }

    const round = plan.round ?? [];
    if (!Array.isArray(round) || round.length > MAX_ROUND_SPEAKERS || !round.every(avatar => optionalText(avatar))) {
        return null;
    }

    const message = plan.message && typeof plan.message === 'object' ? plan.message : {};
    const extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
    return {
        v: GENERATION_COMMIT_PLAN_VERSION,
        chat: group ? { group } : { avatar },
        file,
        kind,
        index,
        anchor: optionalText(plan.anchor),
        replaces: optionalText(plan.replaces),
        target: optionalText(plan.target),
        swipes: kind === 'swipe' ? plan.swipes : 0,
        prefix: optionalText(plan.prefix),
        prefix_length: kind === 'continue' ? plan.prefix_length : 0,
        started: optionalText(plan.started) ?? '',
        page: optionalText(plan.page) ?? '',
        round: [...round],
        message: {
            name: optionalText(message.name) ?? '',
            force_avatar: optionalText(message.force_avatar),
            original_avatar: optionalText(message.original_avatar),
            extra: {
                api: optionalText(extra.api) ?? '',
                model: optionalText(extra.model) ?? '',
                reasoning_effort: optionalText(extra.reasoning_effort),
                gen_id: Number.isFinite(extra.gen_id) ? extra.gen_id : null,
            },
        },
    };
}

/**
 * @param {GenerationCommitPlan} plan Plan
 * @returns {string} Header value
 */
export function encodeCommitPlan(plan) {
    return encodeURIComponent(JSON.stringify(plan));
}

/**
 * @param {unknown} value Header value
 * @returns {GenerationCommitPlan|null}
 */
export function decodeCommitPlan(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_HEADER_LENGTH) {
        return null;
    }
    try {
        return normalizeCommitPlan(JSON.parse(decodeURIComponent(value)));
    } catch {
        return null;
    }
}

/**
 * @typedef {object} GenerationCommitPlan
 * @property {number} v Plan version
 * @property {{ avatar?: string, group?: string }} chat Character avatar file or group id
 * @property {string} file Chat file name without extension
 * @property {'append'|'swipe'|'continue'} kind How the reply lands in the chat
 * @property {number} index Message index the reply is written to
 * @property {string|null} anchor append: identity of the message before `index`
 * @property {string|null} replaces append: identity of a regenerated message that may still occupy `index`
 * @property {string|null} target swipe/continue: identity of the message at `index`
 * @property {number} swipes swipe: swipe count of the target before this generation
 * @property {string|null} prefix continue: hash of the text the reply continues
 * @property {number} prefix_length continue: length of that text
 * @property {string} started Generation start, ISO timestamp; also marks this generation's in-progress message on disk
 * @property {string} page Id of the page load that started the generation
 * @property {string[]} round Group chats: avatars of the members still to speak after this reply in its round
 * @property {{ name: string, force_avatar: string|null, original_avatar: string|null, extra: { api: string, model: string, reasoning_effort: string|null, gen_id: number|null } }} message Reply fields known up front
 */
