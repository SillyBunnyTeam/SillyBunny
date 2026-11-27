/**
 * What the bulk actions of the details window decide without touching the page: how many rows a long list shows, which
 * attachment a key names, what removing attachments leaves of a message, and in which order chats are deleted. The
 * pages call these functions and draw the answer; nothing here imports the browser, so the unit tests run it as it is.
 */

/** A long list shows this many rows at first, and this many more on each Show More. */
export const SHOW_MORE_BATCH = 50;

/** @returns {number} The count that a list shows after a Show More, never above the total. */
export function nextShownCount(shown, total) {
    return Math.min(Math.max(0, total), Math.max(0, shown) + SHOW_MORE_BATCH);
}

// ---------------------------------------------------------------------------------------------------------------------
// Which attachment a key names

const SHARED_ITEM_KEY = /^(.+):(?:(image)|media:(\d+)|file:(\d+))$/;

/**
 * Reads the key that `collectSharedItems` gives an item of the Media or Files page: the message, and which of its
 * attachments the item is. The index counts in the list as the message stores it, whatever the page shows.
 * @returns {{ messageId: string, part: 'image' }|{ messageId: string, part: 'media'|'file', index: number }|null} Null for any other key, which includes a pin.
 */
export function parseSharedItemKey(key) {
    const match = SHARED_ITEM_KEY.exec(typeof key === 'string' ? key : '');
    if (!match) {
        return null;
    }
    const [, messageId, image, mediaIndex, fileIndex] = match;
    if (image) {
        return { messageId, part: 'image' };
    }
    return mediaIndex === undefined
        ? { messageId, part: 'file', index: Number(fileIndex) }
        : { messageId, part: 'media', index: Number(mediaIndex) };
}

const hasEntries = value => Array.isArray(value) && value.length > 0;

/**
 * Whether a message shows nothing: no text and no attachment of any kind. Any entry of a list counts as an attachment,
 * also one that a page does not list, so that a message that holds something is never called empty.
 */
export function isMessageEmpty(message) {
    const extra = message?.extra ?? {};
    return String(message?.mes ?? '').trim() === ''
        && !hasEntries(extra.media)
        && !hasEntries(extra.files)
        && !hasEntries(extra.attachments)
        && String(extra.image_url ?? '').trim() === '';
}

// ---------------------------------------------------------------------------------------------------------------------
// Removing attachments from the messages of a chat

/**
 * @typedef {object} AttachmentRemovalPlan
 * @property {number} removed How many attachments go.
 * @property {{ messageId: string, extra: Record<string, any> }[]} updates The extra that each surviving message gets.
 * @property {string[]} emptied The messages that have no text and no attachment left, in the order of the chat. They get
 * no update: the deletion path of messages takes them out.
 */

function pickByMessage(keys) {
    const picked = new Map();
    for (const key of new Set(keys)) {
        const parsed = parseSharedItemKey(key);
        if (!parsed) {
            continue;
        }
        const entry = picked.get(parsed.messageId) ?? { image: false, media: new Set(), file: new Set() };
        if (parsed.part === 'image') {
            entry.image = true;
        } else {
            entry[parsed.part].add(parsed.index);
        }
        picked.set(parsed.messageId, entry);
    }
    return picked;
}

function withoutIndices(list, indices) {
    const kept = (Array.isArray(list) ? list : []).filter((_, index) => !indices.has(index));
    return { kept, gone: (Array.isArray(list) ? list.length : 0) - kept.length };
}

/**
 * Works out what taking attachments out of a chat does to its messages, without changing them. The text of a message
 * stays; the key of a list that loses its last item goes, and the generated picture goes with its prompt.
 * @param {Record<string, any>[]} messages The loaded messages of the chat.
 * @param {Iterable<string>} keys Keys of items of the Media or Files page.
 * @returns {AttachmentRemovalPlan}
 */
export function planAttachmentRemoval(messages, keys) {
    const picked = pickByMessage(keys);
    /** @type {AttachmentRemovalPlan} */
    const plan = { removed: 0, updates: [], emptied: [] };
    if (!picked.size) {
        return plan;
    }
    for (const message of Array.isArray(messages) ? messages : []) {
        const choice = message?.id ? picked.get(String(message.id)) : null;
        if (!choice) {
            continue;
        }
        const extra = { ...message.extra };
        let count = 0;
        if (choice.image && String(extra.image_url ?? '').trim()) {
            delete extra.image_url;
            delete extra.image_prompt;
            count += 1;
        }
        for (const [part, field] of [['media', 'media'], ['file', 'files']]) {
            const { kept, gone } = withoutIndices(message.extra?.[field], choice[part]);
            if (!gone) {
                continue;
            }
            count += gone;
            if (kept.length) {
                extra[field] = kept;
            } else {
                delete extra[field];
            }
        }
        if (!count) {
            continue;
        }
        plan.removed += count;
        const messageId = String(message.id);
        if (isMessageEmpty({ ...message, extra })) {
            plan.emptied.push(messageId);
        } else {
            plan.updates.push({ messageId, extra });
        }
    }
    return plan;
}

/** Writes the updates of a plan into the messages of a chat. The extra of a message is replaced, as every writer of it does. */
export function applyAttachmentRemoval(messages, plan) {
    const byId = new Map(messages.map(message => [String(message.id), message]));
    for (const { messageId, extra } of plan.updates) {
        const message = byId.get(messageId);
        if (message) {
            message.extra = extra;
        }
    }
}

const titleCase = word => word.charAt(0).toUpperCase() + word.slice(1);
const count = (number, noun) => `${number} ${titleCase(noun)}${number === 1 ? '' : 's'}`;

/**
 * The title of the alert that asks before attachments leave a chat. It counts the messages that go with them.
 * @param {{ removed: number, noun: string, emptied: number }} counts
 */
export function attachmentRemovalTitle({ removed, noun, emptied }) {
    return emptied
        ? `Remove ${count(removed, noun)} and Delete ${count(emptied, 'message')}?`
        : `Remove ${count(removed, noun)} From Chat?`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Deleting chats

/**
 * The order in which chosen chats are deleted: the chats of the list first and the open chat last, so that the server
 * picks the chat to show once, from the chats that stay. When every chat is chosen, the server makes one empty chat.
 * @param {{ id: string }[]} chats The chats of the conversation, in the order of the list.
 * @param {string} activeChatId
 * @param {Iterable<string>} chosenIds
 * @returns {{ order: string[], deletesActive: boolean, leavesNone: boolean }}
 */
export function planChatDeletion(chats, activeChatId, chosenIds) {
    const chosen = new Set(chosenIds);
    const listed = chats.map(chat => chat.id).filter(id => chosen.has(id));
    return {
        order: [...listed.filter(id => id !== activeChatId), ...listed.filter(id => id === activeChatId)],
        deletesActive: listed.includes(activeChatId),
        leavesNone: listed.length > 0 && listed.length === chats.length,
    };
}

export function chatDeletionTitle(number) {
    return `Delete ${count(number, 'chat')}?`;
}
