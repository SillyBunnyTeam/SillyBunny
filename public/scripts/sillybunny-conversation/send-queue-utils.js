/**
 * SillyBunny: pure, dependency-free helpers for the conversation-mode send queue.
 * Extracted from attachments.js so the coalescing/merging logic can be unit-tested
 * without the heavy DOM + jQuery imports that attachments.js pulls in.
 *
 * See CONTRIBUTING.md "Best Code Practices" — fork-specific helpers live in their
 * own self-contained files where possible.
 */

const DEFAULT_COALESCE_WINDOW_MS = 5000;

/**
 * Two queue items belong to the same conversation thread when they target the same
 * avatar + group and neither is a forced (non-coalescable) item.
 */
export function isSameConversationQueueThread(left, right) {
    return Boolean(
        left
        && right
        && !left.force
        && !right.force
        && left.avatar === right.avatar
        && String(left.groupId || '') === String(right.groupId || ''),
    );
}

/**
 * Merge multiple same-thread queue items into a single item. User texts and
 * attachment contexts are joined with a blank line. The earliest `createdAt` is
 * preserved, the latest is recorded in `latestQueuedAt`, and `messageCount` reflects
 * how many sends were grouped.
 */
export function mergeConversationQueueItems(items) {
    if (items.length <= 1) {
        return items[0] || null;
    }

    const first = items[0];
    return {
        ...first,
        text: items.map(item => item.text).filter(Boolean).join('\n\n'),
        attachmentContext: items.map(item => item.attachmentContext).filter(Boolean).join('\n\n'),
        createdAt: first.createdAt,
        latestQueuedAt: items[items.length - 1]?.createdAt || first.createdAt,
        messageCount: items.length,
    };
}

/**
 * Shift every consecutive same-thread item off the front of `queue` (mutating it),
 * starting with `firstItem`. Stops at the first item that belongs to a different
 * thread. Returns the collected items.
 */
export function drainSameThreadItems(firstItem, queue) {
    const items = [firstItem];
    while (queue.length && isSameConversationQueueThread(firstItem, queue[0])) {
        items.push(queue.shift());
    }
    return items;
}

/**
 * SillyBunny: debounce-from-last-arrival coalescing for the conversation send queue.
 *
 * Before this fix the window was a single 600ms `setTimeout` measured from when an
 * item was *shifted off* the queue. That left two gaps: (1) 600ms is too short for a
 * human to type a follow-up, and (2) the window only opened in the narrow gap before
 * a generation started, so messages typed *while the character was replying* were
 * never merged — each got its own sequential generation ("delay not firing off").
 *
 * The new behaviour: wait the coalesce window, then drain same-thread items from
 * `queue`. If a new item arrived during the wait, restart the window so a rapid
 * burst of messages keeps extending it until the user goes quiet for the full window.
 * This also merges messages that piled up during the previous generation, because
 * they are already sitting in `queue` when the next coalesce starts.
 *
 * On `force` items or when the window is disabled (`windowMs <= 0`) we skip waiting.
 *
 * @param {object} firstItem - The item already shifted off the front of the queue.
 * @param {Array} queue - The live queue array (mutated as items are drained).
 * @param {object} [options]
 * @param {number} [options.windowMs=DEFAULT_COALESCE_WINDOW_MS] - Idle window per round.
 * @param {function} [options.timeoutRef=setTimeout] - Injectable timer (for tests).
 * @returns {Promise<object|null>} The (possibly merged) queue item, or null.
 */
export async function coalesceConversationQueueItems(firstItem, queue, options = {}) {
    if (!firstItem || firstItem.force) {
        return firstItem || null;
    }

    const timeout = typeof options.timeoutRef === 'function' ? options.timeoutRef : setTimeout;
    const windowMs = typeof options.windowMs === 'number' ? options.windowMs : DEFAULT_COALESCE_WINDOW_MS;

    if (windowMs <= 0) {
        return firstItem;
    }

    let items = [firstItem];

    // Wait the idle window. Restart it whenever new same-thread messages land during
    // the wait, so a burst of user messages stays grouped until the user goes quiet
    // for the full window.
    while (true) {
        await new Promise(resolve => timeout(resolve, windowMs));

        const beforeLength = items.length;
        while (queue.length && isSameConversationQueueThread(firstItem, queue[0])) {
            items.push(queue.shift());
        }

        if (items.length === beforeLength) {
            break; // nothing new arrived; stop extending
        }
    }

    return mergeConversationQueueItems(items);
}
