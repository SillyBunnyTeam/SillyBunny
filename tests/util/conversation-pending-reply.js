/**
 * A reply that the server wrote into a conversation chat while no page took it, in the shape of section 2.3 of
 * `generation-design.md` (the shape that `src/conversation-generation-commit.js` writes).
 */

const FINISHED_AT = Date.UTC(2026, 5, 1, 12, 30, 0);

/**
 * @param {object} [options]
 * @param {string} [options.text] The raw reply, before any clean-up.
 * @param {string} [options.speaker] Avatar of the member that spoke.
 * @param {string} [options.anchor] Avatar that names the conversation; a speaker that differs from it is a member.
 * @param {string} [options.name] Name of the speaker.
 * @param {'raw'|'profile'} [options.route]
 * @param {string[]} [options.round] Avatars still to speak after this reply.
 * @param {string[]} [options.triggers] Ids of the messages that the reply answers.
 * @param {string} [options.token]
 * @param {number} [options.finishedAt]
 * @returns {object} The message record.
 */
export function pendingReply({
    text = 'hello there',
    speaker = 'Nova.png',
    anchor = 'Nova.png',
    name = 'Nova',
    route = 'profile',
    round = [],
    triggers = [],
    token = 'abcdef0123456789',
    finishedAt = FINISHED_AT,
    generationId = 'gen-1',
    roundStarted = finishedAt - 4000,
    target = null,
} = {}) {
    const isMember = speaker !== anchor;
    return {
        id: `${finishedAt}-${token.slice(0, 8)}`,
        role: isMember ? 'member' : 'character',
        name,
        is_user: false,
        is_system: false,
        mes: text,
        send_date: new Date(finishedAt).toISOString(),
        created_at: finishedAt,
        extra: {
            ...(isMember ? { member_avatar: speaker } : {}),
            reply_token: token,
            server_generation: {
                id: generationId,
                kind: 'reply',
                pending: true,
                token,
                origin: 'reply',
                route,
                speaker,
                anchor,
                round,
                round_started: roundStarted,
                triggers,
                target,
            },
        },
    };
}
