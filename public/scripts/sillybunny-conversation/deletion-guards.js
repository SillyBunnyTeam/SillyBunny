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
 * Drops the items of the send queue that were made for a removed target. An item carries the id of its conversation
 * as `conversationKey`, and the id of its chat, so that a forced reply that names no message is found as well.
 * @param {object[]} queue Changed in place.
 * @returns {number} How many items were dropped.
 */
export function dropQueuedReplies(queue, removed) {
    let dropped = 0;
    for (let index = queue.length - 1; index >= 0; index--) {
        const queued = queue[index];
        if (isTargetOfRemoval(removed, { conversationId: queued.conversationKey, chatId: queued.chatId })) {
            queue.splice(index, 1);
            dropped++;
        }
    }
    return dropped;
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
