import {
    buildSearchScopes,
    deepResultToRecentRow,
    filterRows,
    findMatchingSnippetInJsonlAsync,
    normalizeRow,
    physicalChatKey,
} from '../core.js';
import { searchScope } from '../api.js';
import { syncBusyControls } from './busy.js';
import { cancelSearch, clearViewerMatch } from './cancellation.js';
import { LIST_PAGE_SIZE } from './constants.js';
import { setStatus, tr } from './dom.js';
import { renderList } from './list.js';
import { mentionedRows, mentionSearchState } from './mentions.js';
import { allRows } from './rows.js';
import { loadRawChat } from './viewer.js';

export async function runDeepSearch(ctx, state, ui) {
    const search = mentionSearchState(ui.search.value, ui.characterMentions);
    const query = search.text;
    if (!query) {
        return;
    }

    cancelSearch(ctx, state, ui);
    const controller = new AbortController();
    state.searchAbort = controller;
    state.deepRows = null;
    state.deepQuery = query;
    clearViewerMatch(ui);
    const { signal } = controller;
    ui.status.setAttribute('aria-busy', 'true');
    syncBusyControls(ctx, state, ui);
    renderList(ctx, state, ui);

    const mentionedAvatars = new Set(search.mentions.filter(mention => !mention.missing).flatMap(mention => mention.avatars));
    const hasMentions = search.mentions.length > 0;
    const scopes = buildSearchScopes(ctx.characters, ctx.groups, state.model.owner)
        .filter(scope => !hasMentions || (scope.avatar_url && mentionedAvatars.has(scope.avatar_url)));
    const localFiles = filterRows(
        mentionedRows(allRows(state), search.mentions).filter(row => row.kind === 'orphan'),
        { owner: state.model.owner },
    );
    const total = scopes.length + localFiles.length;
    const found = new Map(filterRows(mentionedRows(allRows(state), search.mentions), { text: query }, state.organization)
        .map(row => [physicalChatKey(row), row]));
    let completed = 0;
    let errors = 0;

    try {
        for (const scope of scopes) {
            if (signal.aborted) {
                break;
            }
            setStatus(ui, tr(ctx, 'Searching source {current} of {total}...', { current: completed + 1, total }));
            try {
                const results = await searchScope(ctx, query, scope, signal);
                let malformed = false;
                for (const result of results) {
                    const recent = deepResultToRecentRow(result, scope);
                    const row = normalizeRow(recent, state.charactersByAvatar, state.groupsById, ctx.timestampToMoment);
                    if (!row?.file_id) {
                        malformed = true;
                        continue;
                    }
                    if (found.has(physicalChatKey(row))) {
                        continue;
                    }
                    found.set(physicalChatKey(row), { ...row, matchSnippet: true });
                }
                if (malformed) {
                    errors++;
                }
            } catch (error) {
                if (error?.name === 'AbortError') {
                    break;
                }
                errors++;
                console.warn('[Chat Archive] search scope failed:', error);
            }
            completed++;
        }

        for (const row of localFiles) {
            if (signal.aborted) {
                break;
            }
            if (found.has(physicalChatKey(row))) {
                completed++;
                continue;
            }
            setStatus(ui, tr(ctx, 'Searching source {current} of {total}...', { current: completed + 1, total }));
            try {
                const raw = await loadRawChat(ctx, state, row, signal);
                const { snippet, invalidLines } = await findMatchingSnippetInJsonlAsync(raw, query, { signal });
                if (invalidLines > 0) {
                    errors++;
                }
                if (snippet !== null) {
                    found.set(physicalChatKey(row), { ...row, snippet, matchSnippet: true });
                }
            } catch (error) {
                if (error?.name === 'AbortError') {
                    break;
                }
                errors++;
                console.warn('[Chat Archive] local file search failed:', error);
            }
            completed++;
        }

        if (state.searchAbort !== controller || state.closed) {
            return;
        }
        state.deepRows = [...found.values()];
        state.visibleLimit = LIST_PAGE_SIZE;
        renderList(ctx, state, ui);
        if (signal.aborted) {
            setStatus(ui, tr(ctx, 'Search stopped after {completed} of {total} sources. {count} matching chats shown.', {
                completed,
                total,
                count: found.size,
            }), { alert: true });
        } else if (errors > 0) {
            setStatus(ui, tr(ctx, '{count} matching chats. {errors} search items had errors.', { count: found.size, errors }), { alert: true });
        } else {
            setStatus(ui, tr(ctx, '{count} matching chats for "{query}".', { count: found.size, query }));
        }
    } finally {
        if (state.searchAbort === controller) {
            state.searchAbort = null;
            ui.status.removeAttribute('aria-busy');
            syncBusyControls(ctx, state, ui);
        }
    }
}
