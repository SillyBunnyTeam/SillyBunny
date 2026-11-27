/**
 * What the bulk actions of the details window do to the app: export chats and download attachments as one ZIP, remove
 * attachments from the open chat, and delete chats. Each function asks before it destroys something, tells the user what
 * went wrong, and resolves to whether the action is done, which is what ends selection mode.
 */

import { confirmConversationAction } from '../dialogs.js';
import { deleteConversationChat } from '../context.js';
import { SAFE_TOAST_OPTIONS } from '../constants.js';
import { isConversationActive } from '../notifications.js';
import { scheduleConversationListRender, scheduleInterfaceRefresh, scheduleTimelineRender } from '../render-scheduler.js';
import { deleteMessagesInChat } from '../timeline-render.js';
import { conversationData, getCardName } from './access.js';
import { identityOf } from './actions.js';
import {
    createArchive,
    dataUrlExtension,
    fetchArchiveEntries,
    fileNameFromUrl,
    formatFailedFiles,
    isFetchableAttachmentUrl,
    planArchiveNames,
    sanitiseFileName,
} from './bulk-archive.js';
import {
    applyAttachmentRemoval,
    attachmentRemovalTitle,
    chatDeletionTitle,
    planAttachmentRemoval,
    planChatDeletion,
} from './bulk-logic.js';

// TODO(copy): the body of the alerts that ask before chats are deleted or items are removed from a chat is a placeholder.
const ALERT_BODY = 'TODO(copy)';
/** The browser needs the address of a download for as long as it takes to start it; a revoke right after the click can cancel it. */
const OBJECT_URL_LIFETIME = 30_000;

const toast = (kind, message) => globalThis.toastr?.[kind]?.(message, '', { ...SAFE_TOAST_OPTIONS });

/** Loaded when a download starts, so that nothing of the library is fetched at startup or when the window opens. */
async function loadJsZip() {
    if (!globalThis.JSZip) {
        await import('../../../lib/jszip.min.js');
    }
    return globalThis.JSZip;
}

function saveBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME);
}

/** What a conversation is called in the name of a file: the name of a group, the name on the card of a direct conversation. */
function conversationLabel(view) {
    return view.name || getCardName(view.characters?.[0]) || 'Conversation';
}

/**
 * Makes the ZIP of the entries and saves it. Files that failed are named in a toast; the others are saved all the same.
 * @returns {Promise<boolean>} False when nothing could be saved, so that the selection stays and the user can try again.
 */
async function saveArchive({ entries, failed, fileName, failureMessage }) {
    if (failed.length) {
        toast(entries.length ? 'warning' : 'error', `${failureMessage}: ${formatFailedFiles(failed.map(item => item.name))}`);
    }
    if (!entries.length) {
        return false;
    }
    try {
        saveBlob(await createArchive(await loadJsZip(), entries), `${sanitiseFileName(fileName, 'Archive')}.zip`);
    } catch (error) {
        console.error('Conversation Mode: the archive could not be made', error);
        toast('error', 'The archive could not be made');
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Chats

/**
 * One ZIP of the JSONL files of chats, each named after its chat.
 * @param {Record<string, any>} view The conversation.
 * @param {string[]} chatIds In the order that the page lists them.
 */
export async function exportChatsArchive(view, chatIds) {
    const chats = chatIds.map(id => view.chats.find(chat => chat.id === id)).filter(Boolean);
    if (!chats.length) {
        return false;
    }
    const names = planArchiveNames(chats.map(chat => ({ name: chat.name, fallback: 'Chat' })), '.jsonl');
    const encoder = new TextEncoder();
    const { entries, failed } = await fetchArchiveEntries(
        chats.map((chat, index) => ({ name: names[index], source: chat.id })),
        async chatId => encoder.encode((await conversationData.exportChat({ conversationId: view.id, chatId })).text),
    );
    return saveArchive({ entries, failed, fileName: `${conversationLabel(view)} Chats`, failureMessage: 'Could not export' });
}

/**
 * Deletes chats after the user confirms, through the same path as Delete Chat, so that the replies being written for a
 * chat stop and the server picks the chat to show. The open chat goes last. When every chat is chosen the server makes
 * one empty chat.
 * @returns {Promise<boolean>}
 */
export async function deleteChats(conversationId, chatIds) {
    const view = conversationData.get(conversationId);
    if (!view) {
        return false;
    }
    const plan = planChatDeletion(view.chats, view.activeChatId, chatIds);
    if (!plan.order.length || !await confirmConversationAction({ title: chatDeletionTitle(plan.order.length), text: ALERT_BODY })) {
        return false;
    }
    const { avatar, groupId } = identityOf(view);
    let allDeleted = true;
    for (const chatId of plan.order) {
        try {
            await deleteConversationChat(avatar, chatId, { groupId, personaId: view.personaId });
        } catch (error) {
            console.error('Conversation Mode: a chat could not be deleted', error);
            toast('error', 'The chats could not all be deleted');
            allDeleted = false;
            break;
        }
    }
    if (isConversationActive(avatar, groupId)) {
        scheduleInterfaceRefresh();
    } else {
        scheduleConversationListRender();
    }
    return allDeleted;
}

// ---------------------------------------------------------------------------------------------------------------------
// Media and Files

const FALLBACK_NAMES = Object.freeze({ image: 'Picture', video: 'Video', audio: 'Audio', file: 'File' });

function archiveNameOf(item) {
    const own = item.kind === 'file' || item.kind === 'audio' ? item.name : '';
    return own || fileNameFromUrl(item.url);
}

async function fetchSameOrigin(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) {
        throw new Error(`The file answered ${response.status}.`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

/**
 * One ZIP of the files that the items point to. A file that cannot be fetched is named in a toast, and the rest still download.
 * @param {Record<string, any>} view
 * @param {{ kind: string, url: string, name?: string }[]} items In the order that the page lists them.
 * @param {string} section "Media" or "Files": it ends the name of the ZIP.
 */
export async function downloadAttachmentsArchive(view, items, section) {
    if (!items.length) {
        return false;
    }
    const names = planArchiveNames(items.map((item, index) => ({
        name: archiveNameOf(item),
        fallback: `${FALLBACK_NAMES[item.kind] ?? 'File'} ${index + 1}${dataUrlExtension(item.url)}`,
    })));
    const candidates = items.map((item, index) => ({ name: names[index], source: item.url }));
    const reachable = candidates.filter(candidate => isFetchableAttachmentUrl(candidate.source, globalThis.location.href));
    const unreachable = candidates.filter(candidate => !reachable.includes(candidate));
    const { entries, failed } = await fetchArchiveEntries(reachable, fetchSameOrigin);
    // The entries come back in the order of the list, with the files that were not fetched left out.
    return saveArchive({
        entries,
        failed: [...failed, ...unreachable.map(candidate => ({ name: candidate.name, error: new Error('Not a file of this app.') }))],
        fileName: `${conversationLabel(view)} ${section}`,
        failureMessage: 'Could not download',
    });
}

/**
 * Takes attachments out of the open chat of a conversation after the user confirms. The text of a message stays; a
 * message left with no text and no attachment is deleted through the path that deletes messages. The file on disk stays
 * for Data Maid. The edit is one save of the chat.
 * @param {string} conversationId
 * @param {string[]} keys Keys of items of the Media or Files page.
 * @param {'item'|'file'} noun What the alert calls the items.
 * @returns {Promise<boolean>}
 */
export async function removeAttachmentsFromChat(conversationId, keys, noun) {
    const view = conversationData.get(conversationId);
    const address = view?.activeChatId ? { conversationId, chatId: view.activeChatId } : null;
    const loaded = address && conversationData.chat(address);
    if (!loaded) {
        return false;
    }
    const plan = planAttachmentRemoval(loaded.messages, keys);
    if (!plan.removed) {
        return false;
    }
    const confirmed = await confirmConversationAction({
        title: attachmentRemovalTitle({ removed: plan.removed, noun, emptied: plan.emptied.length }),
        text: ALERT_BODY,
        confirmLabel: 'Remove',
    });
    if (!confirmed) {
        return false;
    }
    // The chat can change while the alert is open, so the plan is made again from the messages as they are now.
    if (!conversationData.chat(address)) {
        return false;
    }
    const current = planAttachmentRemoval(conversationData.chat(address).messages, keys);
    if (current.updates.length) {
        conversationData.commitChat(address, chat => applyAttachmentRemoval(chat.messages, current));
    }
    if (current.emptied.length) {
        deleteMessagesInChat(address, current.emptied);
    }
    scheduleTimelineRender();
    return true;
}
