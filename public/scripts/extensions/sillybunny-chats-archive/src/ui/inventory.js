import { normalizeRow, physicalChatKey } from '../core.js';
import { iterateArchiveInventoryPages, releaseArchiveSession } from '../api.js';
import { cancelNavigation, cancelViewer, exitDeepSearch } from './cancellation.js';
import { LIST_PAGE_SIZE } from './constants.js';
import { runDeepSearch } from './deep-search.js';
import { setStatus, tr } from './dom.js';
import { renderList, updateBrowseStatus } from './list.js';
import { mentionSearchState } from './mentions.js';
import { refreshOwnerOptions } from './owner-picker.js';
import { allRows } from './rows.js';
import { updateSelectionControls } from './selection.js';
import { resetViewer } from './viewer.js';

export async function loadRows(ctx, state, ui) {
    if (state.scanAbort) {
        return;
    }
    if (ui.list.contains(document.activeElement)) {
        ui.listHeading.focus({ preventScroll: true });
    } else if (ui.viewerContent.contains(document.activeElement)) {
        ui.viewerTitle.focus({ preventScroll: true });
    }
    exitDeepSearch(ctx, state, ui);
    cancelViewer(state);
    cancelNavigation(state);
    state.selectedBatchKeys.clear();
    updateSelectionControls(ctx, state, ui);
    state.listAbort?.abort();
    const controller = new AbortController();
    state.listAbort = controller;
    state.listState = 'loading';
    ui.refreshButton.disabled = false;
    ui.refreshButton.textContent = tr(ctx, 'Cancel');
    ui.scanButton.disabled = true;
    state.visibleLimit = LIST_PAGE_SIZE;
    const previousRows = state.rows;
    const previousFailures = state.inventoryFailures;
    const nextRows = [];
    const known = new Set();
    let invalidRows = 0;
    state.rows = nextRows;
    state.inventoryFailures = 0;
    state.selectedKey = null;
    state.selectedRow = null;
    state.selectedButton = null;
    resetViewer(ctx, ui);
    renderList(ctx, state, ui);
    setStatus(ui, tr(ctx, 'Loading chats...'));

    try {
        for await (const page of iterateArchiveInventoryPages(ctx, 'archive', controller.signal)) {
            if (state.listAbort !== controller || state.closed || controller.signal.aborted) {
                return;
            }
            for (const raw of page.rows) {
                const row = normalizeRow(raw, state.charactersByAvatar, state.groupsById, ctx.timestampToMoment);
                if (!row?.file_id) {
                    invalidRows++;
                    continue;
                }
                const key = physicalChatKey(row);
                if (!known.has(key)) {
                    known.add(key);
                    nextRows.push(row);
                }
            }
            state.inventoryFailures = page.errors + invalidRows;
            refreshOwnerOptions(ctx, state, ui);
            renderList(ctx, state, ui);
            updateSelectionControls(ctx, state, ui);
            setStatus(ui, `${tr(ctx, 'Loading chats...')} ${tr(ctx, '{matching} of {total} indexed chat files', {
                matching: page.loaded,
                total: page.total,
            })}`);
        }
        if (state.listAbort !== controller || state.closed) {
            return;
        }
        state.listState = 'ready';
        refreshOwnerOptions(ctx, state, ui);
        renderList(ctx, state, ui);
        updateBrowseStatus(ctx, state, ui);
        updateSelectionControls(ctx, state, ui);
        if (mentionSearchState(ui.search.value, ui.characterMentions).text) {
            void runDeepSearch(ctx, state, ui);
        }
    } catch (error) {
        if (error?.name === 'AbortError') {
            if (state.listAbort === controller && !state.closed) {
                state.listState = 'ready';
                refreshOwnerOptions(ctx, state, ui);
                renderList(ctx, state, ui);
                updateSelectionControls(ctx, state, ui);
                setStatus(ui, `${tr(ctx, 'Scan stopped.')} ${tr(ctx, '{total} indexed chat files', { total: state.rows.length })}`);
                if (mentionSearchState(ui.search.value, ui.characterMentions).text) {
                    void runDeepSearch(ctx, state, ui);
                }
            }
            return;
        }
        console.error('[Chat Archive] failed to list chats:', error);
        if (state.listAbort === controller) {
            state.rows = previousRows;
            state.inventoryFailures = previousFailures;
            state.listState = allRows(state).length > 0 ? 'ready' : 'error';
            refreshOwnerOptions(ctx, state, ui);
            renderList(ctx, state, ui);
            setStatus(ui, tr(ctx, state.listState === 'ready'
                ? 'Could not refresh chats. Showing the previous results.'
                : 'Could not load chats. Try again.'));
            if (state.listState === 'ready' && mentionSearchState(ui.search.value, ui.characterMentions).text) {
                void runDeepSearch(ctx, state, ui);
            }
        }
    } finally {
        if (state.listAbort === controller) {
            state.listAbort = null;
            ui.list.removeAttribute('aria-busy');
            ui.refreshButton.disabled = false;
            ui.refreshButton.textContent = tr(ctx, 'Refresh');
            ui.scanButton.disabled = false;
        }
    }
}

export async function scanOrphans(ctx, state, ui) {
    if (state.scanAbort || state.listAbort) {
        return;
    }
    exitDeepSearch(ctx, state, ui);
    cancelViewer(state);
    cancelNavigation(state);
    const controller = new AbortController();
    state.scanAbort = controller;
    ui.refreshButton.disabled = true;
    ui.scanButton.disabled = false;
    ui.scanButton.removeAttribute('aria-disabled');
    ui.scanButton.textContent = tr(ctx, 'Stop scan');
    setStatus(ui, tr(ctx, 'Scanning for missing-character and unlinked-group chats...'));

    const previousRows = state.orphanRows;
    const previousToken = state.archiveReadToken;
    const nextRows = [];
    const known = new Set();
    let invalidRows = 0;
    let inventoryErrors = 0;
    try {
        for await (const page of iterateArchiveInventoryPages(ctx, 'orphans', controller.signal)) {
            if (controller.signal.aborted || state.scanAbort !== controller || state.closed) {
                throw controller.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
            }
            state.orphanScanReadToken = page.readToken;
            inventoryErrors = page.errors;
            for (const raw of page.rows) {
                const row = normalizeRow(raw, state.charactersByAvatar, state.groupsById, ctx.timestampToMoment);
                if (!row?.file_id || !row.archiveHash || row.kind !== 'orphan') {
                    invalidRows++;
                    continue;
                }
                const key = physicalChatKey(row);
                if (!known.has(key)) {
                    known.add(key);
                    nextRows.push(row);
                }
            }
            state.orphanRows = nextRows;
            state.visibleLimit = LIST_PAGE_SIZE;
            refreshOwnerOptions(ctx, state, ui);
            renderList(ctx, state, ui);
            updateSelectionControls(ctx, state, ui);
            setStatus(ui, `${tr(ctx, 'Scanning for missing-character and unlinked-group chats...')} ${tr(ctx, '{matching} of {total} indexed chat files', {
                matching: page.loaded,
                total: page.total,
            })}`);
        }
        if (state.scanAbort !== controller || state.closed) {
            return;
        }
        state.archiveReadToken = state.orphanScanReadToken;
        state.orphanScanReadToken = null;
        state.orphanScanComplete = true;
        state.selectedKey = null;
        state.selectedRow = null;
        state.selectedButton = null;
        state.selectedBatchKeys.clear();
        state.visibleLimit = LIST_PAGE_SIZE;
        resetViewer(ctx, ui);
        refreshOwnerOptions(ctx, state, ui);
        renderList(ctx, state, ui);
        updateSelectionControls(ctx, state, ui);
        setStatus(ui, state.orphanRows.length > 0
            ? tr(ctx, 'Found {count} additional orphaned chat files.', { count: state.orphanRows.length })
            : tr(ctx, 'No additional orphaned chat files were found.'));
        if (inventoryErrors + invalidRows > 0) {
            setStatus(ui, `${ui.status.textContent} ${tr(ctx, 'Some orphan records could not be read.')}`);
        }
        void releaseArchiveToken(ctx, previousToken);
    } catch (error) {
        if (!state.closed && state.scanAbort === controller) {
            state.orphanRows = previousRows;
            state.orphanScanReadToken = null;
            refreshOwnerOptions(ctx, state, ui);
            renderList(ctx, state, ui);
            updateSelectionControls(ctx, state, ui);
            if (error?.name === 'AbortError') {
                setStatus(ui, tr(ctx, state.orphanScanComplete
                    ? 'Scan stopped. Previous results are still shown.'
                    : 'Scan stopped.'));
            } else {
                console.error('[Chat Archive] orphan scan failed:', error);
                setStatus(ui, tr(ctx, state.orphanScanComplete
                    ? 'Could not rescan orphaned files. Previous results are still shown.'
                    : 'Could not scan for additional orphaned files. Try again.'));
            }
        }
    } finally {
        if (state.scanAbort === controller) {
            state.scanAbort = null;
            if (!state.closed) {
                ui.refreshButton.disabled = false;
                ui.scanButton.disabled = false;
                ui.scanButton.removeAttribute('aria-disabled');
                ui.scanButton.textContent = tr(ctx, state.orphanScanComplete
                    ? 'Rescan orphaned files'
                    : 'Find orphaned files');
                if (mentionSearchState(ui.search.value, ui.characterMentions).text) {
                    void runDeepSearch(ctx, state, ui);
                }
            }
        }
    }
}

async function releaseArchiveToken(ctx, token, cursor = null) {
    if (!token && !cursor) {
        return;
    }
    try {
        await releaseArchiveSession(ctx, { token, cursor });
    } catch (error) {
        console.warn('[Chat Archive] orphan scan token already expired:', error);
    }
}

export async function releaseArchiveReadSession(ctx, state) {
    const token = state.archiveReadToken;
    const pendingToken = state.orphanScanReadToken;
    state.archiveReadToken = null;
    state.orphanScanReadToken = null;
    await Promise.all([...new Set([token, pendingToken].filter(Boolean))]
        .map(readToken => releaseArchiveToken(ctx, readToken)));
}
