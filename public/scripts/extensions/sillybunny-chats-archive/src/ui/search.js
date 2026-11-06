import { exitDeepSearch } from './cancellation.js';
import { LIST_PAGE_SIZE, SEARCH_CONTENT_DEBOUNCE_MS } from './constants.js';
import { runDeepSearch } from './deep-search.js';
import { button, el, tr } from './dom.js';
import { renderList, updateBrowseStatus } from './list.js';
import { fuzzyMentionChoices, mentionChoices, mentionSearchState } from './mentions.js';
import { nextRenderId } from './render-id.js';
import { noteViewEdit } from './saved-views.js';
import { updateSelectionControls } from './selection.js';

/**
 * The header search: a combobox that completes `@` mentions. The input is built here and adopted by the
 * dialog frame's search row, which supplies the field wrapper, Escape handling and the toggle button.
 */
export function createSearchField(ctx) {
    const input = document.createElement('input');
    input.id = `sbca_search_${nextRenderId()}`;
    input.type = 'search';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-label', tr(ctx, 'Search Indexed Chats'));
    input.placeholder = tr(ctx, 'Type to search chats. Mention character names with @.');
    input.autocomplete = 'off';
    input.enterKeyHint = 'search';
    const menu = el('div', 'sbca-mention-menu');
    menu.id = `sbca_mentions_${nextRenderId()}`;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', tr(ctx, 'Character Mentions'));
    menu.hidden = true;
    input.setAttribute('aria-controls', menu.id);
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-autocomplete', 'list');
    return { input, menu, mentions: mentionChoices(ctx) };
}

function closeMentionMenu(ui) {
    ui.mentionMenu.hidden = true;
    ui.mentionIndex = -1;
    ui.search.removeAttribute('aria-activedescendant');
    ui.search.setAttribute('aria-expanded', 'false');
}

function chooseMention(ui, choice) {
    const { active } = mentionSearchState(ui.search.value, ui.characterMentions);
    if (!active) {
        return;
    }
    const token = /[\s"\\]/.test(choice.name) ? `@${JSON.stringify(choice.name)}` : `@${choice.name}`;
    ui.search.value = `${ui.search.value.slice(0, active.start)}${token} `;
    closeMentionMenu(ui);
    ui.search.focus({ preventScroll: true });
    ui.search.dispatchEvent(new Event('input', { bubbles: true }));
}

function renderMentionMenu(ui) {
    const { active } = mentionSearchState(ui.search.value, ui.characterMentions);
    ui.mentionMenu.replaceChildren();
    if (!active) {
        closeMentionMenu(ui);
        return;
    }
    const matches = fuzzyMentionChoices(ui.characterMentions, active.fragment);
    for (const choice of matches) {
        const option = button('sbca-mention-option', choice.name);
        option.id = `sbca_mention_${nextRenderId()}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.tabIndex = -1;
        option.addEventListener('click', () => chooseMention(ui, choice));
        ui.mentionMenu.append(option);
    }
    ui.mentionIndex = -1;
    ui.search.removeAttribute('aria-activedescendant');
    ui.mentionMenu.hidden = matches.length === 0;
    ui.search.setAttribute('aria-expanded', String(matches.length > 0));
}

function moveMentionSelection(ui, direction) {
    const options = [...ui.mentionMenu.querySelectorAll('.sbca-mention-option')];
    if (options.length === 0) {
        return;
    }
    ui.mentionIndex = ui.mentionIndex < 0
        ? (direction > 0 ? 0 : options.length - 1)
        : (ui.mentionIndex + direction + options.length) % options.length;
    options.forEach((option, index) => option.setAttribute('aria-selected', String(index === ui.mentionIndex)));
    const active = options[ui.mentionIndex];
    ui.search.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
}

function applyQuery(ctx, state, ui) {
    exitDeepSearch(ctx, state, ui);
    state.visibleLimit = LIST_PAGE_SIZE;
    renderList(ctx, state, ui);
    updateBrowseStatus(ctx, state, ui);
    updateSelectionControls(ctx, state, ui);
}

function flushQuery(ctx, state, ui) {
    if (ui.queryTimer === null) {
        return;
    }
    clearTimeout(ui.queryTimer);
    ui.queryTimer = null;
    void runDeepSearch(ctx, state, ui);
}

export function handleQueryChange(ctx, state, ui) {
    renderMentionMenu(ui);
    noteViewEdit(ctx, state, ui);
    clearTimeout(ui.queryTimer);
    ui.queryTimer = null;
    applyQuery(ctx, state, ui);
    if (mentionSearchState(ui.search.value, ui.characterMentions).text && state.listState === 'ready' && !state.scanAbort) {
        ui.queryTimer = setTimeout(() => {
            ui.queryTimer = null;
            const query = mentionSearchState(ui.search.value, ui.characterMentions).text;
            if (!query || state.listState !== 'ready' || state.scanAbort || state.searchAbort
                || (state.deepRows !== null && state.deepQuery === query)) {
                return;
            }
            void runDeepSearch(ctx, state, ui);
        }, SEARCH_CONTENT_DEBOUNCE_MS);
    }
}

/** Escape closes an open mention menu first; the frame then clears or closes the search. */
export function closeMentionsOnEscape(ui) {
    if (ui.mentionMenu.hidden) {
        return false;
    }
    closeMentionMenu(ui);
    return true;
}

export function bindSearchField(ctx, state, ui) {
    const { search } = ui;
    const field = search.closest('.sb-dialog__search');
    search.parentElement.append(ui.mentionMenu);
    const onKeydown = event => {
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !ui.mentionMenu.hidden) {
            event.preventDefault();
            moveMentionSelection(ui, event.key === 'ArrowDown' ? 1 : -1);
            return;
        }
        if (event.key === 'Enter' && !ui.mentionMenu.hidden && ui.mentionIndex >= 0) {
            event.preventDefault();
            ui.mentionMenu.querySelectorAll('.sbca-mention-option')[ui.mentionIndex]?.click();
            return;
        }
        if (event.key !== 'Enter' || event.isComposing) {
            return;
        }
        event.preventDefault();
        flushQuery(ctx, state, ui);
    };
    const onFocusout = () => {
        setTimeout(() => {
            if (!field.contains(document.activeElement)) {
                closeMentionMenu(ui);
            }
        });
    };
    search.addEventListener('keydown', onKeydown);
    field.addEventListener('focusout', onFocusout);
    return () => {
        clearTimeout(ui.queryTimer);
        search.removeEventListener('keydown', onKeydown);
        field.removeEventListener('focusout', onFocusout);
    };
}
