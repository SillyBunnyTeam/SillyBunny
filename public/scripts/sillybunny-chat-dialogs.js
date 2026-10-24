import { t } from './i18n.js';
import { openDialog } from './sillybunny-editor/dialog.js';
import { openActionMenu } from './sillybunny-action-menu.js';
import { createCheckRow, createPrefGroup, createSpinRow, createSwitchRow } from './sillybunny-editor/rows.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';

let activeChatHistoryDialog = null;
let legacyChatHistoryRestoreObserver = null;

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

export async function openMassDeleteChatDialog(files, currentChatId, { getOlderCount, formatChatTimestamp }) {
    const ageInput = document.createElement('input');
    ageInput.className = 'text_pole';
    ageInput.type = 'number';
    ageInput.min = '1';
    ageInput.step = '1';
    ageInput.value = '30';
    ageInput.inputMode = 'numeric';

    const ageEntry = createSpinRow({ label: t`Older than`, field: 'mass-delete-age', input: ageInput, normalize: false });
    ageEntry.row.classList.add('sb-chat-delete-age-entry');
    const ageRow = element('div', 'sb-chat-delete-age');
    ageRow.append(ageEntry.row);

    const presets = element('div', 'sb-chat-delete-presets');
    const status = element('small', 'sb-chat-delete-status');
    status.setAttribute('aria-live', 'polite');
    const note = element('p', 'sb-chat-delete-note', t`Delete saved chats for the current character or group. The open chat is protected.`);
    const compatibilityTitle = element('h3', '', t`Mass delete chats`);
    compatibilityTitle.id = 'sb-chat-delete-title';
    compatibilityTitle.hidden = true;
    const selectableFiles = files.filter(chatFile => chatFile.fileName !== currentChatId);
    const checkboxes = [];
    const rows = [];
    let dialog = null;
    let selectAll = null;

    function selectedNames() {
        return checkboxes.filter(checkbox => checkbox.checked).map(checkbox => checkbox.value);
    }

    function updateStatus() {
        const selectedCount = selectedNames().length;
        const olderCount = getOlderCount(ageInput.value);
        status.textContent = `${selectedCount} selected. ${olderCount} older than ${ageInput.value || 0} day(s).`;
        if (dialog) {
            dialog.setResponseEnabled('delete-selected', selectedCount > 0);
            dialog.setResponseEnabled('delete-older', olderCount > 0);
        }
        if (selectAll) {
            selectAll.control.checked = selectableFiles.length > 0 && selectedCount === selectableFiles.length;
            selectAll.control.indeterminate = selectedCount > 0 && selectedCount < selectableFiles.length;
        }
    }

    for (const days of [7, 30, 90, 180]) {
        const button = element('button', 'menu_button', String(days));
        button.type = 'button';
        button.addEventListener('click', () => {
            ageInput.value = String(days);
            updateStatus();
        });
        presets.append(button);
    }

    const list = createPrefGroup({ rows: [] });
    list.section.classList.add('sb-chat-delete-list');
    if (selectableFiles.length > 5) {
        selectAll = createCheckRow({ label: t`Select All`, field: 'mass-delete-select-all', onChange: checked => {
            for (const checkbox of checkboxes) checkbox.checked = checked;
            updateStatus();
        } });
        selectAll.row.querySelector('.ds-row-label').dataset.i18n = 'Select All';
        list.append(selectAll);
    }

    for (const chatFile of files) {
        const meta = [formatChatTimestamp(chatFile.lastMessage), chatFile.chatItems ? `${chatFile.chatItems} msg` : ''].filter(Boolean).join(' - ');
        const row = createCheckRow({
            label: chatFile.fileName,
            subtitle: meta,
            field: 'mass-delete-chat',
            checked: false,
            disabled: chatFile.fileName === currentChatId,
        });
        row.row.classList.add('sb-chat-delete-row');
        row.control.value = chatFile.fileName;
        if (!row.control.disabled) {
            row.control.addEventListener('change', updateStatus);
            checkboxes.push(row.control);
        }
        rows.push(row);
    }
    list.append(...rows);

    ageInput.addEventListener('input', updateStatus);
    const content = document.createDocumentFragment();
    content.append(compatibilityTitle, note, ageRow, presets, status, list.section);
    dialog = openDialog({
        tier: 'window',
        title: t`Mass delete chats`,
        content,
        className: 'sb-chat-mass-delete',
        responses: {
            cancel: { label: t`Cancel` },
            affirmative: { id: 'delete-selected', label: t`Delete selected`, appearance: 'destructive', enabled: false },
            extra: [{ id: 'delete-older', label: t`Delete older`, enabled: false }],
        },
    });
    updateStatus();

    const { response } = await dialog.closed;
    if (response === 'delete-selected') return { mode: 'selected', names: selectedNames() };
    if (response === 'delete-older') return { mode: 'older', days: Number(ageInput.value) };
    return null;
}

export function openChatHistoryDialog() {
    legacyChatHistoryRestoreObserver?.disconnect();
    legacyChatHistoryRestoreObserver = null;
    const currentDetails = window.SillyTavern?.getContext?.();
    if (activeChatHistoryDialog?.root.isConnected) {
        const sourceSearch = document.getElementById('select_chat_search');
        if (sourceSearch instanceof HTMLInputElement) {
            activeChatHistoryDialog.search?.setQuery(sourceSearch.value, { notify: false });
        }
        const activeName = currentDetails?.name2 ?? '';
        activeChatHistoryDialog.setSubtitle?.(activeName);
        return activeChatHistoryDialog;
    }

    const popup = document.getElementById('select_chat_popup');
    const legacyHost = document.getElementById('shadow_select_chat_popup');
    const heading = popup?.querySelector('#selectChatPopupHeaderText');
    const searchInput = popup?.querySelector('#select_chat_search');
    const chatList = popup?.querySelector('#select_chat_div');
    const closeControl = popup?.querySelector('#select_chat_cross');
    const datedInput = popup?.querySelector('#chat_cleanup_only_dated');
    const datedLabel = datedInput?.closest('label');
    const management = popup?.querySelector('#chat_management_tools');
    const legacyNewChat = popup?.querySelector('#newChatFromManageScreenButton');
    const legacyImport = popup?.querySelector('#chat_import_button');
    const backupsButton = popup?.querySelector('[aria-controls="chat_backups_list"]');
    const backupsList = popup?.querySelector('#chat_backups_list');
    const originalExportLabel = popup?.querySelector('.exportRawChatButton')?.getAttribute('title') || t`TODO(copy)`;
    if (!(popup instanceof HTMLElement) || !(legacyHost instanceof HTMLElement) || !(searchInput instanceof HTMLInputElement) || !(chatList instanceof HTMLElement)) {
        throw new Error('Chat History markup is incomplete: expected #select_chat_popup, #shadow_select_chat_popup, #select_chat_search, and #select_chat_div.');
    }
    const chatListSnapshot = chatList.cloneNode(true);
    const returnFocus = document.activeElement;
    const originalPositions = new Map();
    const originalNodes = new Map();
    const originalChildren = new Map();
    const rememberPosition = node => {
        if (!(node instanceof Node) || originalPositions.has(node)) return;
        originalPositions.set(node, { parent: node.parentNode, next: node.nextSibling });
        originalNodes.set(node, node.cloneNode(false));
        originalChildren.set(node, [...node.childNodes]);
    };
    const managementTools = management instanceof HTMLElement ? management : element('div', 'chat_management_tools');
    const labelGroup = managementTools.querySelector('.chat_label_group') ?? element('div', 'chat_label_group');
    const cleanupGroup = managementTools.querySelector('.chat_cleanup_group') ?? element('div', 'chat_cleanup_group');
    const status = popup.querySelector('#chat_cleanup_status') ?? element('div', 'chat_cleanup_status');
    const cancelButton = popup.querySelector('#chat_tools_cancel') ?? element('button', 'displayNone');
    [popup, heading, searchInput, closeControl, managementTools, labelGroup, cleanupGroup, status, cancelButton,
        legacyNewChat, legacyImport, backupsButton, backupsList, chatList, datedLabel, datedInput].filter(Boolean).forEach(rememberPosition);
    const hiddenState = [heading, searchInput, closeControl, labelGroup, managementTools, legacyNewChat, legacyImport,
        backupsButton, backupsList, chatList, datedLabel].filter(Boolean).map(node => [node, node.hidden]);
    if (!(management instanceof HTMLElement)) popup.append(managementTools);
    if (!(labelGroup.parentNode instanceof HTMLElement)) managementTools.append(labelGroup);
    if (!(cleanupGroup.parentNode instanceof HTMLElement)) managementTools.append(cleanupGroup);
    if (!(status.parentNode instanceof HTMLElement)) popup.append(status);
    if (!(cancelButton.parentNode instanceof HTMLElement)) popup.append(cancelButton);

    if (datedInput instanceof HTMLInputElement && datedLabel instanceof HTMLLabelElement && !datedInput.closest('.ds-row-switch')) {
        const labelText = datedLabel.querySelector('span');
        const switchRow = createSwitchRow({
            label: labelText?.textContent ?? t`Dated only`,
            field: 'chat-cleanup-dated-only',
            input: datedInput,
        });
        switchRow.row.classList.add('chat_cleanup_checkbox');
        switchRow.row.title = datedLabel.title;
        const rowLabel = switchRow.row.querySelector('.ds-row-label');
        const labelI18n = labelText?.getAttribute('data-i18n');
        if (labelI18n) rowLabel.dataset.i18n = labelI18n;
        const titleI18n = datedLabel.getAttribute('data-i18n');
        if (titleI18n) switchRow.row.dataset.i18n = titleI18n;
        datedLabel.replaceWith(switchRow.row);
    }

    legacyHost.style.display = 'block';
    legacyHost.classList.add('sb-chat-history-compat-open');
    if (heading) heading.hidden = true;
    searchInput.hidden = true;
    if (closeControl) closeControl.hidden = true;
    labelGroup.hidden = true;
    managementTools.hidden = true;
    if (legacyNewChat) legacyNewChat.hidden = true;
    if (legacyImport) legacyImport.hidden = true;
    if (backupsButton instanceof HTMLElement) backupsButton.hidden = true;

    const pageContent = document.createElement('div');
    pageContent.className = 'sb-chat-history-list-page';
    pageContent.append(chatList);
    if (backupsList instanceof HTMLElement) {
        backupsList.hidden = !popup.classList.contains('chatBackupsOpen');
        pageContent.append(backupsList);
    }
    popup.append(pageContent);
    const banner = document.createElement('div');
    banner.className = 'sb-chat-history-banner';
    banner.hidden = true;
    banner.append(status, cancelButton);
    const ownerName = currentDetails?.name2 ?? '';
    const title = heading?.querySelector('[data-i18n="Chat History"]')?.textContent?.trim() || t`Chat History`;
    const cleanupTitle = cleanupGroup.getAttribute('aria-label') || t`TODO(copy)`;
    const menuItems = () => [{ items: [
        { label: t`Import Chat`, icon: 'fa-solid fa-file-import', onSelect: () => popup.querySelector('#chat_import_button')?.click() },
        { label: t`Backups`, icon: 'fa-solid fa-box-archive', onSelect: () => popup.querySelector('[aria-controls="chat_backups_list"]')?.click() },
        { label: t`Label current`, icon: 'fa-solid fa-wand-magic-sparkles', onSelect: () => popup.querySelector('#chat_auto_label_current')?.click() },
        { label: t`Label dated`, icon: 'fa-solid fa-tags', onSelect: () => popup.querySelector('#chat_auto_label_dated')?.click() },
        { label: cleanupTitle, icon: 'fa-solid fa-broom', onSelect: () => cleanupToggle() },
        { label: t`Help`, icon: 'fa-solid fa-circle-question', onSelect: () => {
            const helpUrl = popup.querySelector('.notes-link')?.href;
            if (helpUrl) window.open(helpUrl, '_blank', 'noopener');
        } },
    ] }];

    const frame = openDialog({
        tier: 'window',
        title,
        subtitle: ownerName,
        content: popup,
        className: 'sb-chat-history-dialog',
        search: {
            placeholder: searchInput.placeholder || t`Search...`,
            label: t`Search`,
            onChange(query) {
                searchInput.value = query;
                searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            },
        },
    });
    const placeBanner = page => {
        const body = page?.querySelector('.sb-dialog__body');
        if (!body) return;
        body.before(banner);
    };
    placeBanner(frame.page);
    const headerEnd = frame.header?.querySelector('.sb-dialog__header-end');
    const newChatButton = document.createElement('button');
    newChatButton.type = 'button';
    newChatButton.className = 'sb-dialog__icon-button sb-chat-history-new-chat';
    newChatButton.title = t`New Chat`;
    newChatButton.setAttribute('aria-label', t`New Chat`);
    newChatButton.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i>';
    newChatButton.addEventListener('click', () => popup.querySelector('#newChatFromManageScreenButton')?.click());
    const menuButton = document.createElement('button');
    menuButton.type = 'button';
    menuButton.className = 'sb-dialog__icon-button sb-chat-history-menu';
    menuButton.title = t`Menu`;
    menuButton.setAttribute('aria-label', t`Menu`);
    menuButton.setAttribute('aria-haspopup', 'menu');
    menuButton.innerHTML = '<i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i>';
    menuButton.addEventListener('click', () => openActionMenu({ trigger: menuButton, title: t`Chat History`, sections: menuItems(), bounds: frame.surface }));
    headerEnd?.prepend(newChatButton, menuButton);

    const cleanupContent = document.createElement('div');
    cleanupContent.className = 'sb-chat-history-cleanup-content';
    const ageInput = cleanupGroup.querySelector('#chat_cleanup_age');
    const unitSelect = cleanupGroup.querySelector('#chat_cleanup_unit');
    const keepInput = cleanupGroup.querySelector('#chat_cleanup_keep');
    const onlyDatedRow = cleanupGroup.querySelector('.chat_cleanup_checkbox');
    const previewButton = cleanupGroup.querySelector('#chat_cleanup_preview');
    const cleanButton = cleanupGroup.querySelector('#chat_cleanup_run');
    [ageInput, unitSelect, keepInput, previewButton, cleanButton].forEach(rememberPosition);
    if (ageInput instanceof HTMLInputElement && unitSelect instanceof HTMLSelectElement && keepInput instanceof HTMLInputElement && onlyDatedRow instanceof HTMLElement) {
        const rows = [
            createSpinRow({ label: t`Older than`, field: 'chat-cleanup-age', input: ageInput, min: Number(ageInput.min), max: Number(ageInput.max), normalize: false }),
            createComboCleanupRow(unitSelect),
            createSpinRow({ label: t`Keep newest`, field: 'chat-cleanup-keep', input: keepInput, min: Number(keepInput.min), max: Number(keepInput.max), normalize: false }),
        ];
        const group = createPrefGroup({ rows });
        group.section.classList.add('sb-chat-history-cleanup-group');
        cleanupContent.append(group.section, onlyDatedRow);
    }
    const cleanupActions = document.createElement('div');
    cleanupActions.className = 'sb-dialog__bottom-bar sb-chat-history-cleanup-actions';
    cleanButton?.classList.add('is-destructive');
    if (previewButton instanceof HTMLElement && cleanButton instanceof HTMLElement) cleanupActions.append(previewButton, cleanButton);
    let cleanupPage = null;
    const cleanupToggle = () => {
        if (cleanupPage?.root.isConnected) return cleanupPage;
        cleanupPage = frame.push({ title: cleanupTitle, content: cleanupContent, className: 'sb-chat-history-cleanup-page' });
        cleanupPage.page.append(cleanupActions);
        placeBanner(cleanupPage.page);
        cleanupPage.closed.then(() => {
            placeBanner(frame.page);
            cleanupPage = null;
        });
        return cleanupPage;
    };
    const exportMenu = (trigger, row) => openActionMenu({
        trigger,
        title: row.querySelector('.exportRawChatButton')?.getAttribute('title') || t`TODO(copy)`,
        bounds: frame.surface,
        sections: [{ items: [
            { label: row.querySelector('.exportRawChatButton')?.getAttribute('title') || t`TODO(copy)`, icon: 'fa-solid fa-file-export', onSelect: () => row.querySelector('.exportRawChatButton')?.click() },
            { label: row.querySelector('.exportChatButton')?.getAttribute('title') || t`TODO(copy)`, icon: 'fa-solid fa-file-lines', onSelect: () => row.querySelector('.exportChatButton')?.click() },
        ] }],
    });
    const decorateRow = wrapper => {
        const chatRow = wrapper.querySelector('.select_chat_block');
        const filename = wrapper.querySelector('.select_chat_block_filename');
        const metadata = wrapper.querySelector('.select_chat_info');
        const fileSize = wrapper.querySelector('.chat_file_size');
        const messageCount = wrapper.querySelector('.chat_messages_num');
        const preview = wrapper.querySelector('.select_chat_block_mes');
        const rename = wrapper.querySelector('.renameChatButton');
        const remove = wrapper.querySelector('.PastChat_cross');
        const legacyExports = [...wrapper.querySelectorAll('.exportRawChatButton, .exportChatButton')];
        if (!(chatRow instanceof HTMLElement) || !(filename instanceof HTMLElement) || !(metadata instanceof HTMLElement) || !(preview instanceof HTMLElement)
            || !(rename instanceof HTMLElement) || !(remove instanceof HTMLElement) || chatRow.dataset.sbChatDecorated) return;
        chatRow.dataset.sbChatDecorated = 'true';
        if (fileSize instanceof HTMLElement) fileSize.textContent = fileSize.textContent.replace(/^\s*\(/, '').replace(/,\s*$/, '');
        if (messageCount instanceof HTMLElement) messageCount.textContent = messageCount.textContent.replace(/\)\s*$/, '');
        remove.classList.remove('fa-skull');
        remove.classList.add('fa-trash-can');
        chatRow.classList.add('sb-chat-history-row');
        chatRow.setAttribute('role', 'button');
        chatRow.tabIndex = 0;
        if (chatRow.hasAttribute('highlight')) chatRow.setAttribute('aria-current', 'true');
        const leading = document.createElement('span');
        leading.className = 'sb-chat-history-check';
        leading.setAttribute('aria-hidden', 'true');
        leading.innerHTML = '<i class="fa-solid fa-check"></i>';
        const content = document.createElement('span');
        content.className = 'sb-chat-history-row-content';
        const titleLine = document.createElement('span');
        titleLine.className = 'sb-chat-history-row-title';
        titleLine.append(filename);
        const actions = document.createElement('span');
        actions.className = 'sb-chat-history-row-actions';
        const legacyActionStore = document.createElement('span');
        legacyActionStore.className = 'sb-chat-history-legacy-actions';
        legacyActionStore.setAttribute('aria-hidden', 'true');
        legacyExports.forEach(node => {
            node.tabIndex = -1;
            legacyActionStore.append(node);
        });
        const rawExport = wrapper.querySelector('.exportRawChatButton');
        const exportLabel = rawExport?.getAttribute('title') || rawExport?.title || rawExport?.getAttribute('aria-label') || originalExportLabel;
        const exportButton = document.createElement('button');
        exportButton.type = 'button';
        exportButton.className = 'sb-dialog__icon-button sb-chat-history-export';
        exportButton.title = exportLabel;
        exportButton.setAttribute('aria-label', exportLabel);
        exportButton.innerHTML = '<i class="fa-solid fa-file-export" aria-hidden="true"></i>';
        exportButton.addEventListener('click', event => { event.stopPropagation(); exportMenu(exportButton, chatRow); });
        const actionNodes = [rename, remove];
        for (const node of actionNodes) {
            node.setAttribute('role', 'button');
            node.tabIndex = 0;
            node.setAttribute('aria-label', node.getAttribute('title') || node.getAttribute('aria-label') || t`TODO(copy)`);
            node.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                node.click();
            });
        }
        exportButton.addEventListener('click', event => event.stopPropagation());
        actions.append(rename, exportButton, remove);
        content.append(titleLine, metadata, preview);
        chatRow.replaceChildren(leading, content, actions);
        chatRow.append(legacyActionStore);
        chatRow.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (event.target !== chatRow) return;
            event.preventDefault();
            chatRow.click();
        });
        chatRow.querySelectorAll('.exportRawChatButton, .exportChatButton').forEach(node => node.classList.add('sb-chat-history-legacy-export'));
    };
    const decorateAllRows = () => chatList.querySelectorAll('.select_chat_block_wrapper').forEach(decorateRow);
    const emptyState = createStatusPage({ icon: 'comments', title: t`TODO(copy)`, description: t`TODO(copy)`, compact: true });
    let emptyStateMode = null;
    const syncEmptyState = () => {
        const hasRows = chatList.querySelector('.select_chat_block_wrapper') instanceof HTMLElement;
        const searching = Boolean(frame.search?.query.trim());
        emptyState.element.hidden = hasRows;
        const mode = searching ? 'search' : 'empty';
        if (emptyStateMode !== mode) {
            emptyStateMode = mode;
            emptyState.update({
                icon: searching ? 'magnifying-glass' : 'comments',
                title: searching ? t`No results` : t`TODO(copy)`,
                description: searching ? '' : t`TODO(copy)`,
            });
        }
        if (!hasRows && !chatList.contains(emptyState.element)) chatList.append(emptyState.element);
    };
    const rowObserver = new MutationObserver(() => {
        decorateAllRows();
        syncEmptyState();
    });
    rowObserver.observe(chatList, { childList: true, subtree: true });
    decorateAllRows();
    syncEmptyState();
    const syncBackupsView = () => {
        if (!(backupsList instanceof HTMLElement)) return;
        const currentBackupsList = popup.querySelector('#chat_backups_list');
        if (!(currentBackupsList instanceof HTMLElement)) return;
        const showingBackups = pageContent.classList.contains('chatBackupsOpen');
        currentBackupsList.hidden = !showingBackups;
        chatList.hidden = showingBackups;
    };
    const backupsObserver = new MutationObserver(syncBackupsView);
    backupsObserver.observe(pageContent, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    syncBackupsView();
    const statusObserver = new MutationObserver(() => {
        const isBusy = !cancelButton.classList.contains('displayNone');
        banner.hidden = !isBusy && !(cleanupPage?.root.isConnected && status.textContent.trim());
    });
    statusObserver.observe(status, { childList: true, characterData: true, subtree: true });
    const syncFrameSearch = () => frame.search?.setQuery(searchInput.value, { notify: false });
    const searchObserver = new MutationObserver(syncFrameSearch);
    searchObserver.observe(chatList, { childList: true });
    const closeFromLegacyVisibility = () => {
        if (legacyHost.hidden || getComputedStyle(legacyHost).display === 'none') {
            void frame.close('close', 'legacy-host-hidden');
        }
    };
    const legacyVisibilityObserver = new MutationObserver(closeFromLegacyVisibility);
    legacyVisibilityObserver.observe(legacyHost, { attributes: true, attributeFilter: ['hidden', 'style'] });
    syncFrameSearch();
    const closeFromLegacyControl = () => { void frame.close('close', 'close'); };
    closeControl?.addEventListener('click', closeFromLegacyControl);
    activeChatHistoryDialog = frame;
    frame.closed.then(() => {
        searchObserver.disconnect();
        rowObserver.disconnect();
        backupsObserver.disconnect();
        statusObserver.disconnect();
        const expectedChatListMarkup = chatListSnapshot.innerHTML;
        chatList.replaceChildren(...chatListSnapshot.cloneNode(true).childNodes);
        popup.querySelectorAll('[aria-controls="chat_backups_list"], #chat_backups_list').forEach(node => node.remove());
        pageContent.remove();
        legacyVisibilityObserver.disconnect();
        legacyHost.append(popup);
        legacyHost.classList.remove('sb-chat-history-compat-open');
        legacyHost.hidden = false;
        legacyHost.style.display = 'none';
        legacyHost.style.removeProperty('opacity');
        for (const [node, wasHidden] of hiddenState) node.hidden = wasHidden;
        const datedSwitchRow = datedInput?.closest('.ds-row-switch');
        datedSwitchRow?.remove();
        if (datedLabel instanceof HTMLLabelElement) {
            for (const child of originalChildren.get(datedLabel) ?? []) datedLabel.append(child);
        }
        const nodes = [...originalPositions.keys()];
        for (const node of nodes.reverse()) {
            if (node === datedInput || node === datedLabel || node === backupsButton || node === backupsList) continue;
            const position = originalPositions.get(node);
            if (!position?.parent) continue;
            position.parent.insertBefore(node, position.next?.parentNode === position.parent ? position.next : null);
        }
        if (datedLabel instanceof HTMLLabelElement) {
            const position = originalPositions.get(datedLabel);
            if (position?.parent) position.parent.insertBefore(datedLabel, position.next?.parentNode === position.parent ? position.next : null);
        }
        for (const node of originalNodes.keys()) {
            const original = originalNodes.get(node);
            if (!(original instanceof Element) || !(node instanceof Element)) continue;
            for (const attribute of [...node.attributes]) {
                if (!original.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
            }
            for (const attribute of [...original.attributes]) node.setAttribute(attribute.name, attribute.value);
        }
        for (const [node, wasHidden] of hiddenState) node.hidden = wasHidden;
        const mobileChatChip = document.querySelector('.sb-bottom-chat-chip');
        if (mobileChatChip instanceof HTMLElement && (!(returnFocus instanceof HTMLElement) || !returnFocus.isConnected || document.activeElement === document.body)) {
            mobileChatChip.focus({ preventScroll: true });
        }
        closeControl?.removeEventListener('click', closeFromLegacyControl);
        if (activeChatHistoryDialog === frame) activeChatHistoryDialog = null;
        legacyChatHistoryRestoreObserver = new MutationObserver(() => {
            if (activeChatHistoryDialog?.root.isConnected) {
                legacyChatHistoryRestoreObserver?.disconnect();
                legacyChatHistoryRestoreObserver = null;
                return;
            }
            if (chatList.innerHTML !== expectedChatListMarkup) {
                chatList.replaceChildren(...chatListSnapshot.cloneNode(true).childNodes);
            }
        });
        legacyChatHistoryRestoreObserver.observe(popup, { childList: true, subtree: true });
    });
    return frame;
}

function createComboCleanupRow(select) {
    const row = document.createElement('div');
    row.className = 'ds-row ds-chat-history-unit-row';
    const label = document.createElement('span');
    label.className = 'ds-row-text ds-row-label';
    label.textContent = select.getAttribute('aria-label') || t`Cleanup age unit`;
    const suffix = document.createElement('span');
    suffix.className = 'ds-row-suffix';
    const arrow = document.createElement('i');
    arrow.className = 'fa-solid fa-chevron-down ds-select-row__arrow';
    arrow.setAttribute('aria-hidden', 'true');
    suffix.append(select, arrow);
    row.append(label, suffix);
    return { row, control: select };
}
