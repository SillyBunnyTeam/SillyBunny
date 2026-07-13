import { t } from './i18n.js';
import { callGenericPopup, Popup, POPUP_TYPE } from './popup.js';
import { clamp, escapeHtml, getFileExtension, sortMoments, timestampToMoment } from './utils.js';
import { displayPastChats, getRequestHeaders, importCharacterChat, refreshCsrfToken } from '/script.js';
import { fetchWithCsrfRetry } from './csrf-token-refresh.js';
import { importGroupChat } from './group-chats.js';

const DEFAULT_BACKUP_CLEANUP_AGE = 30;
const DEFAULT_BACKUP_CLEANUP_KEEP = 25;
const BACKUP_CLEANUP_UNITS = ['days', 'weeks', 'months'];
const BACKUPS_LIST_ID = 'chat_backups_list';

/**
 * Sends a backup API request and retries once after a stale CSRF response.
 * @param {string} resource API resource
 * @param {RequestInit} init Request options
 * @returns {Promise<Response>} Fetch response
 */
function fetchBackupApi(resource, init = {}) {
    return fetchWithCsrfRetry(resource, () => ({
        ...init,
        headers: getRequestHeaders(),
    }), { refreshCsrfToken });
}

/**
 * Creates a read-only backup preview without using a native text editor.
 * @param {string} fileText JSONL backup content
 * @param {string} fileName Backup file name
 * @returns {HTMLElement} Preview element
 */
function createBackupPreview(fileText, fileName) {
    // SillyBunny: iOS WebKit can terminate when the full backup is opened in a nested modal.
    const preview = document.createElement('section');
    preview.classList.add('chatBackupPreview');
    preview.setAttribute('aria-label', fileName);

    const previewName = document.createElement('div');
    previewName.classList.add('chatBackupPreviewName');
    previewName.textContent = fileName;

    const previewMessages = document.createElement('div');
    previewMessages.classList.add('chatBackupPreviewMessages');
    let lineStart = 0;

    while (lineStart <= fileText.length) {
        const newlineIndex = fileText.indexOf('\n', lineStart);
        const lineEnd = newlineIndex === -1 ? fileText.length : newlineIndex;
        const line = fileText.slice(lineStart, lineEnd);

        if (line.trim()) {
            try {
                /** @type {ChatMessage} */
                const lineData = JSON.parse(line);
                if (lineData?.mes) {
                    const message = document.createElement('pre');
                    message.classList.add('chatBackupPreviewMessage', 'monospace', 'margin0');
                    message.textContent = `${lineData.name} [${timestampToMoment(lineData.send_date).format('lll')}]\n${lineData.mes}`;
                    previewMessages.appendChild(message);
                }
            } catch (error) {
                console.error('Failed to parse chat backup line:', error);
            }
        }

        if (newlineIndex === -1) {
            break;
        }
        lineStart = newlineIndex + 1;
    }

    preview.appendChild(previewName);
    preview.appendChild(previewMessages);
    return preview;
}

class BackupsBrowser {
    /** @type {HTMLElement} */
    #buttonElement;
    /** @type {HTMLElement} */
    #buttonChevronIcon;
    /** @type {HTMLElement} */
    #backupsListElement;
    /** @type {import('../../src/endpoints/chats.js').ChatInfo[]} */
    #loadedBackups = [];
    /** @type {AbortController} */
    #loadingAbortController;
    /** @type {boolean} */
    #isOpen = false;
    /** @type {boolean} */
    #isPreviewOpen = false;

    get isOpen() {
        return this.#isOpen;
    }

    /**
     * View a backup file content.
     * @param {string} name File name of the backup to view.
     * @returns {Promise<void>}
     */
    async viewBackup(name) {
        let response;
        const signal = this.#loadingAbortController?.signal;
        try {
            response = await fetchBackupApi('/api/backups/chat/download', {
                method: 'POST',
                body: JSON.stringify({ name: name }),
                signal,
            });
        } catch (error) {
            if (error?.name === 'AbortError') {
                return;
            }
            toastr.error(t`Failed to download backup, try again later.`);
            console.error('Failed to download chat backup:', error);
            return;
        }

        if (!response.ok) {
            toastr.error(t`Failed to download backup, try again later.`);
            console.error('Failed to download chat backup:', response.statusText);
            return;
        }

        try {
            const preview = createBackupPreview(await response.text(), name);
            if (signal?.aborted || !this.#isOpen || !this.#backupsListElement) {
                return;
            }

            this.#isPreviewOpen = true;
            this.#buttonChevronIcon?.classList.remove('fa-chevron-up');
            this.#buttonChevronIcon?.classList.add('fa-chevron-left');
            this.#backupsListElement.classList.add('previewing');
            this.#backupsListElement.replaceChildren(preview);
        } catch (error) {
            if (error?.name === 'AbortError') {
                return;
            }
            console.error('Failed to parse chat backup content:', error);
            toastr.error(t`Failed to parse backup content.`);
            return;
        }
    }

    /**
     * Restore a backup by importing it.
     * @param {string} name File name of the backup to restore.
     * @returns {Promise<void>}
     */
    async restoreBackup(name) {
        let response;
        try {
            response = await fetchBackupApi('/api/backups/chat/download', {
                method: 'POST',
                body: JSON.stringify({ name: name }),
            });
        } catch (error) {
            if (error?.name === 'AbortError') {
                return;
            }
            toastr.error(t`Failed to download backup, try again later.`);
            console.error('Failed to download chat backup:', error);
            return;
        }

        if (!response.ok) {
            toastr.error(t`Failed to download backup, try again later.`);
            console.error('Failed to download chat backup:', response.statusText);
            return;
        }

        const blob = await response.blob();
        const file = new File([blob], name, { type: 'application/octet-stream' });

        const extension = getFileExtension(file);

        if (extension !== 'jsonl') {
            toastr.warning(t`Only .jsonl files are supported for chat imports.`);
            return;
        }

        const context = SillyTavern.getContext();

        const formData = new FormData();
        formData.set('file_type', extension);
        formData.set('avatar', file);
        formData.set('avatar_url', context.characters[context.characterId]?.avatar || '');
        formData.set('user_name', context.name1);
        formData.set('character_name', context.name2);

        const importFn = context.groupId ? importGroupChat : importCharacterChat;
        const result = await importFn(formData, { refresh: false });

        if (result.length === 0) {
            toastr.error(t`Failed to import chat backup, try again later.`);
            return;
        }

        toastr.success(`Chat imported: ${result.join(', ')}`);
        await displayPastChats(result);
    }

    /**
     * Delete a backup file.
     * @param {string} name File name of the backup to delete.
     * @param {object} options Delete options.
     * @param {boolean} [options.confirm=true] Whether to confirm before deleting.
     * @param {boolean} [options.silent=false] Whether to hide the success toast.
     * @returns {Promise<boolean>} True if deleted, false otherwise.
     */
    async deleteBackup(name, { confirm = true, silent = false } = {}) {
        if (confirm) {
            const confirmed = await Popup.show.confirm(t`Are you sure?`);
            if (!confirmed) {
                return false;
            }
        }

        let response;
        try {
            response = await fetchBackupApi('/api/backups/chat/delete', {
                method: 'POST',
                body: JSON.stringify({ name: name }),
            });
        } catch (error) {
            if (error?.name === 'AbortError') {
                return false;
            }
            toastr.error(t`Failed to delete backup, try again later.`);
            console.error('Failed to delete chat backup:', error);
            return false;
        }

        if (!response.ok) {
            toastr.error(t`Failed to delete backup, try again later.`);
            console.error('Failed to delete chat backup:', response.statusText);
            return false;
        }

        if (!silent) {
            toastr.success(t`Backup deleted successfully.`);
        }
        return true;
    }

    /**
     * Gets a stable timestamp for backup sorting and age cleanup.
     * @param {import('../../src/endpoints/chats.js').ChatInfo & {mtime?: number}} backup Backup info
     * @returns {number} Backup timestamp in milliseconds
     */
    getBackupTimestamp(backup) {
        if (Number.isFinite(Number(backup?.mtime))) {
            return Number(backup.mtime);
        }

        const momentDate = timestampToMoment(backup?.last_mes);
        return momentDate.isValid() ? momentDate.valueOf() : 0;
    }

    /**
     * Gets parsed cleanup control values.
     * @returns {{age: number, unit: string, keepNewest: number}}
     */
    getCleanupOptions() {
        const ageInput = this.#backupsListElement.querySelector('[data-chat-backups-cleanup-age]');
        const keepInput = this.#backupsListElement.querySelector('[data-chat-backups-cleanup-keep]');
        const unitInput = this.#backupsListElement.querySelector('[data-chat-backups-cleanup-unit]');
        const age = clamp(parseInt(String(ageInput?.value || DEFAULT_BACKUP_CLEANUP_AGE), 10) || 0, 0, 9999);
        const keepNewest = clamp(parseInt(String(keepInput?.value || DEFAULT_BACKUP_CLEANUP_KEEP), 10) || 0, 0, 9999);
        const unit = BACKUP_CLEANUP_UNITS.includes(String(unitInput?.value)) ? String(unitInput.value) : 'days';

        return { age, unit, keepNewest };
    }

    /**
     * Gets backups that match the cleanup controls.
     * @returns {import('../../src/endpoints/chats.js').ChatInfo[]} Matching backups
     */
    getCleanupCandidates() {
        const { age, unit, keepNewest } = this.getCleanupOptions();
        const sortedBackups = [...this.#loadedBackups].sort((a, b) => this.getBackupTimestamp(b) - this.getBackupTimestamp(a));
        const keptNames = new Set(sortedBackups.slice(0, keepNewest).map(backup => backup.file_name));
        const cutoff = age > 0 ? timestampToMoment(Date.now()).clone().subtract(age, unit).valueOf() : null;

        return sortedBackups.filter((backup) => {
            if (!backup.file_name || keptNames.has(backup.file_name)) {
                return false;
            }

            if (cutoff !== null && this.getBackupTimestamp(backup) >= cutoff) {
                return false;
            }

            return true;
        });
    }

    /**
     * Renders the cleanup preview list for the confirmation popup.
     * @param {import('../../src/endpoints/chats.js').ChatInfo[]} backups Matching backups
     * @returns {string} HTML preview
     */
    renderCleanupPreview(backups) {
        const listItems = backups.slice(0, 18).map((backup) => {
            const backupDate = timestampToMoment(this.getBackupTimestamp(backup)).format('lll');
            return `<li><code>${escapeHtml(backup.file_name)}</code> <small>${escapeHtml(backupDate)}</small></li>`;
        }).join('');
        const moreCount = Math.max(0, backups.length - 18);
        const moreText = moreCount ? `<p>${escapeHtml(String(moreCount))} ${t`more backup(s) not shown.`}</p>` : '';
        return `<ol class="chatBackupsCleanupPreview">${listItems}</ol>${moreText}`;
    }

    /**
     * Updates the cleanup status line.
     * @param {string} message Status message
     */
    setCleanupStatus(message = '') {
        const status = this.#backupsListElement?.querySelector('[data-chat-backups-cleanup-status]');
        if (status) {
            status.textContent = message;
        }
    }

    /**
     * Shows a preview of old backups matching the cleanup controls.
     * @returns {Promise<void>}
     */
    async previewCleanup() {
        const candidates = this.getCleanupCandidates();
        if (!candidates.length) {
            toastr.info(t`No backups match those cleanup settings.`);
            this.setCleanupStatus(t`No backups match those cleanup settings.`);
            return;
        }

        await callGenericPopup(
            `<h3>${t`Backup cleanup preview`}</h3>
            <p>${escapeHtml(String(candidates.length))} ${t`backup(s) match. Newest kept backups are protected.`}</p>
            ${this.renderCleanupPreview(candidates)}`,
            POPUP_TYPE.TEXT,
            '',
            { wider: true, allowVerticalScrolling: true },
        );
        this.setCleanupStatus(`${candidates.length} ${t`backup(s) match the cleanup settings.`}`);
    }

    /**
     * Deletes old backups matching the cleanup controls.
     * @returns {Promise<void>}
     */
    async cleanupOldBackups() {
        const candidates = this.getCleanupCandidates();
        if (!candidates.length) {
            toastr.info(t`No backups match those cleanup settings.`);
            this.setCleanupStatus(t`No backups match those cleanup settings.`);
            return;
        }

        const confirmed = await Popup.show.confirm(
            t`Clean old backups?`,
            `<p>${escapeHtml(String(candidates.length))} ${t`backup(s) will be permanently deleted.`}</p>
            ${this.renderCleanupPreview(candidates)}`,
        );
        if (!confirmed) {
            return;
        }

        let deleted = 0;
        let failed = 0;

        for (const [index, backup] of candidates.entries()) {
            this.setCleanupStatus(`${t`Deleting`} ${index + 1}/${candidates.length}: ${backup.file_name}`);
            const success = await this.deleteBackup(backup.file_name, { confirm: false, silent: true });
            success ? deleted++ : failed++;
        }

        if (failed) {
            toastr.warning(`${deleted} ${t`backup(s) deleted.`} ${failed} ${t`failed.`}`);
        } else {
            toastr.success(`${deleted} ${t`old backup(s) deleted.`}`);
        }

        await this.reloadBackupsList();
        this.setCleanupStatus(`${deleted} ${t`backup(s) deleted.`}${failed ? ` ${failed} ${t`failed.`}` : ''}`);
    }

    /**
     * Creates the cleanup controls for the backups list.
     * @returns {HTMLElement} Cleanup controls element
     */
    renderCleanupControls() {
        const controls = document.createElement('div');
        controls.classList.add('chatBackupsCleanupTools');

        const ageField = document.createElement('label');
        ageField.classList.add('chatBackupsCleanupField', 'chatBackupsCleanupAgeField');
        const ageLabel = document.createElement('span');
        ageLabel.textContent = t`Older than`;
        const ageInput = document.createElement('input');
        ageInput.classList.add('text_pole');
        ageInput.type = 'number';
        ageInput.min = '0';
        ageInput.max = '9999';
        ageInput.step = '1';
        ageInput.inputMode = 'numeric';
        ageInput.value = String(DEFAULT_BACKUP_CLEANUP_AGE);
        ageInput.setAttribute('data-chat-backups-cleanup-age', '');
        ageField.appendChild(ageLabel);
        ageField.appendChild(ageInput);

        const unitSelect = document.createElement('select');
        unitSelect.classList.add('text_pole');
        unitSelect.setAttribute('aria-label', t`Backup cleanup age unit`);
        unitSelect.setAttribute('data-chat-backups-cleanup-unit', '');
        for (const unit of BACKUP_CLEANUP_UNITS) {
            const option = document.createElement('option');
            option.value = unit;
            option.textContent = unit;
            unitSelect.appendChild(option);
        }

        const keepField = document.createElement('label');
        keepField.classList.add('chatBackupsCleanupField', 'chatBackupsCleanupKeepField');
        const keepLabel = document.createElement('span');
        keepLabel.textContent = t`Keep newest`;
        const keepInput = document.createElement('input');
        keepInput.classList.add('text_pole');
        keepInput.type = 'number';
        keepInput.min = '0';
        keepInput.max = '9999';
        keepInput.step = '1';
        keepInput.inputMode = 'numeric';
        keepInput.value = String(DEFAULT_BACKUP_CLEANUP_KEEP);
        keepInput.setAttribute('data-chat-backups-cleanup-keep', '');
        keepField.appendChild(keepLabel);
        keepField.appendChild(keepInput);

        const previewButton = document.createElement('button');
        previewButton.type = 'button';
        previewButton.classList.add('menu_button', 'menu_button_icon', 'chatBackupsCleanupPreviewButton');
        previewButton.title = t`Preview old backups that match the cleanup settings`;
        previewButton.innerHTML = '<i class="fa-solid fa-list-check"></i><span></span>';
        previewButton.querySelector('span').textContent = t`Preview`;
        previewButton.addEventListener('click', () => this.previewCleanup());

        const cleanupButton = document.createElement('button');
        cleanupButton.type = 'button';
        cleanupButton.classList.add('menu_button', 'menu_button_icon', 'chatBackupsCleanupCleanButton');
        cleanupButton.title = t`Delete old backups that match the cleanup settings`;
        cleanupButton.innerHTML = '<i class="fa-solid fa-broom"></i><span></span>';
        cleanupButton.querySelector('span').textContent = t`Clean`;
        cleanupButton.addEventListener('click', () => this.cleanupOldBackups());

        const status = document.createElement('div');
        status.classList.add('chatBackupsCleanupStatus');
        status.setAttribute('data-chat-backups-cleanup-status', '');
        status.setAttribute('aria-live', 'polite');

        controls.appendChild(ageField);
        controls.appendChild(unitSelect);
        controls.appendChild(keepField);
        controls.appendChild(previewButton);
        controls.appendChild(cleanupButton);
        controls.appendChild(status);
        return controls;
    }

    /**
     * Reloads the backups list when the panel is open.
     * @returns {Promise<void>}
     */
    async reloadBackupsList() {
        if (!this.#isOpen) {
            return;
        }

        if (this.#loadingAbortController) {
            this.#loadingAbortController.abort();
        }
        this.#loadingAbortController = new AbortController();
        await this.loadBackupsIntoList(this.#loadingAbortController.signal);
    }

    /**
     * Creates a visible status message for the backups list.
     * @param {string} message Status message
     * @returns {HTMLElement} Status element
     */
    renderListMessage(message) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('chatBackupsEmptyMessage');
        messageElement.setAttribute('role', 'status');
        messageElement.textContent = message;
        return messageElement;
    }

    /**
     * Load backups and populate the list element.
     * @param {AbortSignal} signal Signal to abort loading.
     * @returns {Promise<void>}
     */
    async loadBackupsIntoList(signal) {
        if (!this.#backupsListElement) {
            return;
        }

        this.#isPreviewOpen = false;
        this.#backupsListElement.classList.remove('previewing');
        this.#backupsListElement.replaceChildren(this.renderListMessage(t`Loading chat…`));
        this.#backupsListElement.setAttribute('aria-busy', 'true');
        this.#loadedBackups = [];

        try {
            const response = await fetchBackupApi('/api/backups/chat/get', {
                method: 'POST',
                signal,
            });

            if (!response.ok) {
                throw new Error(`Failed to load chat backups list: ${response.status} ${response.statusText}`);
            }

            /** @type {import('../../src/endpoints/chats.js').ChatInfo[]} */
            const backupsList = await response.json();
            if (!Array.isArray(backupsList)) {
                throw new TypeError('Invalid chat backups list response');
            }
            if (signal.aborted) {
                return;
            }
            this.#loadedBackups = backupsList;
            this.#backupsListElement.innerHTML = '';

            if (!backupsList.length) {
                this.#backupsListElement.appendChild(this.renderListMessage(t`No chat backups found.`));
                this.#backupsListElement.appendChild(this.renderCleanupControls());
                return;
            }

            for (const backup of backupsList.sort((a, b) => sortMoments(timestampToMoment(this.getBackupTimestamp(a)), timestampToMoment(this.getBackupTimestamp(b))))) {
                const listItem = document.createElement('div');
                listItem.classList.add('chatBackupsListItem');

                const backupName = document.createElement('div');
                backupName.textContent = backup.file_name;
                backupName.classList.add('chatBackupsListItemName');

                const backupInfo = document.createElement('div');
                backupInfo.classList.add('chatBackupsListItemInfo');
                const backupDetails = [backup.file_size];
                if (backup.chat_items !== undefined && backup.chat_items !== null) {
                    backupDetails.push(`${backup.chat_items} 💬`);
                }
                backupInfo.textContent = `${timestampToMoment(this.getBackupTimestamp(backup)).format('lll')} (${backupDetails.join(', ')})`;

                const actionsList = document.createElement('div');
                actionsList.classList.add('chatBackupsListItemActions');

                const viewButton = document.createElement('div');
                viewButton.classList.add('right_menu_button', 'fa-solid', 'fa-eye');
                viewButton.title = t`View backup`;
                viewButton.addEventListener('click', async () => {
                    await this.viewBackup(backup.file_name);
                });

                const restoreButton = document.createElement('div');
                restoreButton.classList.add('right_menu_button', 'fa-solid', 'fa-rotate-left');
                restoreButton.title = t`Restore backup`;
                restoreButton.addEventListener('click', async () => {
                    await this.restoreBackup(backup.file_name);
                });

                const deleteButton = document.createElement('div');
                deleteButton.classList.add('right_menu_button', 'fa-solid', 'fa-trash');
                deleteButton.title = t`Delete backup`;
                deleteButton.addEventListener('click', async () => {
                    const isDeleted = await this.deleteBackup(backup.file_name);
                    if (isDeleted) {
                        listItem.remove();
                        this.#loadedBackups = this.#loadedBackups.filter(item => item.file_name !== backup.file_name);
                    }
                });

                actionsList.appendChild(viewButton);
                actionsList.appendChild(restoreButton);
                actionsList.appendChild(deleteButton);

                listItem.appendChild(backupName);
                listItem.appendChild(backupInfo);
                listItem.appendChild(actionsList);

                this.#backupsListElement.appendChild(listItem);
            }

            this.#backupsListElement.appendChild(this.renderCleanupControls());
        } catch (error) {
            if (error?.name === 'AbortError' || signal.aborted) {
                return;
            }
            console.error('Failed to load chat backups list:', error);
            this.#backupsListElement.replaceChildren(this.renderListMessage(t`Could not load chat data. Try reloading the page.`));
        } finally {
            if (!signal.aborted) {
                this.#backupsListElement.setAttribute('aria-busy', 'false');
            }
        }
    }

    closeBackups() {
        if (!this.#isOpen) {
            return;
        }

        this.#isOpen = false;
        this.#isPreviewOpen = false;
        if (this.#buttonElement) {
            this.#buttonElement.setAttribute('aria-expanded', 'false');
        }
        if (this.#buttonChevronIcon) {
            this.#buttonChevronIcon.classList.remove('fa-chevron-up', 'fa-chevron-left');
            this.#buttonChevronIcon.classList.add('fa-chevron-down');
        }
        if (this.#backupsListElement) {
            this.#backupsListElement.classList.remove('open', 'previewing');
            this.#backupsListElement.parentElement?.classList.remove('chatBackupsOpen');
            this.#backupsListElement.innerHTML = '';
        }
        if (this.#loadingAbortController) {
            this.#loadingAbortController.abort();
            this.#loadingAbortController = null;
        }
    }

    openBackups() {
        if (this.#isOpen) {
            return;
        }

        this.#isOpen = true;
        if (this.#buttonElement) {
            this.#buttonElement.setAttribute('aria-expanded', 'true');
        }
        if (this.#buttonChevronIcon) {
            this.#buttonChevronIcon.classList.remove('fa-chevron-down', 'fa-chevron-left');
            this.#buttonChevronIcon.classList.add('fa-chevron-up');
        }
        if (this.#backupsListElement) {
            this.#backupsListElement.classList.add('open');
            this.#backupsListElement.parentElement?.classList.add('chatBackupsOpen');
        }
        if (this.#loadingAbortController) {
            this.#loadingAbortController.abort();
            this.#loadingAbortController = null;
        }

        this.#loadingAbortController = new AbortController();
        this.loadBackupsIntoList(this.#loadingAbortController.signal);
    }

    closePreview() {
        if (!this.#isPreviewOpen || !this.#isOpen) {
            return;
        }

        this.#isPreviewOpen = false;
        this.#buttonChevronIcon?.classList.remove('fa-chevron-left');
        this.#buttonChevronIcon?.classList.add('fa-chevron-up');
        this.#backupsListElement?.classList.remove('previewing');
        this.#loadingAbortController?.abort();
        this.#loadingAbortController = new AbortController();
        this.loadBackupsIntoList(this.#loadingAbortController.signal);
    }

    renderButton() {
        if (this.#buttonElement) {
            return;
        }

        const sibling = document.getElementById('select_chat_search');
        if (!sibling) {
            console.error('Could not find sibling element for BackupsBrowser button');
            return;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.classList.add('menu_button', 'menu_button_icon');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-controls', BACKUPS_LIST_ID);

        const buttonIcon = document.createElement('i');
        buttonIcon.classList.add('fa-solid', 'fa-box-open');

        const buttonText = document.createElement('span');
        buttonText.textContent = t`Backups`;
        buttonText.title = t`Browse chat backups`;

        const chevronIcon = document.createElement('i');
        chevronIcon.classList.add('fa-solid', 'fa-chevron-down', 'fa-sm');

        button.appendChild(buttonIcon);
        button.appendChild(buttonText);
        button.appendChild(chevronIcon);

        button.addEventListener('click', () => {
            if (this.#isPreviewOpen) {
                this.closePreview();
            } else if (this.#isOpen) {
                this.closeBackups();
            } else {
                this.openBackups();
            }
        });

        sibling.parentNode.insertBefore(button, sibling);

        this.#buttonElement = button;
        this.#buttonChevronIcon = chevronIcon;
    }

    renderBackupsList() {
        if (this.#backupsListElement) {
            return;
        }

        const sibling = document.getElementById('select_chat_div');
        if (!sibling) {
            console.error('Could not find sibling element for BackupsBrowser list');
            return;
        }

        const list = document.createElement('div');
        list.id = BACKUPS_LIST_ID;
        list.classList.add('chatBackupsList');

        sibling.parentNode.insertBefore(list, sibling);
        this.#backupsListElement = list;
    }
}

const backupsBrowser = new BackupsBrowser();

export function addChatBackupsBrowser() {
    backupsBrowser.renderButton();
    backupsBrowser.renderBackupsList();

    // Refresh the backups list if it's already open
    if (backupsBrowser.isOpen) {
        backupsBrowser.closeBackups();
        backupsBrowser.openBackups();
    }
}
