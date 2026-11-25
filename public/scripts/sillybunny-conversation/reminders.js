/**
 * What a reminder of a conversation goes through. The worker starts an attempt, and a reminder that fails stops after
 * `MAX_REMINDER_ATTEMPTS` instead of trying every minute for ever. The functions that change a reminder return the
 * change and write nothing; the worker and the finalizer apply it with `conversationData.patchReminder()`.
 *
 * The stored shape is `src/conversation-schema.js`: `fired`, `firedAt`, `attempts`, `lastAttemptAt`, `retryAfter`,
 * `invalidAt` (the chat is gone) and `skippedAt` (given up).
 */

import { hashCommitText } from '../generation-commit-plan.js';

/** A reminder that has failed this many times is given up. */
export const MAX_REMINDER_ATTEMPTS = 5;
/** How long an attempt holds the reminder before another may start. */
export const REMINDER_LEASE_MS = 60 * 1000;

/**
 * @param {Record<string, any>} reminder
 * @returns {'scheduled'|'delivered'|'invalid'|'given-up'}
 */
export function getReminderState(reminder) {
    if (reminder.fired) {
        return 'delivered';
    }
    if (reminder.invalidAt) {
        return 'invalid';
    }
    if (reminder.skippedAt) {
        return 'given-up';
    }
    return 'scheduled';
}

/** Whether the worker should try to deliver the reminder now. */
export function isReminderDue(reminder, now) {
    return getReminderState(reminder) === 'scheduled'
        && (reminder.attempts ?? 0) < MAX_REMINDER_ATTEMPTS
        && now >= reminder.triggerAt
        && now >= (reminder.retryAfter ?? 0);
}

/**
 * The change that records an attempt before its request starts (`conversationData.patchReminder()`; null removes a
 * field). The time until the next try is a lease: a page that closes in the middle of the request cannot write anything
 * afterwards, and the lease keeps the next page from starting a second request while the server may still write the first.
 */
export function claimReminderAttempt(reminder, now) {
    return { attempts: (reminder.attempts ?? 0) + 1, lastAttemptAt: now, retryAfter: now + REMINDER_LEASE_MS };
}

/**
 * The change after an attempt that did not deliver. `reminder` is the reminder as the attempt left it, so that it has
 * the count that the attempt added; a reminder that used every attempt is given up.
 */
export function settleFailedReminderAttempt(reminder, now) {
    return (reminder.attempts ?? 0) >= MAX_REMINDER_ATTEMPTS ? { skippedAt: now } : {};
}

/** The change that records a delivered reminder. The page that wrote the reply and the page that landed the server's copy both write it. */
export function markReminderDelivered(now) {
    return { fired: true, firedAt: now, retryAfter: null };
}

/**
 * The reply token of a reminder. It is the same on every attempt and on every page, so that the reply of an attempt that
 * the server wrote, and the reply of a later attempt, are one reply to the chat: the chat refuses the second.
 * @returns {string} 16 hex characters.
 */
export function getReminderToken(reminder) {
    return hashCommitText(`reminder:${reminder.id}`) + hashCommitText(`token:${reminder.id}`);
}
