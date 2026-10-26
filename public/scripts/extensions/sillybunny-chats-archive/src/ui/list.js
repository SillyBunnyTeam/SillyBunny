import { filterRows, groupRows, physicalChatKey, sortRows } from '../core.js';
import { cancelNavigation } from './cancellation.js';
import { KINDS, LIST_PAGE_SIZE } from './constants.js';
import { button, el, setStatus, tr } from './dom.js';
import { loadRows } from './inventory.js';
import { mentionedRows, mentionSearchState } from './mentions.js';
import { allRows, messageCount, orphanLabel, ownerLabel } from './rows.js';
import { currentSavedView } from './saved-views.js';
import { updateSelectionControls } from './selection.js';
import { openViewer, selectRow } from './viewer.js';

function visibleRows(state, ui) {
    const search = mentionSearchState(ui.search.value, ui.characterMentions);
    const source = mentionedRows(state.deepRows ?? allRows(state), search.mentions);
    const text = state.deepRows === null ? search.text : '';
    const options = { ...currentSavedView(state, ui), text, favoritesSelected: ui.favorite.checked };
    delete options.query;
    delete options.sort;
    delete options.group;
    delete options.density;
    return sortRows(filterRows(source, options, state.organization), ui.sort.value);
}

export function updateBrowseStatus(ctx, state, ui) {
    if (state.listState !== 'ready' || state.deepRows !== null) {
        return;
    }
    const total = allRows(state).length;
    const matching = state.matchingRows.length;
    const filtered = matching !== total || ui.search.value.trim();
    let text = filtered
        ? tr(ctx, '{matching} of {total} indexed chat files', { matching, total })
        : tr(ctx, '{total} indexed chat files', { total });
    if (state.inventoryFailures > 0) {
        text += ` ${tr(ctx, 'Some indexed chats could not be loaded.')}`;
    }
    setStatus(ui, text);
}

export function renderList(ctx, state, ui) {
    ui.list.replaceChildren();
    state.selectedButton = null;
    if (state.listState === 'loading') {
        ui.list.setAttribute('aria-busy', 'true');
        if (state.rows.length === 0) {
            state.matchingRows = [];
            ui.list.append(listMessage(tr(ctx, 'Loading chats...')));
            return;
        }
    }
    if (state.listState === 'error') {
        state.matchingRows = [];
        const item = listMessage(tr(ctx, 'The chat list could not be loaded.'));
        const retry = button('sbca-control', tr(ctx, 'Try again'));
        retry.addEventListener('click', () => void loadRows(ctx, state, ui));
        item.append(retry);
        ui.list.append(item);
        return;
    }

    const rows = visibleRows(state, ui);
    state.matchingRows = rows;
    if (rows.length === 0) {
        const message = state.deepRows !== null
            ? tr(ctx, 'No chats contain that message content.')
            : allRows(state).length === 0
                ? tr(ctx, 'No chat files were found.')
                : tr(ctx, 'No chats match these filters.');
        ui.list.append(listMessage(message));
        return;
    }

    const shownRows = new Set(rows.slice(0, state.visibleLimit));
    for (const group of groupRows(rows, ui.group.value, state.organization)) {
        const shownGroupRows = group.rows.filter(row => shownRows.has(row));
        if (shownGroupRows.length === 0) {
            continue;
        }
        const collapseKey = JSON.stringify([ui.group.value, group.key]);
        const collapsed = state.collapsedGroups.has(collapseKey);
        if (ui.group.value !== 'flat') {
            const item = el('li', 'sbca-group-header');
            const heading = button('sbca-group-button', `${groupDisplayLabel(ctx, ui.group.value, group.label)} (${group.rows.length})`);
            heading.dataset.sbcaGroupKey = collapseKey;
            heading.setAttribute('aria-expanded', String(!collapsed));
            heading.addEventListener('click', () => {
                if (state.collapsedGroups.has(collapseKey)) {
                    state.collapsedGroups.delete(collapseKey);
                } else {
                    state.collapsedGroups.add(collapseKey);
                }
                renderList(ctx, state, ui);
                [...ui.list.querySelectorAll('.sbca-group-button')]
                    .find(control => control.dataset.sbcaGroupKey === collapseKey)
                    ?.focus({ preventScroll: true });
            });
            item.append(heading);
            ui.list.append(item);
        }
        if (!collapsed) {
            for (const row of shownGroupRows) {
                ui.list.append(buildRow(ctx, state, ui, row));
            }
        }
    }
    appendListMore(ctx, state, ui, rows);
}

function appendListMore(ctx, state, ui, rows) {
    if (rows.length <= state.visibleLimit) {
        return;
    }
    const remaining = rows.length - state.visibleLimit;
    const item = el('li', 'sbca-list-more');
    const more = button('sbca-control', tr(ctx, 'Show {count} more', { count: Math.min(LIST_PAGE_SIZE, remaining) }));
    more.addEventListener('click', () => {
        const firstNewRow = state.visibleLimit;
        state.visibleLimit += LIST_PAGE_SIZE;
        if (ui.group.value !== 'flat') {
            const newKeys = new Set(rows.slice(firstNewRow, state.visibleLimit).map(physicalChatKey));
            renderList(ctx, state, ui);
            ([...ui.list.querySelectorAll('.sbca-row-button')]
                .find(control => newKeys.has(control.dataset.sbcaKey)) ?? ui.list.querySelector('.sbca-list-more .sbca-control'))
                ?.focus({ preventScroll: true });
            return;
        }
        item.remove();
        const fragment = document.createDocumentFragment();
        let firstButton = null;
        for (const row of rows.slice(firstNewRow, state.visibleLimit)) {
            const rowItem = buildRow(ctx, state, ui, row);
            firstButton ??= rowItem.querySelector('.sbca-row-button');
            fragment.append(rowItem);
        }
        ui.list.append(fragment);
        appendListMore(ctx, state, ui, rows);
        (firstButton ?? ui.list.querySelector('.sbca-list-more .sbca-control'))?.focus({ preventScroll: true });
    });
    item.append(more);
    ui.list.append(item);
}

function groupDisplayLabel(ctx, mode, label) {
    if (mode === 'type') {
        return tr(ctx, Object.fromEntries(KINDS)[label] ?? label);
    }
    if (mode === 'folder' && label === 'Unfiled') {
        return tr(ctx, 'Unfiled');
    }
    return label || tr(ctx, 'Unknown owner');
}

function listMessage(text) {
    const item = el('li', 'sbca-list-message');
    item.append(el('p', 'sbca-placeholder', text));
    return item;
}

function buildRow(ctx, state, ui, row) {
    const item = el('li', 'sbca-row');
    const block = button('sbca-row-button');
    const key = physicalChatKey(row);
    block.dataset.sbcaKind = row.kind;
    block.dataset.sbcaKey = key;
    if (state.selectedKey === key) {
        block.setAttribute('aria-current', 'true');
        state.selectedButton = block;
    }

    const head = el('span', 'sbca-row-head');
    if (row.kind === 'solo') {
        const img = document.createElement('img');
        img.className = 'sbca-avatar';
        img.src = ctx.getThumbnailUrl('avatar', row.avatar);
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        head.append(img);
    } else {
        const icon = el('i', `sbca-avatar-icon fa-solid ${row.kind === 'group' ? 'fa-users' : 'fa-triangle-exclamation'}`);
        icon.setAttribute('aria-hidden', 'true');
        head.append(icon);
    }

    const title = el('span', 'sbca-row-title');
    title.append(el('span', 'sbca-filename', row.file_id));
    const owner = el('span', 'sbca-owner', ownerLabel(ctx, row));
    if (row.kind === 'orphan') {
        owner.append(el('span', 'sbca-badge', orphanLabel(ctx, row.orphanType)));
    }
    title.append(owner);
    head.append(title);

    const info = el('span', 'sbca-row-info');
    if (row.mtime) {
        const date = new Date(row.mtime);
        if (!Number.isNaN(date.valueOf())) {
            const time = el('time', undefined, date.toLocaleDateString());
            time.dateTime = date.toISOString();
            info.append(time);
        }
    }
    if (row.sizeText) {
        info.append(el('span', undefined, row.sizeText));
    }
    if (row.count !== null) {
        info.append(el('span', undefined, messageCount(ctx, row.count)));
    }
    head.append(info);
    block.append(head);
    const metadata = state.organization?.chats?.[key];
    if (metadata) {
        const indicators = el('span', 'sbca-curation-indicators');
        if (metadata.favorite) {
            indicators.append(el('span', 'sbca-curation-favorite', tr(ctx, 'Favorite')));
        }
        const folder = state.organization.folders.find(item => item.id === metadata.folder);
        if (folder) {
            indicators.append(el('span', 'sbca-curation-folder', tr(ctx, 'Folder: {name}', { name: folder.name })));
        }
        for (const id of metadata.collections ?? []) {
            const collection = state.organization.collections.find(item => item.id === id);
            if (collection) {
                indicators.append(el('span', 'sbca-curation-collection', tr(ctx, 'Collection: {name}', { name: collection.name })));
            }
        }
        for (const tag of metadata.tags ?? []) {
            indicators.append(el('span', 'sbca-curation-tag', tr(ctx, 'Tag: {name}', { name: tag })));
        }
        if (indicators.childElementCount > 0) {
            block.append(indicators);
        }
    }
    if (row.snippet) {
        const snippet = row.snippet.length > 180 ? `${row.snippet.slice(0, 177)}...` : row.snippet;
        block.append(el('span', 'sbca-row-preview', snippet));
    }
    block.addEventListener('click', () => {
        cancelNavigation(state);
        selectRow(state, ui, block, key);
        state.selectedRow = row;
        void openViewer(ctx, state, row, ui);
    });
    if (state.selectionMode) {
        const selectLabel = el('label', 'sbca-row-selection');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = state.selectedBatchKeys.has(key);
        checkbox.setAttribute('aria-label', tr(ctx, 'Select {name} for {owner}', {
            name: row.file_id,
            owner: ownerLabel(ctx, row),
        }));
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                state.selectedBatchKeys.add(key);
            } else {
                state.selectedBatchKeys.delete(key);
            }
            updateSelectionControls(ctx, state, ui);
        });
        selectLabel.append(checkbox);
        item.append(selectLabel);
    }
    item.append(block);
    return item;
}
