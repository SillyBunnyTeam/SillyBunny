/**
 * SillyBunny: lets one extension at a time plan which members answer ordinary user messages in the open group chat.
 * Extensions reach it as getContext().groupTurnRouting. For each routed message the owner hears turn-started,
 * is asked to plan, then hears acknowledged, reply-started and reply-completed for each planned reply, and finished.
 * A lease ends when its owner releases it, or is revoked when the open chat, group or reply strategy changes.
 */

/**
 * @typedef {object} GroupTurnRoutingScope
 * @property {string} groupId Open group
 * @property {string} chatId Open chat of that group
 * @property {number} strategy The group's reply strategy
 * @property {object[]} chat Messages of the open chat
 */

/**
 * @typedef {NonNullable<ReturnType<ReturnType<typeof createGroupTurnRouting>['startTurn']>>} GroupRoutedTurn
 */

const defaultReasons = {
    declined: 'Native routing answered this message.',
    cancelled: 'The turn was stopped.',
    failed: 'A planned reply was not saved.',
};

/**
 * @param {object} options
 * @param {() => GroupTurnRoutingScope|null} options.getScope The open group chat, or null when none is open
 */
export function createGroupTurnRouting({ getScope }) {
    let lease = null;
    let turn = null;
    let turnCount = 0;

    function deliver(owner, event) {
        const { onEvent } = owner;
        try {
            onEvent(event);
        } catch (error) {
            console.warn(`Group turn routing owner ${owner.ownerId} failed to handle ${event.type}`, error);
        }
    }

    function getScopeChange(owner) {
        const scope = getScope();
        if (!scope) return 'The group chat was closed.';
        if (String(scope.groupId) !== String(owner.groupId)) return 'Another group was opened.';
        if (String(scope.chatId) !== String(owner.chatId)) return 'Another chat was opened.';
        if (scope.strategy !== owner.strategy) return 'The group reply strategy changed.';
        return '';
    }

    function endLease(owner, reason) {
        if (lease === owner) lease = null;
        if (turn?.owner === owner && !turn.cancelReason) turn.cancelReason = reason;
    }

    /**
     * Revokes the lease once the open chat, group or reply strategy no longer matches it.
     */
    function refresh() {
        const owner = lease;
        const reason = owner ? getScopeChange(owner) : '';
        if (reason) {
            endLease(owner, reason);
            deliver(owner, { type: 'revoked', reason });
        }
    }

    function acquire(options) {
        const { ownerId, groupId, chatId, plan, onEvent } = options ?? {};
        if (typeof ownerId !== 'string' || !ownerId || typeof plan !== 'function' || typeof onEvent !== 'function') {
            throw new TypeError('A routing lease needs an ownerId, a plan function and an onEvent function.');
        }

        refresh();
        const scope = getScope();
        if (lease || !scope || scope.chatId == null
            || String(groupId) !== String(scope.groupId) || String(chatId) !== String(scope.chatId)) {
            return null;
        }

        // The owner's own ids go back to it in each plan request, so it can compare them exactly.
        const owner = { ownerId, groupId, chatId, strategy: scope.strategy, plan, onEvent };
        lease = owner;
        return Object.freeze({
            isCurrent: () => lease === owner && !getScopeChange(owner),
            release: reason => endLease(owner, String(reason || 'The routing owner released the lease.')),
            cancel: reason => {
                if (turn?.owner === owner && !turn.cancelReason) {
                    turn.cancelReason = String(reason || 'The routing owner cancelled the turn.');
                }
            },
        });
    }

    /**
     * Starts a routed turn for an ordinary user message when a lease is current.
     * @param {object} options
     * @param {number|string} options.turnId Group generation id, also stored on the turn's replies
     * @param {string} options.text The user's message
     */
    function startTurn({ turnId, text }) {
        refresh();
        const owner = lease;
        if (!owner) return null;

        const requestId = `group-turn-${++turnCount}`;
        const current = { owner, cancelReason: '', isPlanCurrent: null, reply: '', finished: false };
        const send = (type, details = {}) => deliver(owner, { type, requestId, turnId, ...details });
        turn = current;

        function finish(status, reason = '') {
            if (current.finished) return;
            current.finished = true;
            if (turn === current) turn = null;
            if (current.reply) {
                send('reply-completed', { avatar: current.reply, status: status === 'success' ? 'failed' : status });
                current.reply = '';
            }
            const fallback = status === 'cancelled' ? current.cancelReason || defaultReasons.cancelled : defaultReasons[status];
            send('finished', { status, reason: String(reason || fallback || '') });
        }

        function stopIfEnded() {
            refresh();
            if (!current.cancelReason && current.isPlanCurrent) {
                let isPlanCurrent = false;
                try {
                    isPlanCurrent = current.isPlanCurrent() === true;
                } catch (error) {
                    console.warn(`Group turn routing owner ${owner.ownerId} failed to check its plan`, error);
                }
                if (!isPlanCurrent) current.cancelReason = 'The routing plan is no longer current.';
            }
            if (current.cancelReason) finish('cancelled');
            return current.finished;
        }

        send('turn-started');
        return {
            /**
             * Asks the owner who answers. Null hands the message back to native routing.
             * @param {(avatar: string) => number} resolveMember Character id of an enabled group member, or -1
             * @returns {number[]|null} Character ids in reply order
             */
            plan(resolveMember) {
                if (current.finished || current.isPlanCurrent || stopIfEnded()) return null;

                const { plan } = owner;
                let result = null;
                try {
                    result = plan({ requestId, turnId, groupId: owner.groupId, chatId: owner.chatId, chat: getScope()?.chat, text });
                } catch (error) {
                    console.warn(`Group turn routing owner ${owner.ownerId} failed to plan a turn`, error);
                }

                const avatars = Array.isArray(result?.avatars) ? result.avatars : null;
                const members = avatars?.map(avatar => typeof avatar === 'string' ? resolveMember(avatar) : -1);
                if (!members || members.includes(-1) || new Set(avatars).size !== avatars.length) {
                    finish('declined');
                    return null;
                }

                current.isPlanCurrent = typeof result.isCurrent === 'function' ? result.isCurrent : () => true;
                return members;
            },
            acknowledge() {
                if (!current.finished && current.isPlanCurrent) send('acknowledged');
            },
            /**
             * @returns {boolean} False when the turn was cancelled, its lease ended or its plan went stale
             */
            startReply(avatar) {
                if (current.finished || !current.isPlanCurrent || stopIfEnded()) return false;
                current.reply = avatar;
                send('reply-started', { avatar });
                return true;
            },
            /**
             * @param {string} avatar
             * @param {'success'|'failed'|'cancelled'} status
             * @returns {boolean} Whether the turn goes on to the next reply
             */
            finishReply(avatar, status) {
                if (current.finished || current.reply !== avatar) return false;
                current.reply = '';
                send('reply-completed', { avatar, status });
                if (status !== 'success') finish(status);
                return !current.finished;
            },
            finish,
        };
    }

    return { api: Object.freeze({ version: 1, acquire }), startTurn, refresh };
}
