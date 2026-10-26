import { createButtonRow, createExpanderRow, createPrefGroup, createRow } from '../../../../sillybunny-editor/rows.js';
import { findMatchingMessageIndex } from '../core.js';
import { MESSAGE_PAGE_SIZE, RAW_PREVIEW_CHARS } from './constants.js';
import { el, flatButton, glyph, tr } from './dom.js';
import { nextRenderId } from './render-id.js';

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

/** An expander row whose JSON is rendered on first open, so a long chat does not stringify every message up front. */
function jsonExpander(ctx, label, value, field) {
    let rendered = false;
    const expander = createExpanderRow({
        label: tr(ctx, label),
        field,
        onToggle: open => {
            if (open && !rendered) {
                expander.content.append(el('pre', 'sbca-json', JSON.stringify(value, null, 2)));
                rendered = true;
            }
        },
    });
    return expander.row;
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
        card.append(jsonExpander(ctx, 'Response alternatives', message.alternatives, 'alternatives'));
    }
    if (message.extra && Object.keys(message.extra).length > 0) {
        card.append(jsonExpander(ctx, 'Extension data', message.extra, 'extension-data'));
    }
    return card;
}

function pagerRow(text, icon, onActivate) {
    const pager = createButtonRow({ label: text, icon, field: 'pager', onActivate });
    pager.row.classList.add('sbca-pager');
    return pager.row;
}

function buildRawView(ctx, raw, messages) {
    const view = el('pre', 'sbca-raw');
    view.id = `sbca_raw_${nextRenderId()}`;
    view.hidden = true;
    const toggle = flatButton(tr(ctx, 'Show raw file'));
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', view.id);
    toggle.addEventListener('click', () => {
        const showRaw = view.hidden;
        if (showRaw && !view.dataset.loaded) {
            view.textContent = raw.length > RAW_PREVIEW_CHARS
                ? `${raw.slice(0, RAW_PREVIEW_CHARS)}\n\n${tr(ctx, 'Raw preview truncated. Download the original file to inspect the rest.')}`
                : raw;
            view.dataset.loaded = 'true';
        }
        view.hidden = !showRaw;
        if (messages) {
            messages.hidden = showRaw;
        }
        toggle.setAttribute('aria-expanded', String(showRaw));
        toggle.querySelector('.sbca-button-copy').textContent = tr(ctx, showRaw && messages ? 'Show messages' : showRaw ? 'Hide raw file' : 'Show raw file');
    });
    return { view, toggle };
}

function messagesGroup(ctx, headerActions) {
    const actions = el('div', 'sbca-messages-actions');
    actions.append(...headerActions);
    const group = createPrefGroup({ title: tr(ctx, 'Messages'), field: 'messages', headerSuffix: actions });
    group.section.classList.add('sbca-messages-section');
    group.group.classList.add('sbca-messages-group');
    return group;
}

export function buildMessagesGroup(ctx, state, { raw, shaped }) {
    const matchIndex = state.deepRows === null ? -1 : findMatchingMessageIndex(shaped.messages, state.deepQuery);
    const matchQuery = state.deepQuery;
    const total = shaped.messages.length;
    const start = matchIndex < 0 ? 0 : Math.floor(matchIndex / MESSAGE_PAGE_SIZE) * MESSAGE_PAGE_SIZE;
    const messages = el('div', 'sbca-messages');
    const messageList = el('div', 'sbca-message-list');
    messageList.setAttribute('role', 'list');
    messageList.setAttribute('aria-label', tr(ctx, 'Chat messages'));

    const showPage = pageStart => {
        messages.replaceChildren();
        messageList.replaceChildren();
        if (pageStart > 0) {
            const count = Math.min(MESSAGE_PAGE_SIZE, pageStart);
            messages.append(pagerRow(tr(ctx, 'Show {count} earlier messages', { count }), 'angles-up',
                () => showPage(Math.max(0, pageStart - MESSAGE_PAGE_SIZE))?.focus({ preventScroll: true })));
        }
        messages.append(messageList);
        const end = Math.min(pageStart + MESSAGE_PAGE_SIZE, total);
        const markedIndex = state.deepRows !== null && state.deepQuery === matchQuery ? matchIndex : -1;
        let firstCard = null;
        for (let index = pageStart; index < end; index += 1) {
            const card = buildMessage(ctx, shaped.messages[index]);
            if (index === markedIndex) {
                card.classList.add('sbca-msg-match');
                card.querySelector('.sbca-msg-head')?.append(el('span', 'sbca-match-label', tr(ctx, 'First search match')));
            }
            firstCard ??= card;
            messageList.append(card);
        }
        if (end < total) {
            const count = Math.min(MESSAGE_PAGE_SIZE, total - end);
            messages.append(pagerRow(tr(ctx, 'Show {count} more messages', { count }), 'angles-down',
                () => showPage(end)?.focus({ preventScroll: true })));
        }
        return firstCard;
    };

    if (total === 0) {
        messages.append(messageList, createRow({ label: tr(ctx, 'This chat is empty.'), field: 'empty' }).row);
    } else {
        showPage(start);
    }

    const { view, toggle } = buildRawView(ctx, raw, messages);
    const headerActions = [];
    if (total > MESSAGE_PAGE_SIZE) {
        const latest = flatButton(tr(ctx, 'Latest messages'), 'angles-down');
        latest.addEventListener('click', () => {
            const card = showPage(total - MESSAGE_PAGE_SIZE);
            card?.focus({ preventScroll: true });
            card?.scrollIntoView({ block: 'start' });
        });
        headerActions.push(latest);
    }
    headerActions.push(toggle);
    const group = messagesGroup(ctx, headerActions);
    group.append(messages, view);
    const metadata = shaped.header?.chat_metadata;
    if (metadata && Object.keys(metadata).length > 0) {
        group.append(jsonExpander(ctx, 'Chat metadata', metadata, 'metadata'));
    }
    return {
        section: group.section,
        focusMatch() {
            const match = messages.querySelector('.sbca-msg-match');
            match?.focus({ preventScroll: true });
            match?.scrollIntoView({ block: 'center' });
        },
    };
}

export function buildRawOnlyGroup(ctx, raw) {
    const { view, toggle } = buildRawView(ctx, raw, null);
    const warning = createRow({
        label: tr(ctx, 'This file contains invalid JSONL. You can still download or inspect the original file.'),
        field: 'invalid-jsonl',
        prefix: glyph('triangle-exclamation'),
    }).row;
    warning.setAttribute('role', 'alert');
    warning.classList.add('sbca-viewer-error');
    const group = messagesGroup(ctx, [toggle]);
    group.append(warning, view);
    return { section: group.section };
}
