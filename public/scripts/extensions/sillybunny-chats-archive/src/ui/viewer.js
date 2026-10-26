import { createPrefGroup, createPropertyRow } from '../../../../sillybunny-editor/rows.js';
import { createIconButton } from '../../../../sillybunny-editor/dialog.js';
import { createStatusPage } from '../../../../sillybunny-editor/status-page.js';
import { openActionMenu } from '../../../../sillybunny-action-menu.js';
import { parseChatJsonl, physicalChatKey } from '../core.js';
import { exportChat, fetchArchiveFile } from '../api.js';
import { jumpToChat } from '../ui-navigation.js';
import { cancelViewer } from './cancellation.js';
import { buildOrganizeGroup, mutateChatMetadata } from './chat-organizer.js';
import { button, el, markPlaceholder, placeholderCopy, setStatus, tr } from './dom.js';
import { downloadChat } from './downloads.js';
import { markOrganizationControl, organizationFocusKey } from './focus.js';
import { buildMessagesGroup, buildRawOnlyGroup } from './messages.js';
import { focusChatRow, pushPage } from './panes.js';
import { ownerLabel, ownerOrReason } from './rows.js';

export function selectRow(state, ui, item, key) {
    ui.list.querySelectorAll('[data-sbca-key][aria-current="true"]').forEach(row => row.removeAttribute('aria-current'));
    item.setAttribute('aria-current', 'true');
    state.selectedKey = key;
}

export function resetViewer(state) {
    state.viewerPage?.forceClose();
}

function showViewerPage(ctx, state, ui, row) {
    if (state.viewerPage) {
        state.viewerPage.setTitle(row.file_id);
        state.viewerPage.setSubtitle(ownerOrReason(ctx, row));
        return;
    }
    const page = pushPage(ui, {
        title: row.file_id,
        subtitle: ownerOrReason(ctx, row),
        content: ui.viewerContent,
        className: 'sbca-detail-page',
    });
    state.viewerPage = page;
    void page.closed.then(() => {
        if (state.viewerPage !== page) {
            return;
        }
        state.viewerPage = null;
        cancelViewer(state);
        ui.viewerContent.replaceChildren();
        ui.viewerContent.removeAttribute('aria-busy');
        focusChatRow(ui, state.selectedKey);
    });
}

function propertyRow(label, value, field, { placeholder = false } = {}) {
    const property = createPropertyRow({ label, value, field });
    if (placeholder) {
        markPlaceholder(property.row.querySelector('.ds-row-subtitle'));
    }
    return property.row;
}

function buildSummaryGroup(ctx, row) {
    const rows = [propertyRow(tr(ctx, 'Owner'), ownerLabel(ctx, row), 'owner')];
    if (row.count !== null) {
        rows.push(propertyRow(tr(ctx, 'Messages'), String(row.count), 'messages'));
    }
    if (row.sizeText) {
        rows.push(propertyRow(placeholderCopy(), row.sizeText, 'size', { placeholder: true }));
    }
    if (row.mtime) {
        const label = row.source === 'archive-orphan' ? tr(ctx, 'Modified') : tr(ctx, 'Last message');
        rows.push(propertyRow(label, new Date(row.mtime).toLocaleString(), 'last-message'));
    }
    const group = createPrefGroup({ title: placeholderCopy(), field: 'summary', rows });
    markPlaceholder(group.section.querySelector('.ds-pref-group-heading'));
    return group.section;
}

function buildFavoriteToggle(ctx, state, ui, row) {
    const key = physicalChatKey(row);
    const control = createIconButton(tr(ctx, 'Favorite'), 'star', 'sbca-favorite-action');
    markOrganizationControl(control, organizationFocusKey('viewer-action', key, 'favorite'));
    syncViewerFavoriteAction(state, row, control);
    control.addEventListener('click', () => {
        const pressed = state.organization?.chats?.[key]?.favorite === true;
        mutateChatMetadata(ctx, state, ui, row, value => {
            if (pressed) {
                delete value.favorite;
            } else {
                value.favorite = true;
            }
        });
    });
    return control;
}

function buildOpenChatButton(ctx, state, row) {
    const control = button('menu_button menu_button_primary is-suggested sbca-open-chat');
    control.append(el('span', 'sbca-button-copy', tr(ctx, 'Open chat')));
    if (state.navigationPending) {
        control.setAttribute('aria-disabled', 'true');
        state.navigationControl = control;
    }
    control.addEventListener('click', () => void jumpToChat(ctx, state, row, control));
    return control;
}

function buildActions(ctx, state, ui, row) {
    const element = el('div', 'sbca-detail-actions');
    if (row.kind !== 'orphan') {
        element.append(buildOpenChatButton(ctx, state, row));
    }
    const download = createIconButton(tr(ctx, 'Download'), 'download', 'sbca-download');
    download.setAttribute('aria-haspopup', 'menu');
    download.disabled = true;
    element.append(buildFavoriteToggle(ctx, state, ui, row), download);
    return {
        element,
        enableDownload(raw, allowText) {
            download.disabled = false;
            download.addEventListener('click', () => openActionMenu({
                trigger: download,
                title: tr(ctx, 'Download'),
                bounds: ui.dialog.surface,
                sections: [{
                    items: [
                        {
                            label: tr(ctx, 'Download original (.jsonl)'),
                            icon: 'fa-solid fa-file-export',
                            onSelect: () => downloadChat(ctx, ui, row, raw, 'jsonl'),
                        },
                        ...(allowText ? [{
                            label: tr(ctx, 'Download readable text'),
                            icon: 'fa-solid fa-file-lines',
                            onSelect: () => downloadChat(ctx, ui, row, raw, 'txt'),
                        }] : []),
                    ],
                }],
            }));
        },
    };
}

function buildDetail(ctx, state, ui, row) {
    const actions = buildActions(ctx, state, ui, row);
    const slot = el('div', 'sbca-detail-body');
    ui.viewerContent.replaceChildren(actions.element, buildSummaryGroup(ctx, row), buildOrganizeGroup(ctx, state, row, ui).section, slot);
    return { actions, slot };
}

export async function openViewer(ctx, state, row, ui) {
    if (ui.viewerContent.contains(document.activeElement)) {
        ui.viewerContent.focus({ preventScroll: true });
    }
    cancelViewer(state);
    const controller = new AbortController();
    state.viewerAbort = controller;
    state.selectedRow = row;
    const { actions, slot } = buildDetail(ctx, state, ui, row);
    slot.append(createStatusPage({ icon: 'spinner', title: tr(ctx, 'Loading chat...'), compact: true }).element);
    ui.viewerContent.setAttribute('aria-busy', 'true');
    showViewerPage(ctx, state, ui, row);

    try {
        const raw = await loadRawChat(ctx, state, row, controller.signal);
        if (state.viewerAbort !== controller || state.closed) {
            return;
        }
        let shaped;
        try {
            shaped = await parseChatJsonl(raw, { signal: controller.signal });
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw error;
            }
            if (state.viewerAbort !== controller || state.closed) {
                return;
            }
            console.warn('[Chat Archive] chat is readable but contains invalid JSONL:', error);
            actions.enableDownload(raw, false);
            slot.replaceChildren(buildRawOnlyGroup(ctx, raw).section);
            if (!state.searchAbort && state.deepRows === null) {
                setStatus(ui, tr(ctx, 'Opened raw file for {name}; message parsing failed.', { name: row.file_id }), { alert: true });
            }
            return;
        }
        if (state.viewerAbort !== controller || state.closed) {
            return;
        }
        actions.enableDownload(raw, true);
        const messages = buildMessagesGroup(ctx, state, { raw, shaped });
        slot.replaceChildren(messages.section);
        messages.focusMatch();
        if (!state.searchAbort && state.deepRows === null) {
            setStatus(ui, tr(ctx, 'Opened {name}', { name: row.file_id }));
        }
    } catch (error) {
        if (error?.name === 'AbortError') {
            return;
        }
        console.error('[Chat Archive] failed to load chat:', error);
        if (state.viewerAbort === controller) {
            const failure = createStatusPage({
                icon: 'triangle-exclamation',
                title: tr(ctx, 'Could not read this chat. Refresh the archive or scan for orphaned files again.'),
                compact: true,
                actions: [{ label: tr(ctx, 'Try again'), primary: true, onActivate: () => void openViewer(ctx, state, row, ui) }],
            });
            failure.element.setAttribute('role', 'alert');
            slot.replaceChildren(failure.element);
            if (!state.searchAbort && state.deepRows === null) {
                setStatus(ui, tr(ctx, 'Could not open {name}', { name: row.file_id }), { alert: true });
            }
        }
    } finally {
        if (state.viewerAbort === controller) {
            state.viewerAbort = null;
            ui.viewerContent.removeAttribute('aria-busy');
        }
    }
}

export async function loadRawChat(ctx, state, row, signal) {
    if (row.source === 'archive-orphan') {
        const readToken = state.orphanScanReadToken ?? state.archiveReadToken;
        if (!readToken || !row.archiveHash) {
            throw new Error('Orphan scan expired');
        }
        return fetchArchiveFile(ctx, readToken, row.archiveHash, signal);
    }

    const isGroup = row.kind === 'group' || row.orphanType === 'missing-group';
    // ponytail: the host maps ".png" to the chats root; use an explicit root API when one exists.
    const avatarUrl = row.orphanType === 'root' ? '.png' : row.avatar;
    const data = await exportChat(ctx, {
        is_group: isGroup,
        avatar_url: avatarUrl ?? undefined,
        file: row.file_name || `${row.file_id}.jsonl`,
        exportfilename: row.file_name || `${row.file_id}.jsonl`,
        format: 'jsonl',
    }, signal);
    if (typeof data?.result !== 'string') {
        throw new Error('Chat export did not return file data');
    }
    return data.result;
}

export function syncViewerFavoriteAction(state, row, control) {
    const key = physicalChatKey(row);
    control.setAttribute('aria-pressed', String(state.organization?.chats?.[key]?.favorite === true));
    control.disabled = !state.organizationWritable;
}
