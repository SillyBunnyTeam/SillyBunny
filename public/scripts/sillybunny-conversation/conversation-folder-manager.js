/**
 * The Folder Manager for the conversations of the persona. The Manager is the shared window of the folder lists; this
 * module gives it the two things that are particular to conversations: a store that keeps the folders on the server for
 * the persona that is current (the Manager asks for it at each call, so a persona that changes under an open Manager
 * shows its own folders), and the conversations of that persona as the items that a folder can hold.
 */

import { eventSource, event_types } from '../../script.js';
import { PLACEHOLDER_COPY } from '../sillybunny-editor/folder-popovers.js';
import { getConversationPersonaId } from './context.js';
import { conversationFolders } from './conversation-folders-browser.js';
import { getConversationListEntries } from './interface.js';
import { MAX_FOLDERS_PER_PERSONA, MAX_FOLDER_NAME_LENGTH } from './folder-model.js';
import { renderConversationParticipantStack } from './media.js';

const SCOPE = 'conversations';

/** The Manager's field takes any length; a folder's name is kept to the one line that the list shows. */
function clampName(name) {
    return String(name).trim().slice(0, MAX_FOLDER_NAME_LENGTH).trim();
}

/** Runs a change and answers whether it was made; a change that the folders module refuses (not loaded, not a colour) is logged. */
function attempt(change) {
    try {
        return change();
    } catch (error) {
        console.warn('Conversation Mode: a folder change was refused', error);
        return false;
    }
}

/**
 * @param {object} [dependencies]
 * @param {ReturnType<typeof import('./conversation-folders.js').createConversationFolders>} [dependencies.folders]
 * @param {() => string} [dependencies.getPersonaId]
 * @param {() => import('./conversation-list-view.js').ListRowEntry[]} [dependencies.getEntries]
 * @returns The adapter of `createFolderManager('conversations', adapter)`.
 */
export function createConversationFolderAdapter({ folders = conversationFolders, getPersonaId = getConversationPersonaId, getEntries = getConversationListEntries } = {}) {
    const store = {
        getFolders: () => folders.layout(getPersonaId()).folders.map(folder => ({ ...folder })),
        getFolderMembers: (_scope, folderId) => folders.membersOf(getPersonaId(), folderId),
        createFolder: (_scope, name, { color = '', expanded = true } = {}) => {
            if (folders.layout(getPersonaId()).folders.length >= MAX_FOLDERS_PER_PERSONA) {
                throw new Error(PLACEHOLDER_COPY);
            }
            return folders.createFolder(getPersonaId(), clampName(name), { color, expanded });
        },
        renameFolder: (_scope, folderId, name) => attempt(() => folders.updateFolder(getPersonaId(), folderId, { name: clampName(name) })),
        deleteFolder: (_scope, folderId) => attempt(() => folders.deleteFolder(getPersonaId(), folderId)),
        moveFolder: (_scope, folderId, delta) => attempt(() => {
            const index = folders.layout(getPersonaId()).folders.findIndex(folder => folder.id === folderId);
            return index >= 0 && folders.moveFolder(getPersonaId(), folderId, index + delta);
        }),
        setFolderColor: (_scope, folderId, color) => attempt(() => folders.updateFolder(getPersonaId(), folderId, { color })),
        setFolderExpanded: (_scope, folderId, expanded) => attempt(() => folders.updateFolder(getPersonaId(), folderId, { expanded })),
        setFolder: (_scope, conversationIds, folderId) => attempt(() => folders.setMembers(getPersonaId(), conversationIds, folderId)),
        removeFromFolder: (_scope, conversationIds, folderId) => attempt(() => {
            const inFolder = conversationIds.filter(id => folders.folderOf(getPersonaId(), id) === folderId);
            return inFolder.length > 0 && folders.setMembers(getPersonaId(), inFolder, null);
        }),
        subscribe: (listener) => folders.subscribe((event) => {
            if (event.type === 'folders') {
                listener({ scope: SCOPE });
            }
        }),
    };

    return {
        store,
        getItems: getEntries,
        getKey: entry => String(entry.id),
        getName: entry => String(entry.name ?? entry.id),
        getAvatar: (entry) => {
            const stack = document.createElement('span');
            renderConversationParticipantStack(stack, entry.participants, { status: entry.status, max: 3, groupId: entry.groupId });
            return stack;
        },
    };
}

/** Opens the Folder Manager for the conversations, and answers when it closes. */
export async function openConversationFolderManager() {
    const { openFolderManager, refreshFolderManager } = await import('../sillybunny-folder-manager.js');
    // The persona is read at each call, so a switch of persona only needs the Manager to draw again.
    eventSource.on(event_types.PERSONA_CHANGED, refreshFolderManager);
    try {
        await openFolderManager(SCOPE, createConversationFolderAdapter());
    } finally {
        eventSource.removeListener(event_types.PERSONA_CHANGED, refreshFolderManager);
    }
}
