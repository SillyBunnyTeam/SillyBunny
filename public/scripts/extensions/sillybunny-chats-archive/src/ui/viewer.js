import { findMatchingMessageIndex, parseChatJsonl, physicalChatKey } from '../core.js';
import { exportChat, fetchArchiveFile } from '../api.js';
import { jumpToChat } from '../ui-navigation.js';
import { cancelViewer } from './cancellation.js';
import { buildChatOrganizer, mutateChatMetadata } from './chat-organizer.js';
import { MESSAGE_PAGE_SIZE, RAW_PREVIEW_CHARS } from './constants.js';
import {
    actionButton,
    button,
    el,
    setStatus,
    tr,
} from './dom.js';
import { downloadChat } from './downloads.js';
import { markOrganizationControl, organizationFocusKey } from './focus.js';
import { nextRenderId, renderId } from './render-id.js';
import { messageCount, ownerLabel } from './rows.js';

export function selectRow(state, ui, block, key) {
    ui.list.querySelectorAll('.sbca-row-button[aria-current="true"]').forEach(row => row.removeAttribute('aria-current'));
    block.setAttribute('aria-current', 'true');
    state.selectedKey = key;
    state.selectedButton = block;
}

export function showList(state, ui) {
    ui.root.dataset.sbcaView = 'list';
    const target = state.selectedButton?.isConnected ? state.selectedButton : ui.search;
    target.focus({ preventScroll: true });
}

function showDetail(ui) {
    ui.root.dataset.sbcaView = 'detail';
    if (ui.mobileQuery.matches) {
        ui.viewerTitle.focus({ preventScroll: true });
    }
}

export function resetViewer(ctx, ui) {
    ui.root.dataset.sbcaView = 'list';
    ui.viewerTitle.textContent = tr(ctx, 'Chat details');
    ui.viewerContent.replaceChildren(el('p', 'sbca-placeholder', tr(ctx, 'Select a chat to inspect it.')));
    ui.viewer.removeAttribute('aria-busy');
}

export async function openViewer(ctx, state, row, ui) {
    if (ui.viewerContent.contains(document.activeElement)) {
        ui.viewerTitle.focus({ preventScroll: true });
    }
    cancelViewer(state);
    const controller = new AbortController();
    state.viewerAbort = controller;
    state.selectedRow = row;
    ui.viewerTitle.textContent = row.file_id;
    const loadingDetails = el('div', 'sbca-viewer-details');
    loadingDetails.append(
        buildSummary(ctx, row),
        el('p', 'sbca-placeholder', tr(ctx, 'Loading chat...')),
    );
    ui.viewerContent.replaceChildren(buildChatOrganizer(ctx, state, row, ui), loadingDetails);
    ui.viewer.setAttribute('aria-busy', 'true');
    showDetail(ui);

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
            renderMalformedViewer(ctx, state, row, raw, ui);
            if (!state.searchAbort && state.deepRows === null) {
                setStatus(ui, tr(ctx, 'Opened raw file for {name}; message parsing failed.', { name: row.file_id }));
            }
            return;
        }
        if (state.viewerAbort !== controller || state.closed) {
            return;
        }
        renderViewer(ctx, state, row, raw, shaped, ui);
        if (!state.searchAbort && state.deepRows === null) {
            setStatus(ui, tr(ctx, 'Opened {name}', { name: row.file_id }));
        }
    } catch (error) {
        if (error?.name === 'AbortError') {
            return;
        }
        console.error('[Chat Archive] failed to load chat:', error);
        if (state.viewerAbort === controller) {
            const errorMessage = el('div', 'sbca-viewer-error', tr(ctx, 'Could not read this chat. Refresh the archive or scan for orphaned files again.'));
            errorMessage.setAttribute('role', 'alert');
            const retry = button('sbca-control', tr(ctx, 'Try again'));
            retry.addEventListener('click', () => void openViewer(ctx, state, row, ui));
            const details = el('div', 'sbca-viewer-details');
            details.append(buildSummary(ctx, row), errorMessage, retry);
            ui.viewerContent.replaceChildren(buildChatOrganizer(ctx, state, row, ui), details);
            if (!state.searchAbort && state.deepRows === null) {
                setStatus(ui, tr(ctx, 'Could not open {name}', { name: row.file_id }));
            }
        }
    } finally {
        if (state.viewerAbort === controller) {
            state.viewerAbort = null;
            ui.viewer.removeAttribute('aria-busy');
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

function buildSummary(ctx, row) {
    const summary = el('div', 'sbca-summary');
    summary.append(el('div', 'sbca-summary-line', ownerLabel(ctx, row)));
    const facts = [];
    if (row.count !== null) {
        facts.push(messageCount(ctx, row.count));
    }
    if (row.sizeText) {
        facts.push(row.sizeText);
    }
    if (facts.length > 0) {
        summary.append(el('div', 'sbca-summary-line', facts.join(' | ')));
    }
    if (row.mtime) {
        const label = row.source === 'archive-orphan' ? tr(ctx, 'Modified') : tr(ctx, 'Last message');
        summary.append(el('div', 'sbca-summary-line', `${label}: ${new Date(row.mtime).toLocaleString()}`));
    }
    return summary;
}

function renderViewer(ctx, state, row, raw, shaped, ui) {
    const matchIndex = state.deepRows === null ? -1 : findMatchingMessageIndex(shaped.messages, state.deepQuery);
    const matchQuery = state.deepQuery;
    const start = matchIndex < 0 ? 0 : Math.floor(matchIndex / MESSAGE_PAGE_SIZE) * MESSAGE_PAGE_SIZE;
    const messages = el('div', 'sbca-messages');
    messages.id = `sbca_messages_${nextRenderId()}`;
    const messageList = el('div', 'sbca-message-list');
    messageList.setAttribute('role', 'list');
    messageList.setAttribute('aria-label', tr(ctx, 'Chat messages'));
    const showPage = pageStart => {
        messages.replaceChildren();
        messageList.replaceChildren();
        if (pageStart > 0) {
            const earlier = button('sbca-control sbca-more-messages', tr(ctx, 'Show {count} earlier messages', {
                count: Math.min(MESSAGE_PAGE_SIZE, pageStart),
            }));
            earlier.addEventListener('click', () => showPage(Math.max(0, pageStart - MESSAGE_PAGE_SIZE))?.focus({ preventScroll: true }));
            messages.append(earlier);
        }
        messages.append(messageList);
        const getMatchIndex = () => state.deepRows !== null && state.deepQuery === matchQuery ? matchIndex : -1;
        return appendMessagePage(ctx, shaped.messages, messageList, messages, pageStart, getMatchIndex, showPage);
    };
    const showLatest = shaped.messages.length > MESSAGE_PAGE_SIZE ? () => {
        const latest = showPage(shaped.messages.length - MESSAGE_PAGE_SIZE);
        latest?.focus({ preventScroll: true });
        latest?.scrollIntoView({ block: 'start' });
    } : null;
    const actions = buildViewerActions(ctx, state, row, raw, true, showLatest, ui);
    const details = el('div', 'sbca-viewer-details');
    details.append(buildSummary(ctx, row));
    const metadata = shaped.header?.chat_metadata;
    if (metadata && Object.keys(metadata).length > 0) {
        details.append(jsonDetails(ctx, 'Chat metadata', metadata));
    }

    if (shaped.messages.length === 0) {
        messages.append(messageList, el('p', 'sbca-placeholder', tr(ctx, 'This chat is empty.')));
    } else {
        showPage(start);
    }

    const rawView = el('pre', 'sbca-raw');
    rawView.id = `sbca_raw_${renderId}`;
    rawView.hidden = true;
    const rawToggle = buildRawToggle(ctx, raw, rawView, messages);

    details.append(rawToggle, messages, rawView);
    ui.viewerContent.replaceChildren(actions, buildChatOrganizer(ctx, state, row, ui), details);
    const match = messages.querySelector('.sbca-msg-match');
    match?.focus({ preventScroll: true });
    match?.scrollIntoView({ block: 'center' });
}

function buildViewerActions(ctx, state, row, raw, allowText, showLatest, ui) {
    const actions = el('div', 'sbca-viewer-actions');
    if (showLatest) {
        const latestButton = actionButton(ctx, 'Latest messages', 'fa-angles-down');
        latestButton.addEventListener('click', showLatest);
        actions.append(latestButton);
    }
    const jsonlButton = actionButton(ctx, 'Download original (.jsonl)', 'fa-file-export');
    jsonlButton.addEventListener('click', () => downloadChat(ctx, row, raw, 'jsonl', jsonlButton));
    actions.append(jsonlButton);
    if (allowText) {
        const textButton = actionButton(ctx, 'Download readable text', 'fa-file-lines');
        textButton.addEventListener('click', () => downloadChat(ctx, row, raw, 'txt', textButton));
        actions.append(textButton);
    }
    if (row.kind !== 'orphan') {
        const jumpButton = actionButton(ctx, 'Open chat', 'fa-arrow-right-to-bracket');
        if (state.navigationPending) {
            jumpButton.setAttribute('aria-disabled', 'true');
            state.navigationControl = jumpButton;
        }
        jumpButton.addEventListener('click', () => void jumpToChat(ctx, state, row, jumpButton));
        actions.append(jumpButton);
    }
    actions.append(buildViewerFavoriteAction(ctx, state, row, ui));
    return actions;
}

function buildViewerFavoriteAction(ctx, state, row, ui) {
    const key = physicalChatKey(row);
    const control = actionButton(ctx, 'Favorite', 'fa-heart');
    control.classList.add('sbca-favorite-action');
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

export function syncViewerFavoriteAction(state, row, control) {
    const key = physicalChatKey(row);
    control.setAttribute('aria-pressed', String(state.organization?.chats?.[key]?.favorite === true));
    control.disabled = !state.organizationWritable;
}

function renderMalformedViewer(ctx, state, row, raw, ui) {
    const warning = el('div', 'sbca-viewer-error', tr(ctx, 'This file contains invalid JSONL. You can still download or inspect the original file.'));
    warning.setAttribute('role', 'alert');
    const rawView = el('pre', 'sbca-raw');
    rawView.id = `sbca_raw_${nextRenderId()}`;
    rawView.hidden = true;
    const details = el('div', 'sbca-viewer-details');
    details.append(
        buildSummary(ctx, row),
        warning,
        buildRawToggle(ctx, raw, rawView),
        rawView,
    );
    ui.viewerContent.replaceChildren(
        buildViewerActions(ctx, state, row, raw, false, null, ui),
        buildChatOrganizer(ctx, state, row, ui),
        details,
    );
}

function buildRawToggle(ctx, raw, rawView, messages = null) {
    const control = button('sbca-control sbca-raw-toggle', tr(ctx, 'Show raw file'));
    control.setAttribute('aria-expanded', 'false');
    control.setAttribute('aria-controls', rawView.id);
    control.addEventListener('click', () => {
        const showRaw = rawView.hidden;
        if (showRaw && !rawView.dataset.loaded) {
            rawView.textContent = raw.length > RAW_PREVIEW_CHARS
                ? `${raw.slice(0, RAW_PREVIEW_CHARS)}\n\n${tr(ctx, 'Raw preview truncated. Download the original file to inspect the rest.')}`
                : raw;
            rawView.dataset.loaded = 'true';
        }
        rawView.hidden = !showRaw;
        if (messages) {
            messages.hidden = showRaw;
        }
        control.setAttribute('aria-expanded', String(showRaw));
        control.textContent = tr(ctx, showRaw && messages ? 'Show messages' : showRaw ? 'Hide raw file' : 'Show raw file');
    });
    return control;
}

function appendMessagePage(ctx, messages, list, controls, start, getMatchIndex, showPage) {
    const end = Math.min(start + MESSAGE_PAGE_SIZE, messages.length);
    const matchIndex = getMatchIndex();
    let firstCard = null;
    for (let index = start; index < end; index += 1) {
        const card = buildMessage(ctx, messages[index]);
        if (index === matchIndex) {
            card.classList.add('sbca-msg-match');
            card.querySelector('.sbca-msg-head')?.append(el('span', 'sbca-match-label', tr(ctx, 'First search match')));
        }
        firstCard ??= card;
        list.append(card);
    }
    if (end < messages.length) {
        const more = button('sbca-control sbca-more-messages', tr(ctx, 'Show {count} more messages', {
            count: Math.min(MESSAGE_PAGE_SIZE, messages.length - end),
        }));
        more.addEventListener('click', () => {
            showPage(end)?.focus({ preventScroll: true });
        });
        controls.append(more);
    }
    return firstCard;
}

function buildMessage(ctx, message) {
    const role = message.isSystem ? 'system' : message.isUser ? 'user' : 'assistant';
    const roleLabels = { system: 'System', user: 'You', assistant: 'Assistant' };
    const card = el('article', 'sbca-msg');
    card.dataset.sbcaRole = role;
    card.setAttribute('role', 'listitem');
    card.tabIndex = -1;
    const head = el('header', 'sbca-msg-head');
    const roleLabel = tr(ctx, roleLabels[role]);
    const displayName = message.name || roleLabel;
    head.append(el('strong', undefined, displayName));
    if (displayName.toLocaleLowerCase() !== roleLabel.toLocaleLowerCase()) {
        head.append(el('span', 'sbca-role', roleLabel));
    }
    if (message.send_date) {
        const time = el('time', undefined, formatSendDate(ctx, message.send_date));
        const parsed = new Date(message.send_date);
        if (!Number.isNaN(parsed.valueOf())) {
            time.dateTime = parsed.toISOString();
        }
        head.append(time);
    }
    if (message.swipeCount > 0) {
        head.append(el('span', 'sbca-chip', tr(ctx, message.swipeCount === 1
            ? '{count} response alternative'
            : '{count} response alternatives', { count: message.swipeCount })));
    }
    card.append(head, el('div', 'sbca-msg-text', message.mes));
    if (message.alternatives.length > 0) {
        card.append(jsonDetails(ctx, 'Response alternatives', message.alternatives));
    }
    if (message.extra && Object.keys(message.extra).length > 0) {
        card.append(jsonDetails(ctx, 'Extension data', message.extra));
    }
    return card;
}

function jsonDetails(ctx, label, value) {
    const details = el('details', 'sbca-json-details');
    details.append(el('summary', undefined, tr(ctx, label)));
    let rendered = false;
    details.addEventListener('toggle', () => {
        if (details.open && !rendered) {
            details.append(el('pre', undefined, JSON.stringify(value, null, 2)));
            rendered = true;
        }
    });
    return details;
}

function formatSendDate(ctx, sendDate) {
    if (!sendDate) {
        return '';
    }
    try {
        const moment = ctx.timestampToMoment(sendDate);
        if (moment?.isValid?.()) {
            return moment.format('lll');
        }
    } catch {
        // Fall through to the raw value.
    }
    return String(sendDate);
}
