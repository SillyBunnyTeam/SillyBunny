/**
 * What the conversation list does with folders that is not drawing and not a drag: the menu that moves a row to a folder,
 * and the folder that a row menu makes. It works through the folders module and the controls of the list, which give it the
 * state of the sections, so that the section that a move opens is stored the same way wherever the move came from.
 */

import { openActionMenu } from '../sillybunny-action-menu.js';
import { openFolderNamePopover, PLACEHOLDER_COPY } from '../sillybunny-editor/folder-popovers.js';
import { MAX_FOLDERS_PER_PERSONA, MAX_FOLDER_NAME_LENGTH } from './folder-model.js';
import { setConversationFolder } from './conversation-list-actions.js';
import { buildMoveToFolderSections } from './conversation-menus.js';
import { describeFolderChange, folderSectionKey, planFolderChange } from './conversation-list-model.js';
import { getRowControl, highlightMovedRow } from './conversation-list-view.js';

/**
 * @param {object} context
 * @param {HTMLElement} context.list The scroller of the list.
 * @param {HTMLElement|null} context.aside The sidebar, which bounds the menus.
 * @param {ReturnType<typeof import('./conversation-folders.js').createConversationFolders>} context.folders
 * @param {() => string} context.getPersonaId
 * @param {() => import('./conversation-folders.js').FolderLayout} context.getLayout
 * @param {(text: string) => void} context.announce
 * @param {() => void} context.render
 * @param {(key: string) => boolean} context.isSectionOpen
 * @param {(key: string, open: boolean) => void} context.storeSectionOpen
 * @param {() => void} context.commitKeyOpen Stores the section that an Alt key opened for now, because something else is happening.
 */
export function createListFolderActions({ list, aside, folders, getPersonaId, getLayout, announce, render, isSectionOpen, storeSectionOpen, commitKeyOpen }) {
    /**
     * Changes the folder of a row and nothing else. A favourite stays in Favorites, and the text says so; any other row moves
     * to its folder, which opens if it is closed, so that the row stays in sight with its highlight.
     * @returns {boolean} False when the row has that folder already, or the change could not be made.
     */
    function changeFolder(entry, folderId) {
        commitKeyOpen();
        if (!planFolderChange(entry, folderId) || !setConversationFolder(folders, getPersonaId(), entry.id, folderId)) {
            return false;
        }
        const key = folderId ? folderSectionKey(folderId) : '';
        if (key && !entry.favorite && !isSectionOpen(key)) {
            storeSectionOpen(key, true);
        }
        highlightMovedRow(list, entry.id);
        announce(describeFolderChange(entry, folderId, getLayout().folders));
        render();
        return true;
    }

    /** Asks for a name, makes the folder and files the row in it, as one request. */
    function askForNewFolder(row, entry) {
        const trigger = getRowControl(row);
        if (!trigger) {
            return;
        }
        openFolderNamePopover({
            trigger,
            bounds: aside,
            title: 'New Folder',
            submitLabel: 'Create',
            maxLength: MAX_FOLDER_NAME_LENGTH,
            onSubmit: (name) => {
                commitKeyOpen();
                if (getLayout().folders.length >= MAX_FOLDERS_PER_PERSONA) {
                    throw new Error(PLACEHOLDER_COPY);
                }
                const folder = folders.createFolderWith(getPersonaId(), name, [entry.id]);
                if (!entry.favorite && !isSectionOpen(folderSectionKey(folder.id))) {
                    storeSectionOpen(folderSectionKey(folder.id), true);
                }
                highlightMovedRow(list, entry.id);
                announce(describeFolderChange(entry, folder.id, getLayout().folders));
                render();
                return { focus: () => getRowControl(list.querySelector(`[data-conversation-id="${entry.id}"]`))?.focus({ preventScroll: true }) };
            },
        });
    }

    /**
     * Opens the radio menu of the folders on a row, in the place of the row menu that chose Move to Folder.
     * @param {HTMLElement} row
     * @param {import('./conversation-list-model.js').ListEntry} entry
     * @param {{ keyboard?: boolean }} [options] The menu that asked for this one was opened by keyboard, so the first item is focused.
     */
    function openMoveMenu(row, entry, { keyboard = false } = {}) {
        const trigger = getRowControl(row);
        if (!trigger) {
            return;
        }
        openActionMenu({
            trigger,
            title: 'Move to Folder',
            sections: buildMoveToFolderSections(entry, getLayout().folders, {
                setFolder: folderId => void changeFolder(entry, folderId),
                newFolder: () => askForNewFolder(row, entry),
            }),
            keyboard,
            bounds: aside,
        });
    }

    return { changeFolder, openMoveMenu };
}
