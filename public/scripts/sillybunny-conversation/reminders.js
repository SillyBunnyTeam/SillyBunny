/**
 * What a reminder of a conversation goes through. The worker starts an attempt, and a reminder that fails stops after
 * `MAX_REMINDER_ATTEMPTS` instead of trying every minute for ever. Every function returns the reminder that results and
 * changes nothing, so that the worker and the data module apply the change in one patch.
 *
 * The stored shape is `src/conversation-schema.js`: `fired`, `firedAt`, `attempts`, `lastAttemptAt`, `retryAfter`,
 * `invalidAt` (the chat is gone) and `skippedAt` (given up).
 */

import { hashCommitText } from '../generation-commit-plan.js';
import { REMINDER_RETRY_DELAY_MS } from './constants.js';

/** A reminder that has failed this many times is given up. */
export const MAX_REMINDER_ATTEMPTS = 5;

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
 * Records an attempt before its request starts. The time until the next try is a lease: a page that closes in the
 * middle of the request cannot write anything afterwards, and the lease keeps the next page from starting a second
 * request while the server may still write the first one.
 */
export function claimReminderAttempt(reminder, now) {
    return { ...reminder, attempts: (reminder.attempts ?? 0) + 1, lastAttemptAt: now, retryAfter: now + REMINDER_RETRY_DELAY_MS };
}

/** What an attempt that did not deliver leaves: the reminder, or the reminder given up when it used every attempt. */
export function settleFailedReminderAttempt(reminder, now) {
    return (reminder.attempts ?? 0) >= MAX_REMINDER_ATTEMPTS ? { ...reminder, skippedAt: now } : reminder;
}

export function markReminderDelivered(reminder, now) {
    const { retryAfter: _retryAfter, ...rest } = reminder;
    return { ...rest, fired: true, firedAt: now };
}

/**
 * The reply token of a reminder. It is the same on every attempt and on every page, so that the reply of an attempt that
 * the server wrote, and the reply of a later attempt, are one reply to the chat: the chat refuses the second.
 * @returns {string} 16 hex characters.
 */
export function getReminderToken(reminder) {
    return hashCommitText(`reminder:${reminder.id}`) + hashCommitText(`token:${reminder.id}`);
}
