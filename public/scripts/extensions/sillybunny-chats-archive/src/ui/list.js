import { physicalChatKey, sortRows } from '../core.js';
import { createEntityRow } from '../../../../sillybunny-editor/entity-row.js';
import { createStatusPage } from '../../../../sillybunny-editor/status-page.js';
import { cancelNavigation } from './cancellation.js';
import { LIST_PAGE_SIZE } from './constants.js';
import { button, el, setCount, setStatus, tr } from './dom.js';
import { syncFilterButtons } from './filters.js';
import { loadRows } from './inventory.js';
import { buildLocations } from './locations.js';
import { mentionedRows, mentionSearchState } from './mentions.js';
import { syncLocationPane } from './panes.js';
import { allRows, messageCount, ownerOrReason } from './rows.js';
import { rememberCurrentView } from './saved-views.js';
import { updateSelectionControls } from './selection.js';
import { ALL_LOCATION, filterBase, filterByLocation, withLocation } from './view-model.js';
import { openViewer, selectRow } from './viewer.js';

const SNIPPET_LIMIT = 180;

function computeView(ctx, state, ui, model) {
    const search = mentionSearchState(ui.search.value, ui.characterMentions);
    const source = mentionedRows(state.deepRows ?? allRows(state), search.mentions);
    const text = state.deepRows === null ? search.text : '';
    const base = filterBase(source, model, text, state.organization);
    const searching = Boolean(search.text) || search.mentions.length > 0;
    const locations = buildLocations(ctx, { base, catalog: allRows(state), model, organization: state.organization, searching });
    return { base, locations, searching };
}

/**
 * Rows and sidebar locations for the current search, Filters and location. When Filters hide the chosen
 * location, `fallbackModel` is the model with All Chats chosen instead, and the rows already follow it; the
 * caller commits it. Rows still loading or a scan still running can leave a location empty for now, so only
 * complete data may drop it.
 */
export function deriveView(ctx, state, ui) {
    let view = computeView(ctx, state, ui, state.model);
    let model = state.model;
    let fallbackModel = null;
    if (view.locations.fallback && state.listState === 'ready' && !state.scanAbort) {
        fallbackModel = withLocation(state.model, ALL_LOCATION);
        model = fallbackModel;
        view = computeView(ctx, state, ui, model);
    }
    return { ...view, fallbackModel, rows: sortRows(filterByLocation(view.base, model, state.organization), model.sort) };
}

export function updateBrowseStatus(ctx, state, ui) {
    if (state.listState !== 'ready' || state.deepRows !== null) {
        return;
    }
    const total = allRows(state).length;
    const matching = state.matchingRows.length;
    const filtered = matching !== total || ui.search.value.trim();
    const text = filtered
        ? tr(ctx, '{matching} of {total} indexed chat files', { matching, total })
        : tr(ctx, '{total} indexed chat files', { total });
    setCount(ui, total === 0 ? '' : text);
    if (state.inventoryFailures > 0) {
        setStatus(ui, `${text} ${tr(ctx, 'Some indexed chats could not be loaded.')}`, { alert: true });
    } else {
        setStatus(ui, text);
    }
}

export function updateResultStatus(ctx, state, ui) {
    if (state.searchAbort) {
        return;
    }
    if (state.deepRows === null) {
        updateBrowseStatus(ctx, state, ui);
        return;
    }
    const text = tr(ctx, '{matching} of {total} matching chats', {
        matching: state.matchingRows.length,
        total: state.deepRows.length,
    });
    setCount(ui, text);
    setStatus(ui, text);
}

function syncListHeading(ui, location) {
    ui.listHeading.textContent = location.label;
}

function showStatusPage(ui, options) {
    ui.list.replaceChildren();
    ui.listScroll.replaceChildren(createStatusPage({ compact: true, ...options }).element);
}

function emptyMessage(ctx, state) {
    if (state.deepRows !== null) {
        return tr(ctx, 'No chats contain that message content.');
    }
    return allRows(state).length === 0
        ? tr(ctx, 'No chat files were found.')
        : tr(ctx, 'No chats match these filters.');
}

export function renderList(ctx, state, ui) {
    paintList(ctx, state, ui);
    updateSelectionControls(ctx, state, ui);
}

function paintList(ctx, state, ui) {
    ui.data = deriveView(ctx, state, ui);
    if (ui.data.fallbackModel) {
        state.model = ui.data.fallbackModel;
        rememberCurrentView(ctx, state, ui);
    }
    ui.listEditor?.refresh();
    syncListHeading(ui, ui.data.locations.current);
    syncFilterButtons(state, ui);
    syncLocationPane(ui);

    if (state.listState === 'loading') {
        ui.list.setAttribute('aria-busy', 'true');
        if (state.rows.length === 0) {
            state.matchingRows = [];
            setCount(ui, '');
            showStatusPage(ui, { icon: 'spinner', title: tr(ctx, 'Loading chats...') });
            return;
        }
    }
    if (state.listState === 'error') {
        state.matchingRows = [];
        setCount(ui, '');
        showStatusPage(ui, {
            icon: 'triangle-exclamation',
            title: tr(ctx, 'The chat list could not be loaded.'),
            actions: [{ label: tr(ctx, 'Try Again'), primary: true, onActivate: () => void loadRows(ctx, state, ui) }],
        });
        return;
    }

    const { rows } = ui.data;
    state.matchingRows = rows;
    if (rows.length === 0) {
        showStatusPage(ui, { icon: 'comments', title: emptyMessage(ctx, state) });
        return;
    }

    ui.list.replaceChildren(...rows.slice(0, state.visibleLimit).map(row => buildRow(ctx, state, ui, row)));
    appendListMore(ctx, state, ui, rows);
    ui.listScroll.replaceChildren(ui.list);
}

function appendListMore(ctx, state, ui, rows) {
    if (rows.length <= state.visibleLimit) {
        return;
    }
    const remaining = rows.length - state.visibleLimit;
    const item = el('div', 'sbca-list-more');
    item.setAttribute('role', 'listitem');
    const more = button('menu_button', tr(ctx, 'Show {count} More', { count: Math.min(LIST_PAGE_SIZE, remaining) }));
    more.addEventListener('click', () => {
        const firstNewRow = state.visibleLimit;
        state.visibleLimit += LIST_PAGE_SIZE;
        item.remove();
        const added = rows.slice(firstNewRow, state.visibleLimit).map(row => buildRow(ctx, state, ui, row));
        ui.list.append(...added);
        appendListMore(ctx, state, ui, rows);
        updateSelectionControls(ctx, state, ui);
        (added[0] ?? ui.list.querySelector('.sbca-list-more button'))?.focus({ preventScroll: true });
    });
    item.append(more);
    ui.list.append(item);
}

function symbolicAvatar(kind) {
    const icon = el('i', `sbca-avatar-icon fa-solid ${kind === 'group' ? 'fa-users' : 'fa-triangle-exclamation'}`);
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

function favoriteStar(ctx) {
    const star = el('i', 'sbca-row-star fa-solid fa-star');
    star.setAttribute('role', 'img');
    star.setAttribute('aria-label', tr(ctx, 'Favorite'));
    star.title = tr(ctx, 'Favorite');
    return star;
}

function rowCaption(ctx, row) {
    const parts = [ownerOrReason(ctx, row)];
    if (row.mtime) {
        const date = new Date(row.mtime);
        if (!Number.isNaN(date.valueOf())) {
            parts.push(date.toLocaleDateString());
        }
    }
    if (row.count !== null) {
        parts.push(messageCount(ctx, row.count));
    }
    return parts.join(' · ');
}

function buildRow(ctx, state, ui, row) {
    const key = physicalChatKey(row);
    const caption = rowCaption(ctx, row);
    const favorite = Boolean(state.organization?.chats?.[key]?.favorite);
    const { row: item } = createEntityRow({
        key: `chat:${key}`,
        label: [row.file_id, caption, favorite && tr(ctx, 'Favorite')].filter(Boolean).join(', '),
        title: row.file_id,
        subtitle: caption,
        preview: row.snippet.length > SNIPPET_LIMIT ? `${row.snippet.slice(0, SNIPPET_LIMIT - 1)}…` : row.snippet || null,
        avatar: row.kind === 'solo' ? { src: ctx.getThumbnailUrl('avatar', row.avatar), alt: '' } : symbolicAvatar(row.kind),
        suffix: favorite ? [favoriteStar(ctx)] : [],
        activation: 'activate',
        compatClasses: { row: ['sbca-row'], title: ['sbca-filename'], preview: ['sbca-row-preview'] },
        attributes: { 'data-sbca-key': key, 'data-sbca-kind': row.kind },
    });
    if (state.selectedKey === key) {
        item.setAttribute('aria-current', 'true');
    }
    const open = () => {
        cancelNavigation(state);
        selectRow(state, ui, item, key);
        state.selectedRow = row;
        void openViewer(ctx, state, row, ui);
    };
    item.addEventListener('click', open);
    item.addEventListener('keydown', event => {
        if (event.target === item && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            open();
        }
    });
    return item;
}

export function bindListKeys(ui) {
    ui.list.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
            return;
        }
        const rows = [...ui.list.querySelectorAll('[data-sbca-key]')];
        const current = rows.indexOf(event.target.closest('[data-sbca-key]'));
        if (rows.length === 0 || current < 0) {
            return;
        }
        event.preventDefault();
        if (event.key === 'ArrowDown' && current === rows.length - 1) {
            const more = ui.list.querySelector('.sbca-list-more button');
            if (more) {
                more.click();
                return;
            }
        }
        rows[Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
    });
}
