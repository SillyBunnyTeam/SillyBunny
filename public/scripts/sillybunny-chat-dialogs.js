import { t } from './i18n.js';
import { openDialog } from './sillybunny-editor/dialog.js';
import { createCheckRow, createPrefGroup, createSpinRow, createSwitchRow } from './sillybunny-editor/rows.js';

let activeChatHistoryDialog = null;

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
    if (activeChatHistoryDialog?.root.isConnected) {
        const sourceSearch = document.getElementById('select_chat_search');
        if (sourceSearch instanceof HTMLInputElement) {
            activeChatHistoryDialog.search?.setQuery(sourceSearch.value, { notify: false });
        }
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
    if (!(popup instanceof HTMLElement) || !(legacyHost instanceof HTMLElement) || !(searchInput instanceof HTMLInputElement) || !(chatList instanceof HTMLElement)) {
        throw new Error('Chat History markup is incomplete: expected #select_chat_popup, #shadow_select_chat_popup, #select_chat_search, and #select_chat_div.');
    }

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

    const title = heading?.textContent?.replace(/\s+/g, ' ').trim() || t`Chat History`;
    const hiddenState = [heading, searchInput, closeControl].filter(Boolean).map(node => [node, node.hidden]);
    legacyHost.style.display = 'block';
    legacyHost.classList.add('sb-chat-history-compat-open');
    if (heading) heading.hidden = true;
    searchInput.hidden = true;
    if (closeControl) closeControl.hidden = true;

    const frame = openDialog({
        tier: 'window',
        title,
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
        legacyVisibilityObserver.disconnect();
        legacyHost.append(popup);
        legacyHost.classList.remove('sb-chat-history-compat-open');
        legacyHost.hidden = false;
        legacyHost.style.display = 'none';
        legacyHost.style.removeProperty('opacity');
        for (const [node, wasHidden] of hiddenState) node.hidden = wasHidden;
        closeControl?.removeEventListener('click', closeFromLegacyControl);
        if (activeChatHistoryDialog === frame) activeChatHistoryDialog = null;
    });
    return frame;
}
