/**
 * What a deleted conversation or chat takes with it: the replies that are being generated for it are cancelled, the
 * replies that wait in the send queue are dropped, and a reply that is ready to be written checks first that its
 * target still exists. Nothing here imports the page, so that the rules run in a unit test.
 *
 * A target is `{ conversationId, chatId? }`. A target without a chat id means the whole conversation.
 */

/** @param {{ conversationId: string, chatId?: string }} removed @param {{ conversationId: string, chatId?: string }} candidate */
export function isTargetOfRemoval(removed, candidate) {
    return candidate.conversationId === removed.conversationId && (!removed.chatId || candidate.chatId === removed.chatId);
}

/**
 * Takes the items of the send queue that match out of it. The queue is the page's own array, so it is changed in place.
 * @param {object[]} queue
 * @param {(item: object) => boolean} matches
 * @returns {object[]} The items that were removed, in the order that the queue had them.
 */
export function removeQueueItems(queue, matches) {
    const removed = [];
    for (let index = queue.length - 1; index >= 0; index--) {
        if (matches(queue[index])) {
            removed.unshift(queue[index]);
            queue.splice(index, 1);
        }
    }
    return removed;
}

/**
 * Drops the items of the send queue that were made for a removed target. An item carries the id of its conversation
 * as `conversationKey`, and the id of its chat, so that a forced reply that names no message is found as well.
 * @param {object[]} queue Changed in place.
 * @returns {number} How many items were dropped.
 */
export function dropQueuedReplies(queue, removed) {
    return removeQueueItems(queue, queued => isTargetOfRemoval(removed, { conversationId: queued.conversationKey, chatId: queued.chatId })).length;
}

/** The replies that are being generated, so that a deletion can stop the request instead of waiting for its answer. */
export function createGenerationTargets() {
    /** @type {Set<{ target: { conversationId: string, chatId: string }, controller: AbortController }>} */
    const running = new Set();
    return {
        /**
         * @param {{ conversationId: string, chatId: string }|null} target Null for a reply of a conversation that does not exist yet; it is not tracked.
         * @returns {{ signal: AbortSignal, end: () => void }}
         */
        begin(target) {
            const controller = new AbortController();
            if (!target) {
                return { signal: controller.signal, end: () => {} };
            }
            const entry = { target, controller };
            running.add(entry);
            return { signal: controller.signal, end: () => running.delete(entry) };
        },
        cancel(removed) {
            for (const entry of [...running]) {
                if (isTargetOfRemoval(removed, entry.target)) {
                    entry.controller.abort();
                }
            }
        },
        /** Stops every reply in progress: the page is closing. */
        abortAll() {
            for (const entry of [...running]) {
                entry.controller.abort();
            }
        },
        get size() {
            return running.size;
        },
    };
}

/**
 * Makes the check that a reply runs just before it writes. It reads the conversation again on each call, so a deletion
 * after the reply was started makes it false.
 * @param {(id: string) => ({ chats: { id: string, hasUserMessage?: boolean }[] }|null)} readConversation
 * @param {{ conversationId: string, chatId: string }} target
 * @param {{ needsUserMessage?: boolean }} [options] An automatic message needs a message from the user in the chat; a reminder does not.
 * @returns {() => boolean}
 */
export function createTargetCheck(readConversation, { conversationId, chatId }, { needsUserMessage = false } = {}) {
    return () => {
        const entry = readConversation(conversationId)?.chats.find(item => item.id === chatId);
        return Boolean(entry) && (!needsUserMessage || entry.hasUserMessage === true);
    };
}

/** The replies of this page that are being generated. */
export const generationTargets = createGenerationTargets();

/**
 * Connects the data module's announcement of a removal to the cancel and the queue drop.
 * @param {{ onRemoval: (listener: Function) => () => void, queue: object[], targets: ReturnType<typeof createGenerationTargets> }} parts
 * @returns {() => void} Removes the listener.
 */
export function installRemovalEffects({ onRemoval, queue, targets }) {
    return onRemoval((removed) => {
        targets.cancel(removed);
        dropQueuedReplies(queue, removed);
    });
}

/**
 * A page that closes hands the replies that it is reading to the server (`releaseActiveGenerations()` in
 * `resumable-generation.js`, on `pagehide`), and the server then writes each reply when it is finished. A request that is
 * not stopped stays open for a moment after that, and when the reply ends in that moment the page claims it, which tells
 * the server that the page saves it and takes the server's copy back out of the chat, and a page that is being destroyed
 * does not save it. Stopping the request after the hand-over closes its connection, and the server keeps its copy.
 * Roleplay stops its stream in its own `pagehide` handler for the same reason. A page that goes to the back-forward
 * cache can come back and takes its replies back (`reattachActiveGenerations()`), so only a page that is hidden for good stops them.
 * @param {{ target: Pick<Window, 'addEventListener' | 'removeEventListener'>, targets: ReturnType<typeof createGenerationTargets> }} parts
 * Register this after `resumable-generation.js` has: the listeners run in the order that they were added.
 * @returns {() => void} Removes the listener.
 */
export function installPageLeaveEffects({ target, targets }) {
    const onPageHide = (event) => {
        if (!event.persisted) {
            targets.abortAll();
        }
    };
    target.addEventListener('pagehide', onPageHide);
    return () => target.removeEventListener('pagehide', onPageHide);
}
