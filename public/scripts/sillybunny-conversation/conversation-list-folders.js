/**
 * What the conversation list does with folders that is not drawing and not a drag: the menu that moves a row to a folder,
 * the folder that a row menu makes, the menu of a folder's heading (Rename, Colour, Delete) and New Folder. It works through
 * the folders module and the controls of the list, which give it the state of the sections, so that the section that a move
 * opens is stored the same way wherever the move came from.
 */

import { openActionMenu } from '../sillybunny-action-menu.js';
import { confirmFolderDelete, openFolderColorPopover, openFolderNamePopover, PLACEHOLDER_COPY } from '../sillybunny-editor/folder-popovers.js';
import { MAX_FOLDERS_PER_PERSONA, MAX_FOLDER_NAME_LENGTH } from './folder-model.js';
import { setConversationFolder } from './conversation-list-actions.js';
import { buildFolderMenuSections, buildMoveToFolderSections } from './conversation-menus.js';
import { describeFolderChange, folderIdOfSection, folderSectionKey, planFolderChange } from './conversation-list-model.js';
import { getHeadingControl, getRowControl, highlightMovedRow } from './conversation-list-view.js';

// About a second of frames for the alert to finish closing and the list to draw before focus is given up on.
const FOCUS_RETURN_FRAMES = 60;

/**
 * Opens the popover that asks for the name of a new folder, and makes the folder at the end of the persona's folders.
 * @param {object} options
 * @param {HTMLElement} options.trigger The button that the popover opens from.
 * @param {HTMLElement|null} options.bounds
 * @param {ReturnType<typeof import('./conversation-folders.js').createConversationFolders>} options.folders
 * @param {string} options.personaId
 * @param {(text: string) => void} options.announce
 * @param {() => void} options.render
 */
export function openNewFolderPopover({ trigger, bounds, folders, personaId, announce, render }) {
    openFolderNamePopover({
        trigger,
        bounds,
        title: 'New Folder',
        submitLabel: 'Create',
        maxLength: MAX_FOLDER_NAME_LENGTH,
        onSubmit: (name) => {
            if (folders.layout(personaId).folders.length >= MAX_FOLDERS_PER_PERSONA) {
                throw new Error(PLACEHOLDER_COPY);
            }
            const folder = folders.createFolder(personaId, name);
            announce(`${folder.name} created`);
            render();
        },
    });
}

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

    function renameFolder(button, folder) {
        openFolderNamePopover({
            trigger: button,
            bounds: aside,
            title: 'Rename Folder',
            submitLabel: 'Rename',
            trackTrigger: false,
            value: folder.name,
            maxLength: MAX_FOLDER_NAME_LENGTH,
            onSubmit: (name) => {
                folders.updateFolder(getPersonaId(), folder.id, { name });
                announce(`${folder.name} renamed to ${name}`);
                render();
            },
        });
    }

    function colourFolder(button, folder) {
        openFolderColorPopover({
            trigger: button,
            bounds: aside,
            trackTrigger: false,
            value: folder.color,
            onChange: (color) => {
                try {
                    folders.updateFolder(getPersonaId(), folder.id, { color });
                } catch (error) {
                    console.warn('Conversation Mode: a folder colour was refused', error);
                }
                render();
            },
        });
    }

    /** Asks first, then deletes the folder: its conversations are in no folder after. Focus goes to the heading that followed it, else the one before. */
    async function deleteFolder(button, folder) {
        const buttons = [...list.querySelectorAll('.sb-conversation-list-heading-button')];
        const index = buttons.indexOf(button);
        const neighbourKey = (buttons[index + 1] ?? buttons[index - 1])?.closest('[data-section]')?.dataset.section ?? '';
        if (!await confirmFolderDelete(PLACEHOLDER_COPY)) {
            return;
        }
        commitKeyOpen();
        try {
            folders.deleteFolder(getPersonaId(), folder.id);
        } catch (error) {
            console.warn('Conversation Mode: a folder could not be deleted', error);
            return;
        }
        announce(`${folder.name} deleted`);
        render();
        for (let frame = 0; frame < FOCUS_RETURN_FRAMES; frame++) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const target = getHeadingControl(list, neighbourKey);
            const settled = !getHeadingControl(list, folderSectionKey(folder.id)) && !document.querySelector('dialog[open]');
            if (!target || list.contains(document.activeElement)) {
                return;
            }
            if (settled) {
                target.focus();
                return;
            }
        }
    }

    /**
     * Opens the menu of a folder's heading: Rename, Colour, Delete.
     * @param {HTMLElement} button The heading's button.
     * @param {{ point?: { x: number, y: number } | null, keyboard?: boolean }} [options]
     */
    function openFolderMenu(button, { point = null, keyboard = false } = {}) {
        const folderId = folderIdOfSection(button.closest('[data-section]')?.dataset.section);
        const folder = getLayout().folders.find(candidate => candidate.id === folderId);
        if (!folder) {
            return;
        }
        openActionMenu({
            trigger: button,
            title: folder.name,
            sections: buildFolderMenuSections(folder, {
                rename: chosen => renameFolder(button, chosen),
                colour: chosen => colourFolder(button, chosen),
                remove: chosen => void deleteFolder(button, chosen),
            }),
            point,
            keyboard,
            bounds: aside,
            // The heading's `aria-expanded` is the folder's own state, which the menu must not overwrite.
            trackTrigger: false,
        });
    }

    return { changeFolder, openMoveMenu, openFolderMenu };
}
