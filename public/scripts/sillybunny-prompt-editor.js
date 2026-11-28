import { eventSource, event_types, getRequestHeaders, main_api } from '../script.js';
import { createPromptEditorModel, PROMPT_EDITOR_UTILITY_FIELDS as UTILITY_FIELDS } from './sillybunny-prompt-editor-model.js';
import { promptManager } from './openai.js';
import { openActionMenu, openPopover, closeActionMenu } from './sillybunny-action-menu.js';
import { play, MOTION_FAST } from './sillybunny-motion.js';
import { Popup } from './popup.js';
import { confirmDestructiveAction, confirmVerb } from './sillybunny-delete-confirm.js';
import { getTokenCountAsync, getTokenizerModel } from './tokenizers.js';
import { t, translate } from './i18n.js';
import { createSegmentedControl } from './sillybunny-segmented-control.js';
import { createListEditor, loadListEditorStyles } from './sillybunny-editor/list-shell.js';
import { mountEditorChrome, createDirtyMark, createTokenReadout, createSummaryRow, setSummaryText, nameByValue, attachToLabelRow, showDraftRecoveryToast, dismissDraftRecoveryToast } from './sillybunny-editor/chrome.js';
import { createEditorSession } from './sillybunny-editor/session.js';
import { createEditorDraftStore } from './sillybunny-editor/drafts.js';
import { getCurrentUserHandle } from './user.js';
import { openDialog } from './sillybunny-editor/dialog.js';
import { LAYOUT_MOBILE_QUERY } from './sillybunny-editor/breakpoints.js';
import { reconcileRows, rowEntry, bindListKeyboard, bindSortable } from './sillybunny-editor/list-rows.js';
import { createListSearch } from './sillybunny-editor/list-search.js';
import { createSearchEntry } from './sillybunny-editor/search-entry.js';
import { announceReorder, reorderMenuItems } from './sillybunny-editor/reorder-menu.js';
import { createEntityRow } from './sillybunny-editor/entity-row.js';
import { createListHeader } from './sillybunny-editor/list-header.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { createSelectionMode } from './sillybunny-editor/selection-mode.js';
import { createCheckRow, releaseRowIds } from './sillybunny-editor/rows.js';
import { accountStorage } from './util/AccountStorage.js';

const mountedEditors = new WeakSet();
let countingEditorContent = false;
let tokenizerPrefilterInstalled = false;
const TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];
const SELECTABLE_ROW = '.sb-prompt-row:not([data-prompt-bulk="false"])';
const SORT_STORAGE_KEY = 'PromptList_SortOrder';
const DEFAULT_SORT = 'order';
const SORT_ORDERS = [DEFAULT_SORT, 'name-asc', 'name-desc', 'tokens-asc', 'tokens-desc'];

/** The saved sort of the prompt list; a value that is not one of the sorts is the prompt order. */
function readSortOrder() {
    const saved = accountStorage.getItem(SORT_STORAGE_KEY);
    return SORT_ORDERS.includes(saved) ? saved : DEFAULT_SORT;
}

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

// Header Save/Cancel use the shared editor action style (sillybunny-character-editor.css), not .menu_button. The shared
// chrome binds their clicks and names their tooltips.
function actionButton(label, className, glyph = null) {
    const node = element('button', `sb-editor-action ${className}`);
    node.type = 'button';
    if (glyph) {
        node.setAttribute('aria-label', label);
        node.append(icon(glyph), element('span', 'sb-editor-action__label', label));
        node.firstChild.classList.add('sb-editor-action__icon');
    } else node.textContent = label;
    return node;
}

// Back, the item menu and the Edit/Preview toggle share the header icon button shape of every editor.
function headerIconButton(label, glyph, className = '') {
    const node = element('button', `sb-editor-icon-button sb-header-icon-button ${className}`.trim());
    node.type = 'button';
    node.setAttribute('aria-label', label);
    node.title = label;
    node.append(icon(glyph));
    return node;
}

function icon(name) {
    const node = element('i', `fa-solid fa-${name}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

/**
 * Storage key of an unsaved prompt editor draft. The entity is `<kind>:<identifier>`; a new prompt has no identifier
 * that survives a reload, so every new prompt shares `<kind>:new`.
 * @param {string} entity
 */
export function promptDraftKey(entity) {
    return `sb-prompt-editor-draft-${getCurrentUserHandle() || 'default'}-${encodeURIComponent(entity)}`;
}

function isStoredPromptDraft(kind, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (typeof value.identifier !== 'string' || typeof value.name !== 'string') return false;
    if (kind === 'text-completion') {
        return [value.values, value.propertyValues].every(group => group && typeof group === 'object' && !Array.isArray(group));
    }
    return value.content === undefined || typeof value.content === 'string';
}

function button(label, glyph, action, className = '') {
    const node = element('button', `menu_button ${glyph ? 'menu_button_icon' : ''} ${className}`);
    node.type = 'button';
    node.setAttribute('aria-label', label);
    if (glyph) {
        node.title = label;
        node.append(icon(glyph));
    } else node.textContent = label;
    node.addEventListener('click', event => {
        event.stopPropagation();
        void action(node, event);
    });
    return node;
}

// A row button is the shared entity-row icon button; it takes its states from sillybunny-entity-list.css.
function rowButton(label, glyph, action, className = '') {
    const node = element('button', `ds-entity-row__button ${className}`.trim());
    node.type = 'button';
    node.setAttribute('aria-label', label);
    node.title = label;
    node.append(icon(glyph));
    node.addEventListener('click', event => {
        event.stopPropagation();
        void action(node, event);
    });
    return node;
}

function switchControl(label, checked, action, disabled = false) {
    const node = element('input', 'sb-switch');
    node.type = 'checkbox';
    node.checked = Boolean(checked);
    node.disabled = disabled;
    node.setAttribute('role', 'switch');
    node.setAttribute('aria-label', label);
    node.addEventListener('change', () => {
        void action(node.checked);
    });
    return node;
}

function capitalized(value) {
    return value ? value[0].toUpperCase() + value.slice(1) : '';
}

/**
 * @param {HTMLElement} column
 * @param {{ openPresets?: () => void }} [options] `openPresets` adds the header's way back to the Presets page.
 */
export function initializePromptEditor(column, { openPresets = null } = {}) {
    if (mountedEditors.has(column)) return;
    mountedEditors.add(column);
    let model = null;
    // sillybunny-preset-autosave.js shows and hides both badges, and sillybunny-tabs.js fills the preset names and the backend.
    const badge = (hook, key, text) => {
        const node = element('span', 'sb-prompt-header-badge', text);
        node.setAttribute(hook, '');
        node.dataset.i18n = key;
        node.hidden = true;
        return node;
    };
    const autosaveBadge = badge('data-sb-editor-autosave', 'Autosave off', t`Autosave off`);
    const readOnlyBadge = badge('data-sb-editor-read-only', 'Read-only', t`Read-only`);
    const listHeader = createListHeader({
        title: t`Prompts`,
        className: 'sb-prompt-list-header',
        titleBadges: [readOnlyBadge, autosaveBadge],
        actions: [
            ...openPresets ? [{ id: 'presets', label: t`Presets`, icon: 'sliders', onActivate: () => openPresets() }] : [],
            { id: 'search', label: t`Search Prompts`, icon: 'magnifying-glass', toggle: true, onActivate: () => searchControl.toggle() },
            { id: 'add', label: t`Add Prompt`, icon: 'plus', menu: true, onActivate: trigger => openAddMenu(trigger) },
            { id: 'more', label: t`Prompt List Actions`, icon: 'ellipsis-vertical', menu: true, onActivate: trigger => openListMenu(trigger) },
        ],
    });
    const presetsButton = listHeader.button('presets');
    if (presetsButton) presetsButton.dataset.sbEditorPresets = '';
    // The line under the title reads "presets · backend · counts". The page's code fills the first two parts; the full line is the tooltip.
    const subtitleLine = listHeader.element.querySelector('.sb-list-header__subtitle');
    const presetNames = element('span', 'sb-prompt-context sb-prompt-context--presets');
    presetNames.dataset.sbEditorPreset = '';
    presetNames.setAttribute('aria-live', 'polite');
    const backendName = element('span', 'sb-prompt-context sb-prompt-context--backend');
    backendName.dataset.sbEditorMode = '';
    const countsLine = element('span', 'sb-prompt-context sb-prompt-context--counts');
    // On a narrow bar the state badges leave the title line and lead the subtitle as text (fitHeader).
    const statesLine = element('span', 'sb-prompt-context sb-prompt-context--states');
    subtitleLine.append(statesLine, presetNames, backendName, countsLine);
    // The tooltip reads in Title Case like every other tooltip, so the counts take capitals; names stay as written.
    const SMALL_WORDS = new Set(['a', 'an', 'and', 'by', 'for', 'in', 'of', 'on', 'the', 'to']);
    const titleCased = text => text.replace(/(^|\s)(\p{Ll}\p{L}*)/gu, (match, space, word) => SMALL_WORDS.has(word) && space ? match : space + word[0].toUpperCase() + word.slice(1));
    const syncSubtitleTooltip = () => {
        const parts = [statesLine, presetNames, backendName, countsLine].filter(part => !part.hidden).map(part => part.textContent.trim());
        for (const index of [0, parts.length - 1]) if (parts[index]) parts[index] = titleCased(parts[index]);
        const full = parts.filter(Boolean).join(' · ');
        if (subtitleLine.title !== full) subtitleLine.title = full;
    };
    new MutationObserver(syncSubtitleTooltip).observe(subtitleLine, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    // A search replaces the line with its result count, so the context parts step aside while it is on.
    const setSubtitleLine = (text, searching = false) => {
        if (countsLine.textContent !== text) countsLine.textContent = text;
        for (const part of [statesLine, presetNames, backendName]) if (part.hidden !== searching) part.hidden = searching;
    };
    const searchButton = listHeader.button('search');
    const addPromptButton = listHeader.button('add');
    const listActionsButton = listHeader.button('more');

    // A bar that cannot hold the title, its state badges and every button keeps the list's name whole: the badges lead the subtitle as
    // text first, and the Presets button moves into the list's menu (a Text Completion list has no menu, so its button stays). The need is
    // measured from the natural widths of the title, the badges and an icon button, none of which depends on this state, so the choice does not flip back.
    const headerTitle = listHeader.element.querySelector('.sb-list-header__title');
    const stateBadges = [readOnlyBadge, autosaveBadge];
    let fitFrame = 0;
    const presetsInMenu = () => Boolean(presetsButton?.hidden);
    function fitHeader() {
        const bar = listHeader.element;
        const unit = searchButton.offsetWidth;
        if (!bar.clientWidth || !unit) return;
        const px = (node, ...sides) => sides.reduce((sum, side) => sum + (parseFloat(getComputedStyle(node)[side]) || 0), 0);
        const gap = px(bar, 'columnGap');
        const buttons = [addPromptButton, listActionsButton].filter(control => !control.hidden).length + 1 + Number(Boolean(presetsButton));
        const shown = stateBadges.filter(badgeNode => !badgeNode.hidden);
        const required = px(bar, 'paddingLeft', 'paddingRight') + px(headerTitle.parentElement.parentElement, 'paddingLeft', 'paddingRight')
            + headerTitle.scrollWidth + shown.reduce((sum, badgeNode) => sum + badgeNode.offsetWidth + gap, 0)
            + buttons * unit + (buttons + 1) * gap;
        const narrow = required > bar.clientWidth;
        if (bar.dataset.narrow !== String(narrow)) bar.dataset.narrow = String(narrow);
        const states = narrow ? shown.map(badgeNode => badgeNode.textContent.trim()).join(' · ') : '';
        if (statesLine.textContent !== states) statesLine.textContent = states;
        const moved = narrow && Boolean(presetsButton) && !listActionsButton.hidden;
        if (presetsButton && presetsButton.hidden !== moved) presetsButton.hidden = moved;
    }
    function scheduleFit() {
        if (fitFrame) return;
        fitFrame = requestAnimationFrame(() => {
            fitFrame = 0;
            fitHeader();
        });
    }
    if (typeof ResizeObserver === 'function') new ResizeObserver(scheduleFit).observe(listHeader.element);
    new MutationObserver(scheduleFit).observe(headerTitle.parentElement, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    const searchEntry = createSearchEntry({
        clearLabel: t`Clear Entry`,
        variant: 'bar', className: 'sb-prompt-search-entry', inputClassName: 'sb-prompt-search',
        placeholder: t`Search…`, label: t`Search Prompts`, clearOnEscape: false,
    });
    // The sort button ends the search bar, as in the other list editors, so the header keeps its three buttons.
    const sortLabel = t`Sort`;
    const sortButton = element('button', 'sb-list-header__button sb-header-icon-button sb-prompt-sort-button');
    sortButton.type = 'button';
    sortButton.dataset.actionId = 'sort';
    sortButton.title = sortLabel;
    sortButton.setAttribute('aria-label', sortLabel);
    sortButton.setAttribute('aria-haspopup', 'menu');
    sortButton.setAttribute('aria-expanded', 'false');
    sortButton.setAttribute('aria-pressed', 'false');
    sortButton.append(icon('arrow-down-wide-short'));
    sortButton.addEventListener('click', () => openSortMenu(sortButton));
    const searchField = element('div', 'sb-prompt-search-field sb-list-search-bar');
    searchField.append(searchEntry.element, sortButton);
    const search = searchEntry.input;
    searchField.hidden = true;
    const listBody = element('div', 'sb-prompt-list-body');

    let state = null;
    let draft = null;
    let draftScope = '';
    // A new prompt counts as unsaved from the moment it opens, so Save is available before the first edit.
    let unsaved = false;
    let chrome = null;
    // The last counted total of the open draft; the header and phone readouts are rebuilt with every render.
    let tokenCount = null;
    let kind = 'prompt';
    let mode = 'edit';
    let filter = '';
    let synchronizeFrame = 0;
    let renderedListKey = '';
    let dragScope = '';
    let propertyDialog = null;
    let tokenTimer = null;
    let listTokenTimer = null;
    let tokenRequest = 0;
    let placingCounts = false;
    let activeToast = null;
    let replayingChange = false;
    let stylesReady = false;
    let syncPending = false;
    let tokensPending = false;
    let visibilityObserver = null;
    let observedAncestors = [];
    let tokenizerKey = '';
    const contentCounts = new Map();
    const contentRequests = new Map();
    const listGroups = new Map();
    const rowRefs = new WeakMap();
    const mobile = matchMedia(LAYOUT_MOBILE_QUERY);

    const isPanelVisible = () => Boolean(column.isConnected && !column.closest('[hidden], [aria-hidden="true"], [inert], .closedDrawer'));
    const dirty = () => Boolean(draft) && (unsaved || session.isDirty());
    const textCompletionView = () => state?.type === 'text-completions';
    const promptFor = id => state.prompts.find(prompt => prompt.identifier === id);
    const rowFor = id => {
        if (id == null) return null;
        const key = String(id);
        for (const group of listGroups.values()) {
            const cached = group.rows.get(key);
            if (cached && cached.row.isConnected) return cached.row;
        }
        return listBody.querySelector(`[data-prompt-id="${CSS.escape(id)}"]`);
    };
    const selectedId = () => draft?.identifier;

    // The session owns the saved baseline, the dirty comparison and the backup of an unsaved draft.
    // A backup is written every five seconds while the draft differs from the saved prompt and on pagehide. It is
    // dropped by Save, Cancel, Discard and by closing a draft that has nothing left to keep.
    const entityKey = () => `${kind}:${unsaved ? 'new' : draft.identifier}`;
    const draftOwner = () => `prompt:${session.context?.entityId}`;
    const baselineFingerprint = () => unsaved ? '' : JSON.stringify(session.readBaseline());
    const draftStore = createEditorDraftStore({ keyFor: promptDraftKey });
    // The shared envelope stays as it is; the payload carries the preset scope and a fingerprint of the saved prompt,
    // so a backup is only offered over the prompt it was made from.
    const drafts = {
        read(entity) {
            const stored = draftStore.read(entity);
            if (!stored) return null;
            const payload = stored.snapshot;
            const sameEntity = unsaved || payload.draft?.identifier === draft?.identifier;
            if (payload.scope !== draftScope || payload.fingerprint !== baselineFingerprint() || !sameEntity || !isStoredPromptDraft(kind, payload.draft)) {
                draftStore.remove(entity);
                return null;
            }
            return { ...stored, snapshot: payload.draft };
        },
        write(entity, snapshot) {
            draftStore.write(entity, { scope: draftScope, fingerprint: baselineFingerprint(), draft: snapshot });
        },
        remove: entity => draftStore.remove(entity),
    };
    const session = createEditorSession({
        captureSnapshot: () => draft ? structuredClone(draft) : {},
        restoreSnapshot,
        drafts,
        onStateChange: () => renderState(),
        offerDraft: (stored, actions) => showDraftRecoveryToast(stored, actions, draftOwner()),
    });

    // Assigned below; renderList returns early until synchronize() has produced state.
    let shell = null;
    shell = createListEditor({
        container: column,
        storageKey: 'sb-pm-list-width',
        rootTag: 'section',
        label: t`Prompts`,
        dividerLabel: t`Resize prompt sidebar`,
        classNames: { root: 'sb-prompt-editor', sidebar: 'sb-prompt-list', divider: 'sb-prompt-divider', detail: 'sb-prompt-detail' },
        dragHandleSelector: '.sb-prompt-grip[aria-disabled="false"]',
        // The editor's own keydown closes on Escape from any field and handles Ctrl/Cmd+S.
        escapeCloses: false,
        renderList: () => renderList(),
        renderDetail: () => renderEditor(),
        isDirty: dirty,
        onSave: save,
        onDiscard: discardDraft,
        onDeselect: () => {
            closeOverlays();
            endSession();
            draft = null;
        },
        findRow: rowFor,
        focusTarget: detail => detail.querySelector('.sb-prompt-title'),
        fadeTarget: detail => detail.querySelector('.sb-prompt-content'),
        applyLayout: applyShellLayout,
        onCollapseChange: () => closeOverlays(),
    });
    const root = shell.root;
    const list = shell.sidebar;
    const editor = shell.detail;
    const status = shell.status;
    const allowLeave = () => shell.allowLeave();
    const selectionHeader = element('div', 'sb-prompt-selection-header');
    const selectionActions = element('div', 'sb-prompt-selection-actions');
    list.append(listHeader.element, selectionHeader, searchField, listBody, selectionActions);
    root.hidden = true;

    if (!tokenizerPrefilterInstalled) {
        // Extensions can replace jQuery without the app's CSRF prefilter; scope this repair to our reads.
        $.ajaxPrefilter((options, _original, xhr) => {
            if (countingEditorContent && options.url.startsWith('/api/tokenizers/')) xhr.setRequestHeader('X-CSRF-Token', getRequestHeaders()['X-CSRF-Token']);
        });
        tokenizerPrefilterInstalled = true;
    }

    function countContent(content) {
        if (contentCounts.has(content)) return Promise.resolve(contentCounts.get(content));
        if (contentRequests.has(content)) return contentRequests.get(content);
        const expectedTokenizer = tokenizerKey;
        let request;
        countingEditorContent = true;
        try { request = getTokenCountAsync(content, 0); } finally { countingEditorContent = false; }
        const pending = request.then(count => {
            if (tokenizerKey === expectedTokenizer) {
                contentCounts.set(content, count);
                if (contentCounts.size > 128) contentCounts.delete(contentCounts.keys().next().value);
            }
            return count;
        }).finally(() => {
            if (contentRequests.get(content) === pending) contentRequests.delete(content);
        });
        contentRequests.set(content, pending);
        return pending;
    }

    function knownCount(prompt) {
        return state.counts[prompt.identifier] ?? contentCounts.get(prompt.content) ?? '-';
    }

    // Returns the entries in the displayed order of a sort. A row with no count yet, a marker included, stays after the
    // counted ones in either direction, and equal rows keep the stored order.
    function sortEntries(entries, sortOrder) {
        if (sortOrder === DEFAULT_SORT) return entries;
        const [field, direction] = sortOrder.split('-');
        const sign = direction === 'desc' ? -1 : 1;
        if (field === 'name') {
            const nameOf = ({ prompt }) => translate(prompt.name);
            return [...entries].sort((left, right) => sign * nameOf(left).localeCompare(nameOf(right), undefined, { numeric: true, sensitivity: 'base' }));
        }
        const countOf = ({ prompt }) => {
            const count = knownCount(prompt);
            return typeof count === 'number' && Number.isFinite(count) ? count : null;
        };
        return [...entries].sort((left, right) => {
            const [a, b] = [countOf(left), countOf(right)];
            if (a === null || b === null) return (a === null) - (b === null);
            return sign * (a - b);
        });
    }

    function textCompletionContent(entry) {
        return Object.entries(entry.values)
            .filter(([id, value]) => id !== 'instruct_system_same_as_user' && typeof value === 'string' && value)
            .map(([, value]) => value)
            .join('\n');
    }

    function knownTextCompletionCount(entry) {
        const content = textCompletionContent(entry);
        return content ? contentCounts.get(content) ?? '-' : '-';
    }

    function run(action) {
        try {
            const result = action();
            if (result?.catch) result.catch(error => toastr.error(error.message));
            return result;
        } catch (error) {
            toastr.error(error.message);
            return false;
        }
    }

    function menu(trigger, title, sections) {
        openActionMenu({ trigger, title, sections: sections.filter(items => items.length).map(items => ({ items: items.filter(Boolean) })) });
        markPromptMenus();
    }

    function menuItem(label, glyph, action, danger = false) {
        return { label, icon: `fa-solid fa-${glyph}`, onSelect: () => run(action), danger };
    }

    function toast(message, undo) {
        if (activeToast) toastr.clear(activeToast, { force: true });
        const body = element('div', '', message);
        if (undo) {
            body.append(button(t`Undo`, null, () => {
                run(undo);
                toastr.clear(activeToast, { force: true });
                synchronize();
            }));
        }
        const shown = toastr.info(body, '', {
            timeOut: 5000,
            escapeHtml: false,
            onHidden: () => {
                if (activeToast === shown) activeToast = null;
            },
        });
        activeToast = shown;
    }

    function orderedIds() {
        return state.order.filter(entry => promptFor(entry.identifier)).map(entry => entry.identifier);
    }

    // Keyboard and drag moves announce and refocus here; the menu's moves do it through reorderMenuItems.
    function movedByKeyboardOrDrag(id) {
        const ids = orderedIds();
        announceReorder({ name: promptFor(id)?.name ?? '', position: ids.indexOf(id) + 1, count: ids.length, region: status });
        rowFor(id)?.focus({ preventScroll: true });
    }

    // The list order is the order the prompts are sent in, so only the prompt order can be changed from the list: a search
    // hides rows, and any other sort shows them in an order that is not the stored one.
    const reorderLocked = () => Boolean(filter) || readSortOrder() !== DEFAULT_SORT;

    function move(id, position) {
        if (reorderLocked()) return false;
        const ids = orderedIds();
        const previous = ids.indexOf(id);
        if (previous < 0) return false;
        ids.splice(previous, 1);
        ids.splice(Math.max(0, Math.min(ids.length, position)), 0, id);
        const saved = run(() => model.reorder(ids, state.scope)) !== false;
        state = model.snapshot();
        renderList();
        return saved;
    }

    function moveItems(id) {
        const ids = orderedIds();
        return reorderMenuItems({
            index: ids.indexOf(id),
            count: ids.length,
            filtered: reorderLocked(),
            extremes: true,
            name: promptFor(id)?.name ?? '',
            move: to => move(id, to),
            focus: () => rowFor(id),
            region: status,
        });
    }

    async function remove(id) {
        if (draft && !(await allowLeave())) return;
        const expectedScope = state.scope;
        const name = promptFor(id)?.name;
        const row = rowFor(id);
        if (row) await new Promise(resolve => play(row, [{ opacity: 1 }, { opacity: 0, transform: 'translateX(12px)' }], { duration: MOTION_FAST, onEnd: resolve }));
        const removed = run(() => model.remove(id, expectedScope));
        if (!removed) return;
        if (draft?.identifier === id) closeNow();
        synchronize();
        toast(t`Removed ${name}`, () => model.undoRemove(removed));
    }

    async function deletePrompt(id) {
        if (draft && !(await allowLeave())) return;
        const expectedScope = state.scope;
        if (!await Popup.show.confirm(t`Are you sure you want to delete this prompt?`, null, {
            ...confirmVerb(t`Delete`, { destructive: true }),
        })) return;
        const result = run(() => model.delete(id, expectedScope));
        if (result === false) return;
        if (draft?.identifier === id) closeNow();
        synchronize();
    }

    async function rename(prompt) {
        if (draft && !(await allowLeave())) return;
        const row = rowFor(prompt.identifier);
        const name = (row && rowRefs.get(row)?.name) ?? row?.querySelector('.sb-prompt-row-name');
        if (!name || !model.permissions(prompt).rename) return;
        const expectedScope = state.scope;
        const input = element('input', 'sb-prompt-rename');
        input.value = prompt.name;
        input.setAttribute('aria-label', t`Prompt Name`);
        name.replaceWith(input);
        input.focus();
        input.select();
        let finished = false;
        const finish = save => {
            if (finished) return;
            finished = true;
            input.replaceWith(name);
            if (save) run(() => model.rename(prompt.identifier, input.value, expectedScope));
            if (draft?.identifier === prompt.identifier && save) {
                draft.name = input.value;
                session.rebase();
                renderEditor();
            }
            synchronize();
            rowFor(prompt.identifier)?.focus({ preventScroll: true });
        };
        input.addEventListener('keydown', event => {
            event.stopPropagation();
            if (!['Enter', 'Escape'].includes(event.key)) return;
            event.preventDefault();
            finish(event.key === 'Enter');
        });
        input.addEventListener('blur', () => finish(true));
    }

    function promptMenu(trigger, prompt, available) {
        const id = prompt.identifier;
        const permission = model.permissions(prompt);
        menu(trigger, prompt.name, [
            [permission.edit && menuItem(t`Edit`, 'pen', () => openPrompt(prompt)), permission.rename && menuItem(t`Rename`, 'i-cursor', () => rename(prompt)), menuItem(t`Preview`, 'eye', () => openPrompt(prompt, 'preview'))],
            available ? [] : moveItems(id),
            [!prompt.marker && menuItem(t`Send to Agents`, 'robot', () => model.sendToAgents(id))],
            [!available && permission.remove && menuItem(t`Remove From List`, 'minus', () => remove(id), true), permission.delete && menuItem(t`Delete`, 'trash', () => deletePrompt(id), true)],
        ]);
    }

    function describe(prompt) {
        if (prompt.marker) return `${t`Marker`} · ${state.sources[prompt.identifier] ?? t`Generation time`}`;
        const position = Number(prompt.injection_position) === 1 ? `${t`In-chat`} @ ${prompt.injection_depth ?? 4}` : t`Relative`;
        return `${capitalized(prompt.role ?? 'system')} · ${position}${prompt.injection_trigger?.length ? ` · ${prompt.injection_trigger.map(capitalized).join(', ')}` : ''}`;
    }

    // A template has no switch, so a template that is not in use (its instruct or system prompt mode is off) says so in words,
    // as a marker names its source.
    function templateSubtitle(prompt, preview, textCompletion) {
        const text = preview.replace(/\s+/g, ' ').slice(0, 100) || '—';
        return textCompletion && prompt.disabled ? `${t`Disabled`} · ${text}` : text;
    }

    function makeRow(prompt, orderEntry = null, available = false, utility = false) {
        const textCompletion = textCompletionView();
        const id = textCompletion ? prompt.id : prompt.identifier;
        const nameText = translate(prompt.name);
        const preview = textCompletion
            ? Object.values(prompt.values).find(value => typeof value === 'string' && value.trim()) ?? ''
            : utility ? model.readUtility(id) : describe(prompt);
        const glyph = icon(textCompletion ? 'align-left' : utility ? 'file-lines' : prompt.runtime ? 'robot' : prompt.marker ? 'thumbtack' : Number(prompt.injection_position) === 1 ? 'syringe' : prompt.role === 'system' ? 'gear' : 'comment');
        const badges = [];
        let token = null;
        if (textCompletion) {
            token = element('span', 'sb-prompt-token', String(knownTextCompletionCount(prompt)));
            badges.push(token);
        } else if (!utility) {
            token = element('span', 'sb-prompt-token', String(knownCount(prompt)));
            badges.push(token);
        }
        const suffix = [];
        let control = null;
        if (orderEntry) {
            control = switchControl(t`Enable ${prompt.name}`, orderEntry.enabled, () => {
                run(() => model.toggle(id, state.scope));
                synchronize();
            }, !model.permissions(prompt).toggle);
            const target = element('label', 'sb-prompt-switch-target');
            target.addEventListener('click', event => event.stopPropagation());
            target.append(control);
            suffix.push(target);
        }
        if (available) suffix.push(rowButton(t`Add ${prompt.name}`, 'plus', () => {
            run(() => model.insert(id, state.scope));
            synchronize();
        }));
        if (!prompt.runtime) {
            const more = rowButton(t`Actions for ${nameText}`, 'ellipsis-vertical', trigger => textCompletion
                ? menu(trigger, nameText, [[menuItem(t`Edit`, 'pen', () => openTextCompletion(prompt)), menuItem(t`Preview`, 'eye', () => openTextCompletion(prompt, 'preview'))]])
                : utility
                    ? menu(trigger, nameText, [[menuItem(t`Edit`, 'pen', () => openUtility(prompt)), model.canRestoreUtility(id) && menuItem(t`Restore Default`, 'rotate-left', () => restoreUtility(id))]])
                    : promptMenu(trigger, prompt, available), 'sb-prompt-row-menu');
            more.setAttribute('aria-haspopup', 'menu');
            more.setAttribute('aria-expanded', 'false');
            suffix.push(more);
        } else {
            // The assembled Agents row has no switch or menu; spacers keep its count in the column of the other rows.
            for (const className of ['sb-prompt-switch-slot', 'sb-prompt-row-menu sb-prompt-menu-slot']) {
                const slot = element('span', className);
                slot.setAttribute('aria-hidden', 'true');
                suffix.push(slot);
            }
        }
        const rowClasses = ['sb-prompt-row'];
        if (textCompletion) rowClasses.push('sb-prompt-row--template');
        if (orderEntry) rowClasses.push('sb-prompt-row--ordered');
        const entity = createEntityRow({
            key: String(id),
            label: nameText,
            avatar: glyph,
            grip: Boolean(orderEntry || prompt.runtime),
            subtitle: textCompletion || utility ? templateSubtitle(prompt, preview, textCompletion) : preview,
            badges,
            suffix,
            activation: 'activate',
            compatClasses: { row: rowClasses, title: ['sb-prompt-row-name'], subtitle: ['sb-prompt-row-subtitle'], text: ['sb-prompt-row-text'] },
            attributes: { 'data-prompt-id': String(id), 'data-prompt-bulk': utility || prompt.runtime || textCompletion ? 'false' : null },
        });
        const row = entity.row;
        row.classList.toggle('is-selected', selectedId() === id);
        const grip = entity.slots.grip;
        if (orderEntry) {
            // The grip is a handle for the pointer only, as in libadwaita. The row takes focus and carries the Alt+arrow moves,
            // so a grip with a button role and no tab stop would only be a control that assistive technology cannot reach.
            grip.classList.add('sb-prompt-grip', 'ui-sortable-handle');
            grip.setAttribute('aria-disabled', String(reorderLocked()));
            grip.title = t`Drag to Reorder ${nameText}`;
        } else if (grip) {
            grip.classList.add('sb-prompt-handle-slot');
            grip.replaceChildren();
        }
        if (!utility && !textCompletion && !prompt.marker) entity.slots.title.addEventListener('dblclick', event => {
            event.stopPropagation();
            void rename(prompt);
        });
        rowRefs.set(row, { grip: orderEntry ? grip : null, control, token, name: entity.slots.title });
        return row;
    }

    function group(title, className = '') {
        if (listGroups.has(className)) return listGroups.get(className);
        const section = element('section', `sb-prompt-section ${className}`);
        const heading = element('h3', '', title);
        heading.tabIndex = -1;
        const box = element('div', 'sb-prompt-box ds-entity-list');
        box.setAttribute('role', 'list');
        section.append(heading, box);
        listBody.append(section);
        const result = { section, heading, box, rows: new Map(), count: 0 };
        listGroups.set(className, result);
        return result;
    }

    // A group with no rows shows neither its heading nor its box, so a search never leaves a heading over nothing.
    function syncSectionVisibility(textCompletion) {
        for (const [className, group] of listGroups) {
            const otherBackend = textCompletion ? !className.startsWith('sb-prompt-tc-') : className.startsWith('sb-prompt-tc-');
            const hidden = otherBackend || group.count === 0;
            if (group.section.hidden !== hidden) group.section.hidden = hidden;
        }
    }

    function renderRows(group, entries) {
        const textCompletion = textCompletionView();
        group.count = entries.length;
        reconcileRows({
            container: group.box,
            cache: group.rows,
            entries,
            key: ({ prompt }) => textCompletion ? prompt.id : prompt.identifier,
            signature: ({ prompt, utility = false }) => {
                const id = textCompletion ? prompt.id : prompt.identifier;
                return JSON.stringify([prompt, utility ? model.readUtility(id) : textCompletion ? prompt : [model.permissions(prompt), describe(prompt)]]);
            },
            create: ({ prompt, orderEntry = null, available = false, utility = false }) => makeRow(prompt, orderEntry, available, utility),
            update: (row, { prompt, orderEntry = null }) => {
                const id = textCompletion ? prompt.id : prompt.identifier;
                const selected = selectedId() === id;
                const disabled = textCompletion ? Boolean(prompt.disabled) : orderEntry?.enabled === false;
                if (row.classList.contains('is-selected') !== selected) row.classList.toggle('is-selected', selected);
                if (row.classList.contains('is-disabled') !== disabled) row.classList.toggle('is-disabled', disabled);
                const refs = rowRefs.get(row);
                const grip = refs ? refs.grip : row.querySelector('.sb-prompt-grip');
                const locked = String(reorderLocked());
                if (grip && grip.getAttribute('aria-disabled') !== locked) grip.setAttribute('aria-disabled', locked);
                const control = refs ? refs.control : row.querySelector('input.sb-switch');
                if (control && control.checked !== Boolean(orderEntry.enabled)) control.checked = Boolean(orderEntry.enabled);
                const token = refs ? refs.token : row.querySelector('.sb-prompt-token');
                const count = String(textCompletion ? knownTextCompletionCount(prompt) : knownCount(prompt));
                if (token && token.textContent !== count) token.textContent = count;
            },
        });
    }

    function openEntry({ prompt, utility = false }) {
        if (textCompletionView()) return openTextCompletion(prompt);
        if (utility) return openUtility(prompt);
        return openPrompt(prompt, prompt.runtime ? 'inspect' : null);
    }

    bindListKeyboard(listBody, {
        rowSelector: '.sb-prompt-row',
        keySourceSelector: '.sb-prompt-grip',
        onOpen: row => {
            const entry = rowEntry(row);
            if (entry) void openEntry(entry);
        },
        onRename: row => {
            const entry = rowEntry(row);
            if (!entry || entry.utility || textCompletionView() || entry.prompt.runtime) return false;
            void rename(entry.prompt);
        },
        onMove: (row, direction) => {
            const entry = rowEntry(row);
            if (!entry?.orderEntry) return false;
            const id = entry.prompt.identifier;
            const ids = orderedIds();
            const index = ids.indexOf(id);
            const to = Math.max(0, Math.min(ids.length - 1, index + direction));
            if (index >= 0 && to !== index && move(id, to)) movedByKeyboardOrDrag(id);
        },
    });

    function renderList() {
        if (!state || !shell) return false;
        if (shell.isNavigating || shell.pointerActive || listBody.querySelector('.ui-sortable-helper, .ui-sortable-placeholder')) {
            shell.deferRefresh();
            return;
        }
        const textCompletion = textCompletionView();
        // The templates are a fixed set of nine in three groups by role, two to four in each; the user neither adds nor moves
        // them, so they have no sort.
        for (const control of [addPromptButton, listActionsButton, sortButton]) {
            if (control.hidden !== textCompletion) control.hidden = textCompletion;
        }
        const sortOrder = readSortOrder();
        const sorted = !textCompletion && sortOrder !== DEFAULT_SORT;
        for (const control of [sortButton, searchButton]) {
            if (control.getAttribute('aria-pressed') !== String(sorted)) control.setAttribute('aria-pressed', String(sorted));
        }
        listHeader.setTitle(textCompletion ? t`Prompt templates` : t`Prompts`);
        scheduleFit();
        syncSectionVisibility(textCompletion);
        if (textCompletion) {
            clearTimeout(listTokenTimer);
            const nextKey = JSON.stringify([state.scope, state.textCompletionEntries, filter, selectedId(), kind]);
            if (nextKey === renderedListKey) return false;
            renderedListKey = nextKey;
            const matches = entry => translate(entry.name).toLowerCase().includes(filter.toLowerCase());
            let shown = 0;
            for (const [section, className] of [
                ['System prompt', 'sb-prompt-tc-system'],
                ['Context', 'sb-prompt-tc-context'],
                ['Instruct', 'sb-prompt-tc-instruct'],
            ]) {
                const entries = state.textCompletionEntries.filter(entry => entry.section === section && matches(entry));
                shown += entries.length;
                renderRows(group(translate(section), className), entries.map(prompt => ({ prompt })));
            }
            syncSectionVisibility(true);
            finishList(shown, state.textCompletionEntries.length);
            return true;
        }
        const utilities = UTILITY_FIELDS.map(([identifier, name]) => ({ identifier, name: translate(name), content: model.readUtility(identifier) }));
        // A token sort reads counts that arrive after the state does, so the counts it read are part of the key.
        const tokenCounts = sortOrder.startsWith('tokens') ? state.prompts.map(knownCount) : null;
        const nextKey = JSON.stringify([state.scope, state.prompts, state.order, state.counts, state.sources, state.error, state.runtime, state.character?.name, utilities, filter, selectedId(), tokenizerKey, sortOrder, tokenCounts]);
        if (nextKey === renderedListKey) return false;
        renderedListKey = nextKey;
        const focused = listBody.contains(document.activeElement) ? document.activeElement : null;
        const focusedId = focused?.closest('[data-prompt-id]')?.dataset.promptId;
        const matches = prompt => prompt.name.toLowerCase().includes(filter.toLowerCase());
        const rows = sortEntries(state.order.flatMap(entry => {
            const prompt = promptFor(entry.identifier);
            return prompt && matches(prompt) ? [{ prompt, orderEntry: entry }] : [];
        }), sortOrder);
        // The assembled Agents row is inspection-only and never enters persisted order data; it stays last in every sort.
        if (matches(state.runtime)) rows.push({ prompt: state.runtime });
        // Sorted, the group no longer shows the order the prompts are sent in, so it stops calling itself that.
        const orderTitle = sortOrder === DEFAULT_SORT ? t`Prompt Order` : t`Main Prompts`;
        const order = group(orderTitle, 'sb-prompt-order');
        if (order.heading.textContent !== orderTitle) order.heading.textContent = orderTitle;
        renderRows(order, rows);
        const box = order.box;
        const error = listBody.querySelector('.sb-prompt-error');
        if (!state.error) error?.remove();
        else if (!error) listBody.prepend(element('div', 'sb-prompt-error', state.error));
        else if (error.textContent !== state.error) error.textContent = state.error;
        const available = state.prompts.filter(prompt => !state.order.some(entry => entry.identifier === prompt.identifier));
        const availableRows = sortEntries(available.filter(matches).map(prompt => ({ prompt, available: true })), sortOrder);
        const utilityRows = utilities.filter(matches).map(prompt => ({ prompt, utility: true }));
        renderRows(group(t`Available`, 'sb-prompt-available'), availableRows);
        renderRows(group(t`Utility Prompts`), utilityRows);
        const ordered = state.order.filter(entry => promptFor(entry.identifier)).length;
        syncSectionVisibility(false);
        finishList(rows.length + availableRows.length + utilityRows.length, ordered + 1 + available.length + utilities.length);
        bindSortable(box, {
            handle: '.sb-prompt-grip',
            items: '> .sb-prompt-row--ordered',
            disabled: reorderLocked(),
            touch: () => mobile.matches,
            start: () => dragScope = state.scope,
            update: (_event, ui) => {
                const ids = [...box.children].filter(row => row.classList.contains('sb-prompt-row--ordered')).map(row => row.dataset.promptId);
                run(() => model.reorder(ids, dragScope));
                state = model.snapshot();
                movedByKeyboardOrDrag(ui.item[0].dataset.promptId);
            },
            stop: () => requestAnimationFrame(() => shell.flushRefresh()),
        });
        if (focusedId && !focused.isConnected) rowFor(focusedId)?.focus({ preventScroll: true });
        if (!placingCounts) scheduleListTokens();
        return true;
    }

    // While a search is on, the subtitle is the result count: the one place a sighted user reads it.
    let resultCount = null;

    function updateListSubtitle() {
        if (filter && resultCount) {
            setSubtitleLine(resultCount.shown === 0 ? t`No results` : t`${resultCount.shown} of ${resultCount.total} results`, true);
            return;
        }
        if (textCompletionView()) {
            setSubtitleLine(t`Grouped by role`);
            return;
        }
        const enabled = state.order.filter(entry => entry.enabled && promptFor(entry.identifier));
        const counts = enabled.map(entry => promptFor(entry.identifier)).filter(Boolean).map(knownCount).filter(count => typeof count === 'number');
        setSubtitleLine(state.strategy === 'character' && state.character?.name
            ? t`Order for ${state.character.name}`
            : t`${enabled.length} active · ${counts.length ? counts.reduce((sum, count) => sum + count, 0) : '-'} tokens`);
    }

    // Reports the result count to the live region and the header, and shows the empty search as a status page.
    function finishList(shown, total) {
        resultCount = { shown, total };
        searchControl.report(shown, total);
        updateListSubtitle();
        selection.decorate();
        syncSelectionActions();
        const empty = listBody.querySelector(':scope > .sb-status-page');
        const noResults = Boolean(filter) && shown === 0;
        if (!noResults) {
            empty?.remove();
            return;
        }
        if (empty) return;
        listBody.append(createStatusPage({ state: 'no-results', icon: 'magnifying-glass', title: t`No Results Found`, description: t`Try a different search`, compact: true }).element);
    }

    function scheduleListTokens() {
        clearTimeout(listTokenTimer);
        if (!isPanelVisible()) {
            tokensPending = true;
            return;
        }
        tokensPending = false;
        listTokenTimer = setTimeout(async () => {
            if (!isPanelVisible()) { tokensPending = true; return; }
            if (shell.isNavigating) { scheduleListTokens(); return; }
            const expectedScope = state.scope;
            const expectedTokenizer = tokenizerKey;
            const tokenNodeFor = id => {
                const row = rowFor(id);
                if (!row) return null;
                const refs = rowRefs.get(row);
                return refs ? refs.token : row.querySelector('.sb-prompt-token');
            };
            if (textCompletionView()) {
                for (const entry of state.textCompletionEntries) {
                    if (!isPanelVisible()) { tokensPending = true; return; }
                    const content = textCompletionContent(entry);
                    if (!content || contentCounts.has(content)) continue;
                    try {
                        const count = await countContent(content);
                        if (state.scope !== expectedScope || tokenizerKey !== expectedTokenizer || !textCompletionView()) return;
                        const token = tokenNodeFor(entry.id);
                        if (token && !shell.isNavigating && token.textContent !== String(count)) token.textContent = String(count);
                    } catch { return; }
                }
                return;
            }
            const prompts = [];
            for (const group of listGroups.values()) {
                for (const id of group.rows.keys()) {
                    const prompt = promptFor(id);
                    if (prompt && !prompt.marker && prompt.content && knownCount(prompt) === '-') prompts.push(prompt);
                }
            }
            let counted = false;
            for (const prompt of prompts) {
                if (!isPanelVisible()) { tokensPending = true; return; }
                if (knownCount(prompt) !== '-') continue;
                const content = prompt.content;
                try {
                    const count = await countContent(content);
                    if (state.scope !== expectedScope || tokenizerKey !== expectedTokenizer) return;
                    if (promptFor(prompt.identifier)?.content !== content) continue;
                    const token = tokenNodeFor(prompt.identifier);
                    if (token && !shell.isNavigating) token.textContent = String(count);
                    counted = true;
                } catch { return; }
            }
            if (shell.isNavigating || !isPanelVisible()) return;
            updateListSubtitle();
            if (counted && readSortOrder().startsWith('tokens')) {
                // The new counts can change a token sort. The render that places them does not ask for counts again.
                placingCounts = true;
                try { renderList(); } finally { placingCounts = false; }
            }
        }, 300);
    }

    function openAddMenu(trigger) {
        const count = state.prompts.filter(prompt => !state.order.some(entry => entry.identifier === prompt.identifier)).length;
        menu(trigger, t`Add Prompt`, [[
            menuItem(t`New Prompt`, 'plus', async () => {
                if (!(await allowLeave())) return;
                await openDraft(model.newDraft(), 'prompt', 'edit', true);
            }),
            { ...menuItem(t`Add From Available (${count})`, 'folder-open', () => {
                searchControl.setQuery('');
                const section = listBody.querySelector('.sb-prompt-available');
                const top = listBody.scrollTop + section.getBoundingClientRect().top - listBody.getBoundingClientRect().top;
                listBody.scrollTo({ top, behavior: document.body.classList.contains('reduced-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
                section.querySelector('h3').focus({ preventScroll: true });
            }), disabled: count === 0 },
        ]]);
    }

    function openListMenu(trigger) {
        menu(trigger, t`Prompt List`, [
            presetsInMenu() ? [{ ...menuItem(t`Presets`, 'sliders', openPresets), data: { sbEditorPresets: '' } }] : [],
            [menuItem(t`Import Prompt List`, 'file-import', async () => { if (await allowLeave()) model.importList(); }), menuItem(t`Export Prompt List`, 'file-export', () => model.exportList()), state.strategy === 'character' && state.character && menuItem(t`Export Character Prompts`, 'file-export', () => model.exportCharacter())],
            [menuItem(t`Select`, 'list-check', () => selection.enter(null, trigger)), menuItem(t`Reset Order`, 'rotate-left', async () => { if (await allowLeave()) model.resetOrder(); })],
        ]);
    }

    // A sort changes what the list shows, never the order the prompts are stored and sent in.
    function openSortMenu(trigger) {
        const current = readSortOrder();
        const labels = [[DEFAULT_SORT, t`Prompt Order`], ['name-asc', t`Title A-Z`], ['name-desc', t`Title Z-A`], ['tokens-asc', t`Tokens ↗`], ['tokens-desc', t`Tokens ↘`]];
        openActionMenu({
            trigger,
            title: sortButton.getAttribute('aria-label'),
            sections: [{
                title: t`Sort By`,
                items: labels.map(([value, label]) => ({
                    label,
                    icon: 'fa-solid fa-arrow-down-wide-short',
                    kind: 'radio',
                    checked: value === current,
                    onSelect: () => {
                        accountStorage.setItem(SORT_STORAGE_KEY, value);
                        renderList();
                    },
                })),
            }],
        });
        markPromptMenus();
    }

    const searchControl = createListSearch({
        field: searchField,
        input: search,
        trigger: searchButton,
        scope: list,
        scroller: listBody,
        status,
        typeToSearchSelector: '.sb-prompt-row',
        closeEmptyOnBlur: true,
        debounce: 150,
        onChange: query => {
            filter = query;
            renderList();
        },
    });

    // Selection mode: the prompts of the order and the available ones; utility prompts and the Agents row take no bulk action.
    let bulkBusy = false;
    const selectionKeys = () => [...listBody.querySelectorAll(SELECTABLE_ROW)].map(row => row.dataset.promptId);

    function syncSelectionActions() {
        if (!selection.isActive) return;
        listHeader.element.hidden = true;
        for (const button of selectionActions.querySelectorAll('button')) button.disabled = bulkBusy || selection.count === 0;
    }

    async function bulkAction(action) {
        if (bulkBusy || !selection.count) return;
        const expectedScope = state.scope;
        const targets = selection.selectedKeys.map(id => ({ id, prompt: promptFor(id), entry: state.order.find(item => item.identifier === id) })).filter(item => item.prompt);
        bulkBusy = true;
        syncSelectionActions();
        try {
            if (action === 'on' || action === 'off') {
                for (const { id, prompt, entry } of targets) {
                    if (entry && model.permissions(prompt).toggle && Boolean(entry.enabled) !== (action === 'on')) run(() => model.toggle(id, expectedScope));
                }
            } else if (action === 'remove') {
                const removed = targets.filter(({ prompt, entry }) => entry && model.permissions(prompt).remove)
                    .map(({ id }) => run(() => model.remove(id, expectedScope))).filter(Boolean);
                if (removed.length) toast(removed.length === 1 ? t`Removed ${promptFor(removed[0].entry.identifier)?.name ?? ''}` : t`Removed ${removed.length} prompts`, () => [...removed].reverse().forEach(record => model.undoRemove(record)));
            } else if (action === 'delete') {
                const deletable = targets.filter(({ prompt }) => model.permissions(prompt).delete);
                const text = deletable.length === 1 ? t`Delete this prompt? This cannot be undone.` : t`Delete ${deletable.length} prompts? This cannot be undone.`;
                if (!deletable.length || !await confirmDestructiveAction({ text, confirmLabel: t`Delete` })) return;
                for (const { id } of deletable) run(() => model.delete(id, expectedScope));
            }
        } finally {
            bulkBusy = false;
            synchronize();
            selection.decorate({ prune: true });
            syncSelectionActions();
        }
    }

    const selection = createSelectionMode({
        root, list: listBody, rowSelector: SELECTABLE_ROW, keySourceSelector: '.sb-prompt-grip',
        getKey: row => row.dataset.promptId, getAllKeys: selectionKeys,
        header: selectionHeader, actionBar: selectionActions, title: count => t`${count} selected`, selectAllLabel: t`Select All`,
        canEnter: () => !bulkBusy && !shell.isOpen && !textCompletionView(),
        actions: [
            { id: 'on', label: t`Turn On`, icon: 'fa-solid fa-toggle-on', onActivate: () => void bulkAction('on') },
            { id: 'off', label: t`Turn Off`, icon: 'fa-solid fa-toggle-off', onActivate: () => void bulkAction('off') },
            { id: 'remove', label: t`Remove From List`, icon: 'fa-solid fa-minus', onActivate: () => void bulkAction('remove') },
            { id: 'delete', label: t`Delete`, icon: 'fa-solid fa-trash', danger: true, onActivate: () => void bulkAction('delete') },
        ],
        onChange: syncSelectionActions,
        onExit: () => { listHeader.element.hidden = false; },
    });

    function discardDraft() {
        const live = kind === 'utility'
            ? { ...draft, content: model.readUtility(draft.identifier) }
            : kind === 'text-completion' ? model.readTextCompletionEntry(draft.identifier) : promptFor(draft.identifier);
        if (!live) {
            closeNow();
            return;
        }
        draft = structuredClone(live);
        draftScope = state.scope;
        unsaved = false;
        drafts.remove(session.context?.entityId ?? entityKey());
        session.rebase();
        renderEditor();
    }

    function cancelEdits() {
        if (!draft || !dirty()) return;
        discardDraft();
        editor.querySelector('.sb-prompt-title')?.focus({ preventScroll: true });
    }

    function save() {
        if (!draft || !dirty()) return true;
        if (kind === 'prompt' && run(() => model.save(draft, draftScope)) === false) return false;
        if (kind === 'utility') {
            if (run(() => model.saveUtility(draft, draftScope)) === false) return false;
        }
        if (kind === 'text-completion' && run(() => model.saveTextCompletion(draft, draftScope)) === false) return false;
        unsaved = false;
        session.markSaved({ entityId: entityKey() });
        synchronize();
        status.textContent = t`Saved`;
        return true;
    }

    function markDirty() {
        session.changed({ immediate: true });
        scheduleTokens();
    }

    // Presents the dirty state in the header; the session calls it after every change of the baseline or the draft.
    function renderState() {
        if (!draft || !chrome) return;
        chrome.render({ mode: 'edit', title: draft.name, dirty: dirty(), saveLabel: t`Save` });
        if (kind === 'prompt' && !model.permissions(draft).edit) editor.querySelector('.sb-prompt-save').disabled = true;
    }

    async function openPrompt(prompt, requestedMode = null) {
        if (draft?.identifier === prompt.identifier && requestedMode === null) return closeEditor();
        if (!(await allowLeave())) return;
        const nextMode = requestedMode ?? (model.permissions(prompt).edit ? 'edit' : 'preview');
        await openDraft(prompt, 'prompt', nextMode);
    }

    async function openUtility(prompt) {
        if (!(await allowLeave())) return;
        await openDraft({ ...prompt, content: model.readUtility(prompt.identifier) }, 'utility', 'edit');
    }

    async function openTextCompletion(entry, requestedMode = null) {
        if (draft?.identifier === entry.identifier && kind === 'text-completion' && requestedMode === null) return closeEditor();
        if (!(await allowLeave())) return;
        await openDraft(model.readTextCompletionEntry(entry.identifier), 'text-completion', requestedMode ?? 'edit');
    }

    async function restoreUtility(identifier) {
        if (!(await allowLeave())) return;
        if (run(() => model.restoreUtility(identifier, state.scope)) === false) return;
        synchronize();
    }

    async function openDraft(value, nextKind, nextMode, isNew = false) {
        shell.cancelNavigation();
        closeOverlays();
        // The previous draft is settled; its backup must not take the new draft's values while this one renders.
        session.close();
        dismissDraftRecoveryToast();
        draft = structuredClone(value);
        kind = nextKind;
        mode = nextMode;
        draftScope = state.scope;
        unsaved = isNew;
        tokenCount = null;
        renderList();
        // Callers ran the leave guard; force re-renders the same prompt in a new mode.
        const shown = await shell.selectItem(draft.identifier, { guard: false, force: true });
        // The baseline is the draft as it stands once the editor is on screen; a stored backup is offered from here.
        if (shown && draft) session.open({ mode: 'edit', entityId: entityKey() });
    }

    function closeEditor() {
        return shell.deselectItem();
    }

    // Ends the session of a draft that is clean or already settled by the leave guard, and drops its backup.
    function endSession() {
        if (session.isOpen()) drafts.remove(session.context.entityId);
        dismissDraftRecoveryToast(draftOwner());
        session.close();
        unsaved = false;
        chrome?.dispose();
        chrome = null;
    }

    function closeNow() {
        endSession();
        draft = null;
        closeOverlays();
        shell.deselectNow();
    }

    // A switch property is one label: a press on its text or beside the switch toggles it, so the property is the target.
    function property(label, control) {
        const node = element(control.matches?.('input.sb-switch') ? 'label' : 'div', 'sb-prompt-property');
        node.append(element('span', '', label), control);
        return node;
    }

    function segmented(label, choices, value, change) {
        return createSegmentedControl(label, choices, value, change);
    }

    // Menus and popovers of the editor belong to its edit surface for the preset autosave (see sillybunny-preset-autosave.js).
    function markPromptMenus() {
        document.querySelectorAll('.sb-action-menu, .sb-action-sheet, .sb-action-popover').forEach(node => node.dataset.sbPromptMenu = 'true');
    }

    // A property that is one choice of a few: a button that shows the choice and opens a menu of radio items. The button's
    // accessible name holds the text it shows ("Position: Default"), as WCAG 2.5.3 asks.
    function choiceControl(name, choices, current, choose) {
        const label = element('span', '', choices.find(([value]) => value === current())?.[1] ?? '');
        const showChoice = text => {
            label.textContent = text;
            nameByValue(trigger, name, text);
        };
        const trigger = button(name, null, () => {
            openActionMenu({
                trigger,
                title: name,
                sections: [{
                    items: choices.map(([value, text]) => ({
                        label: text,
                        kind: 'radio',
                        checked: value === current(),
                        onSelect: () => {
                            showChoice(text);
                            choose(value);
                            markDirty();
                            refreshSummary();
                        },
                    })),
                }],
            });
            markPromptMenus();
        }, 'sb-prompt-dropdown');
        trigger.replaceChildren(label, icon('chevron-down'));
        showChoice(label.textContent);
        trigger.setAttribute('aria-haspopup', 'menu');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.addEventListener('keydown', event => {
            if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            event.preventDefault();
            trigger.click();
        });
        return trigger;
    }

    function roleControl() {
        return choiceControl(t`Role`, [['system', t`System`], ['user', t`User`], ['assistant', t`Assistant`]], () => draft.role ?? 'system', value => { draft.role = value; });
    }

    function triggerSummary() {
        return draft.injection_trigger?.length ? draft.injection_trigger.map(capitalized).join(', ') : t`All Triggers`;
    }

    function triggersControl() {
        const label = element('span', '', triggerSummary());
        const trigger = button(t`Triggers`, null, () => {
            const content = element('div', 'sb-prompt-triggers');
            content.setAttribute('role', 'group');
            content.setAttribute('aria-label', t`Generation Triggers`);
            const rows = TRIGGERS.map(value => createCheckRow({
                label: translate(capitalized(value)),
                field: `trigger-${value}`,
                checked: draft.injection_trigger?.includes(value) ?? false,
                onChange: checked => {
                    const values = new Set(draft.injection_trigger ?? []);
                    if (checked) values.add(value);
                    else values.delete(value);
                    draft.injection_trigger = TRIGGERS.filter(item => values.has(item));
                    label.textContent = triggerSummary();
                    nameByValue(trigger, t`Triggers`, label.textContent);
                    markDirty();
                    refreshSummary();
                },
            }));
            // A pick-several list of more than five items has Select All; its box is mixed while only some are checked.
            const selectAll = createCheckRow({ label: t`Select All`, field: 'trigger-all' });
            selectAll.control.dataset.sbSelectAll = 'true';
            selectAll.row.querySelector('.ds-row-label').dataset.i18n = 'Select All';
            const inputs = rows.map(row => row.control);
            const syncSelectAll = () => {
                const checked = inputs.filter(input => input.checked).length;
                selectAll.control.checked = checked === inputs.length;
                selectAll.control.indeterminate = checked > 0 && checked < inputs.length;
            };
            selectAll.control.addEventListener('change', () => {
                const checked = selectAll.control.checked;
                for (const input of inputs) {
                    if (input.checked === checked) continue;
                    input.checked = checked;
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
                syncSelectAll();
            });
            for (const input of inputs) input.addEventListener('change', syncSelectAll);
            syncSelectAll();
            content.append(selectAll.row, ...rows.map(row => row.row));
            openPopover({
                trigger,
                title: t`Generation Triggers`,
                content,
                initialFocus: () => content.querySelector('input'),
                onClose: () => releaseRowIds(content),
            });
            markPromptMenus();
        }, 'sb-prompt-dropdown');
        trigger.replaceChildren(label, icon('chevron-down'));
        nameByValue(trigger, t`Triggers`, label.textContent);
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        return trigger;
    }

    function properties() {
        if (kind === 'text-completion') return textCompletionProperties();
        const props = element('div', 'sb-prompt-properties');
        props.append(property(t`Role`, roleControl()), property(t`Position`, segmented(t`Position`, [[0, t`Relative`], [1, t`In-chat`]], draft.injection_position ?? 0, value => {
            draft.injection_position = value;
            markDirty();
            refreshProperties();
        })));
        if (Number(draft.injection_position) === 1) {
            for (const [key, label, fallback] of [['injection_depth', t`Depth`, 4], ['injection_order', t`Order`, 100]]) {
                const input = element('input');
                input.type = 'number';
                input.value = draft[key] ?? fallback;
                input.setAttribute('aria-label', label);
                input.addEventListener('input', () => {
                    if (!Number.isFinite(input.valueAsNumber)) return;
                    draft[key] = input.valueAsNumber;
                    markDirty();
                    refreshSummary();
                });
                props.append(property(label, input));
            }
        }
        props.append(property(t`Triggers`, triggersControl()));
        if (['main', 'jailbreak'].includes(draft.identifier)) props.append(property(t`Forbid Overrides`, switchControl(t`Forbid Overrides`, draft.forbid_overrides, value => {
            draft.forbid_overrides = value;
            markDirty();
        })));
        return props;
    }

    // The yes-or-no settings of a template (System same as User) sit in the property bar, as Forbid overrides does for a prompt.
    const textCompletionSwitches = () => (draft.fields ?? []).filter(field => typeof draft.values[field.id] === 'boolean');

    // A template that follows the user template shows the fields it copies as read-only.
    function syncFollowedFields(follows) {
        for (const relatedId of ['instruct_system_sequence', 'instruct_system_suffix']) {
            const related = editor.querySelector(`[data-tc-field="${relatedId}"]`);
            if (!related) continue;
            related.readOnly = follows;
            related.closest('.sb-prompt-content-field')?.classList.toggle('is-disabled', follows);
        }
    }

    function textCompletionChoices(descriptor) {
        const source = document.getElementById(descriptor.id);
        return source instanceof HTMLSelectElement ? [...source.options].map(option => [option.value, option.textContent]) : [];
    }

    function textCompletionProperties() {
        const props = element('div', 'sb-prompt-properties sb-prompt-tc-properties');
        for (const descriptor of draft.properties ?? []) {
            const label = translate(descriptor.name);
            let control;
            if (descriptor.id === 'context_story_string_position' || descriptor.id === 'context_story_string_role') {
                control = choiceControl(label, textCompletionChoices(descriptor), () => String(draft.propertyValues[descriptor.id]), value => { draft.propertyValues[descriptor.id] = value; });
            } else {
                control = element('input');
                control.type = 'number';
                control.value = draft.propertyValues[descriptor.id] ?? '';
                control.setAttribute('aria-label', label);
                control.addEventListener('input', () => {
                    if (!Number.isFinite(control.valueAsNumber)) return;
                    draft.propertyValues[descriptor.id] = control.valueAsNumber;
                    markDirty();
                    refreshSummary();
                });
            }
            props.append(property(label, control));
        }
        for (const field of textCompletionSwitches()) {
            const label = translate(field.name);
            props.append(property(label, switchControl(label, draft.values[field.id], checked => {
                draft.values[field.id] = checked;
                syncFollowedFields(checked);
                markDirty();
                refreshSummary();
            })));
        }
        return props;
    }

    function textCompletionSummary() {
        const parts = [];
        for (const descriptor of draft.properties ?? []) {
            const value = draft.propertyValues[descriptor.id];
            const choice = textCompletionChoices(descriptor).find(([optionValue]) => optionValue === String(value));
            parts.push(`${translate(descriptor.name)}: ${choice?.[1] ?? value}`);
        }
        for (const field of textCompletionSwitches()) parts.push(`${translate(field.name)}: ${draft.values[field.id] ? t`On` : t`Off`}`);
        return parts.join(' · ');
    }

    function refreshSummary() {
        const summary = editor.querySelector('.sb-prompt-property-summary');
        if (!summary) return;
        if (kind === 'text-completion') {
            setSummaryText(summary, t`Prompt Properties`, textCompletionSummary());
            return;
        }
        setSummaryText(summary, t`Prompt Properties`, `${capitalized(draft.role ?? 'system')} · ${Number(draft.injection_position) === 1 ? `${t`In-chat`} @ ${draft.injection_depth ?? 4}` : t`Relative`} · ${triggerSummary()}`);
    }

    function refreshProperties() {
        editor.querySelector('.sb-prompt-properties')?.replaceWith(properties());
        propertyDialog?.body.querySelector('.sb-prompt-properties')?.replaceWith(properties());
        refreshSummary();
    }

    function openProperties(trigger) {
        closeOverlays();
        const heading = element('h2', '', t`Prompt Properties`);
        heading.id = 'sb-prompt-properties-title';
        heading.tabIndex = -1;
        const content = document.createDocumentFragment();
        content.append(heading, properties());
        const dialog = openDialog({
            tier: 'dialog',
            title: heading.textContent,
            content,
            className: 'sb-prompt-properties-dialog',
            initialFocus: () => heading,
        });
        dialog.header.querySelector('.sb-dialog__title')?.replaceWith(heading);
        heading.classList.add('sb-dialog__title');
        const closeButton = dialog.header.querySelector('.sb-dialog__close');
        closeButton?.setAttribute('aria-label', t`Close Prompt Properties`);
        closeButton?.setAttribute('title', t`Close Prompt Properties`);
        dialog.root.setAttribute('aria-labelledby', heading.id);
        propertyDialog = dialog;
        dialog.closed.then(() => {
            if (propertyDialog !== dialog) return;
            propertyDialog = null;
            if (draft) refreshProperties();
        });
    }

    function closeOverlays() {
        closeActionMenu({ animate: false, restoreFocus: false });
        propertyDialog?.forceClose();
        propertyDialog = null;
    }

    function setMode(value) {
        shell.cancelNavigation();
        mode = value;
        renderEditor();
        play(editor.querySelector('.sb-prompt-content'), [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
    }

    function restoreSnapshot(snapshot) {
        draft = structuredClone(snapshot);
        renderEditor();
    }

    // The header item menu: the actions the editor had as inline buttons and in its phone menu, in sections.
    function actionSections() {
        const permission = kind === 'prompt' ? model.permissions(draft) : {};
        const persisted = kind === 'prompt' && (Boolean(promptFor(draft.identifier)) || draft.runtime);
        return [
            [
                persisted && menuItem(t`Inspect`, 'list-check', () => setMode('inspect')),
                persisted && !draft.marker && menuItem(t`Send to Agents`, 'robot', () => model.sendToAgents(draft.identifier)),
            ],
            [
                kind === 'utility' && model.canRestoreUtility(draft.identifier) && menuItem(t`Restore Default`, 'rotate-left', () => restoreUtility(draft.identifier)),
                permission.reset && menuItem(t`Reset to Default`, 'rotate-left', () => { draft = model.resetDraft(draft); renderEditor(); markDirty(); }),
            ],
            [
                permission.remove && state.order.some(entry => entry.identifier === draft.identifier) && menuItem(t`Remove From List`, 'minus', () => remove(draft.identifier)),
                persisted && permission.delete && menuItem(t`Delete`, 'trash', () => deletePrompt(draft.identifier), true),
            ],
        ].map(items => ({ items: items.filter(Boolean) })).filter(section => section.items.length);
    }

    function knownTokens() {
        const total = tokenCount ?? (kind === 'text-completion' ? contentCounts.get(textCompletionContent(draft)) : state.counts?.[draft.identifier]);
        return total === undefined || total === null ? null : { total };
    }

    // The label row of a text field: its name, with Expand at the inline end while the field can be edited. A prompt has one
    // such field, its content; a template has one for each of its sequences.
    function contentField(textarea, body, name = t`Prompt Content`) {
        const field = element('div', 'sb-prompt-content-field');
        const labelRow = element('div', 'sb-prompt-label-row ds-row-textarea__label-row sb-editor-label-row');
        const label = element(textarea ? 'label' : 'span', 'sb-prompt-field-label ds-row-textarea__label', name);
        if (textarea) label.htmlFor = textarea.id;
        labelRow.append(label);
        field.append(labelRow, body);
        if (textarea) {
            const expand = headerIconButton(t`Expand the Editor`, 'maximize', 'editor_maximize ds-row-textarea__expand sb-prompt-expand');
            expand.dataset.for = textarea.id;
            // A template has several Expand buttons; the field's name tells them apart.
            label.id = `${textarea.id}-label`;
            expand.setAttribute('aria-describedby', label.id);
            attachToLabelRow(field, expand);
        }
        return field;
    }

    function renderEditor() {
        if (!draft) return;
        chrome?.dispose();
        editor.hidden = false;
        editor.inert = false;
        editor.dataset.disabled = String(kind === 'text-completion' && draft.disabled);
        editor.replaceChildren();
        const header = element('header', 'sb-editor-header sb-prompt-detail-header');
        const back = headerIconButton(t`Back to Prompt List`, 'chevron-left', 'sb-prompt-back');
        let title;
        if (kind === 'prompt' && model.permissions(draft).rename) {
            title = element('input', 'sb-prompt-title');
            title.value = draft.name;
            title.setAttribute('aria-label', t`Prompt Name`);
            title.addEventListener('input', () => { draft.name = title.value; markDirty(); });
        } else {
            // A name that cannot change is the title of the page, not a locked field. It takes the focus when the page opens.
            title = element('span', 'sb-prompt-title sb-editor-title', draft.name);
            title.tabIndex = -1;
        }
        title.id = 'sb-prompt-form_name';
        const dirtyMark = createDirtyMark('sb-prompt-dirty');
        // A header rebuilt over unsaved edits shows its mark at once instead of animating it in again.
        dirtyMark.hidden = !dirty();
        const readout = createTokenReadout();
        readout.classList.add('sb-prompt-tokens');
        const modes = segmented(t`Edit / Preview`, [['edit', t`Edit`], ['preview', t`Preview`]], mode, setMode);
        modes.classList.add('sb-prompt-modes');
        const modeToggle = headerIconButton(mode === 'edit' ? t`Preview` : t`Edit`, mode === 'edit' ? 'eye' : 'pen', 'sb-prompt-mode-toggle');
        modeToggle.setAttribute('aria-pressed', String(mode === 'preview'));
        modeToggle.addEventListener('click', () => setMode(mode === 'edit' ? 'preview' : 'edit'));
        const more = headerIconButton(t`Prompt Actions`, 'ellipsis-vertical', 'sb-prompt-more');
        more.setAttribute('aria-haspopup', 'menu');
        more.setAttribute('aria-expanded', 'false');
        more.hidden = !actionSections().length;
        const cancel = actionButton(t`Cancel`, 'sb-editor-action--secondary sb-prompt-cancel', 'xmark');
        const saveButton = actionButton(t`Save`, 'sb-editor-action--primary sb-prompt-save');
        for (const control of [back, modeToggle, more, cancel, saveButton]) control.addEventListener('click', event => event.stopPropagation());
        // The chrome puts the readout and the item menu in their places in the header.
        header.append(back, title, dirtyMark, modes, modeToggle, cancel, saveButton);
        editor.append(header);
        const permission = kind === 'prompt' ? model.permissions(draft) : {};
        const templateProperties = kind === 'text-completion' && (draft.properties?.length || textCompletionSwitches().length);
        const hasProperties = (kind === 'prompt' && permission.edit || templateProperties) && mode !== 'inspect';
        // The phone count sits in the row of the property summary; an item without properties keeps the row for it alone.
        let summaryRow = null;
        if (hasProperties) {
            const summary = button('', null, openProperties, 'sb-prompt-property-summary');
            summaryRow = createSummaryRow(summary);
            editor.append(summaryRow, properties());
            refreshSummary();
        } else {
            summaryRow = createSummaryRow();
            editor.append(summaryRow);
        }
        const content = element('div', kind === 'text-completion' ? 'sb-prompt-content sb-prompt-content--fields' : 'sb-prompt-content');
        if (mode === 'inspect') {
            const messages = model.inspect(draft.identifier);
            const block = element('div', 'sb-prompt-preview');
            block.tabIndex = 0;
            for (const message of messages) {
                const details = element('details', 'sb-prompt-inspect-message');
                details.append(element('summary', '', `${message.name} · ${message.role} · ${message.tokens} ${t`tokens`}`), element('pre', '', message.content));
                block.append(details);
            }
            if (!messages.length) block.textContent = t`(Empty prompt)`;
            content.append(block);
        } else if (mode === 'preview' && kind !== 'text-completion') {
            const block = element('pre', 'sb-prompt-preview', kind === 'prompt' ? run(() => model.preview(draft)) || t`(Empty prompt)` : draft.content);
            block.tabIndex = 0;
            content.append(contentField(null, block));
        } else if (kind === 'text-completion') {
            for (const field of draft.fields) {
                const label = translate(field.name);
                const value = draft.values[field.id];
                if (typeof value === 'boolean') continue;
                let fieldNode;
                if (mode === 'preview') {
                    // The same preview a prompt has, so a macro shows its value here as it does there.
                    const block = element('pre', 'sb-prompt-preview', run(() => model.preview({ content: String(value ?? '') })) || '—');
                    block.tabIndex = 0;
                    fieldNode = contentField(null, block, label);
                } else {
                    const textarea = element('textarea', 'sb-prompt-textarea sb-prompt-tc-textarea');
                    // The expanded editor finds the field by this id; the legacy fields of the same names keep theirs.
                    textarea.id = `sb-prompt-tc-${field.id}`;
                    textarea.value = value ?? '';
                    textarea.dataset.tcField = field.id;
                    textarea.setAttribute('aria-label', label);
                    textarea.spellcheck = false;
                    const followsUser = ['instruct_system_sequence', 'instruct_system_suffix'].includes(field.id) && Boolean(draft.values.instruct_system_same_as_user);
                    textarea.readOnly = followsUser;
                    // The expanded editor writes back with jQuery .trigger('input'), which native listeners do not hear.
                    $(textarea).on('input', () => {
                        draft.values[field.id] = textarea.value;
                        markDirty();
                    });
                    fieldNode = contentField(textarea, textarea, label);
                    fieldNode.classList.toggle('is-disabled', followsUser);
                }
                fieldNode.classList.add('sb-prompt-tc-field');
                content.append(fieldNode);
            }
        } else {
            const textarea = element('textarea', 'sb-prompt-textarea');
            textarea.id = 'sb-prompt-form_prompt';
            textarea.value = draft.marker ? run(() => model.preview(draft)) || '' : draft.content ?? '';
            textarea.readOnly = Boolean(draft.marker);
            if (draft.marker) textarea.placeholder = state.sources[draft.identifier] ?? t`Generation time`;
            textarea.setAttribute('aria-label', t`Prompt Content`);
            textarea.spellcheck = false;
            // The legacy expanded editor writes back with jQuery .trigger('input').
            $(textarea).on('input', () => { draft.content = textarea.value; markDirty(); });
            content.append(contentField(textarea, textarea));
        }
        editor.append(content);
        const footer = element('footer', 'sb-prompt-footer');
        if (state.sources?.[draft.identifier]) footer.append(element('span', '', `${t`Source`}: ${state.sources[draft.identifier]}`));
        if (footer.childElementCount) editor.append(footer);
        chrome = mountEditorChrome({
            root: editor, header, content,
            controls: { back, title, dirty: dirtyMark, more, modes: [modes, modeToggle], cancel, save: saveButton },
            tokens: summaryRow ? { element: readout, row: { host: summaryRow } } : null,
            itemMenuLabel: t`Prompt Actions`,
            onBack: () => { void closeEditor(); },
            onCancel: cancelEdits,
            onSave: () => { save(); },
            getActionSections: actionSections,
            actionMenuTitle: () => draft.name,
        });
        // The editor's menus are part of its edit surface for the preset autosave (see sillybunny-preset-autosave.js).
        more.addEventListener('click', markPromptMenus);
        renderState();
        chrome.setTokens(knownTokens());
        scheduleLayout();
        scheduleTokens();
    }

    function scheduleTokens() {
        clearTimeout(tokenTimer);
        const request = ++tokenRequest;
        tokenTimer = setTimeout(async () => {
            if (!draft || draft.marker) return;
            if (shell.isNavigating) { scheduleTokens(); return; }
            try {
                const count = await countContent(kind === 'text-completion' ? textCompletionContent(draft) : draft.content || '');
                if (request !== tokenRequest || !draft) return;
                tokenCount = count;
            } catch {
                if (request !== tokenRequest) return;
                tokenCount = '?';
            }
            chrome?.setTokens(knownTokens());
        }, 300);
    }

    function scheduleLayout() {
        shell?.scheduleLayout();
    }

    function applyShellLayout() {
        if (column.classList.contains('sb-prompt-detail-open') !== Boolean(draft)) column.classList.toggle('sb-prompt-detail-open', Boolean(draft));
    }

    function ensureVisibilityObserver() {
        if (!column.isConnected) return;
        const ancestors = [];
        for (let ancestor = column; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
            ancestors.push(ancestor);
        }
        if (visibilityObserver
            && ancestors.length === observedAncestors.length
            && ancestors.every((node, index) => node === observedAncestors[index])) {
            return;
        }
        visibilityObserver?.disconnect();
        visibilityObserver = new MutationObserver(() => {
            if (!isPanelVisible()) return;
            if (syncPending) synchronize();
            else if (tokensPending && !placingCounts) scheduleListTokens();
        });
        observedAncestors = ancestors;
        for (const ancestor of ancestors) {
            visibilityObserver.observe(ancestor, { attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'inert', 'class'] });
        }
    }

    function scheduleSynchronize() {
        ensureVisibilityObserver();
        if (!isPanelVisible()) {
            syncPending = true;
            return;
        }
        if (synchronizeFrame) return;
        synchronizeFrame = requestAnimationFrame(() => {
            synchronizeFrame = 0;
            synchronize();
        });
    }

    function synchronize() {
        cancelAnimationFrame(synchronizeFrame);
        synchronizeFrame = 0;
        ensureVisibilityObserver();
        if (!stylesReady || !promptManager?.serviceSettings) return;
        if (!isPanelVisible()) {
            syncPending = true;
            return;
        }
        syncPending = false;
        model ??= createPromptEditorModel(promptManager);
        const isChatCompletion = main_api === 'openai';
        if (!isChatCompletion && !document.getElementById('sysprompt_content')) return;
        const next = isChatCompletion ? model.snapshot() : model.snapshotTextCompletions();
        if (!next) return;
        state = next;
        const nextTokenizer = isChatCompletion ? JSON.stringify([getTokenizerModel(), state.scope]) : '';
        if (nextTokenizer !== tokenizerKey) {
            tokenizerKey = nextTokenizer;
            contentCounts.clear();
            contentRequests.clear();
            tokenRequest++;
            if (draft) scheduleTokens();
        }
        if (draft && draftScope !== state.scope && !dirty()) closeNow();
        if (!isChatCompletion) {
            tokenizerKey = '';
            contentCounts.clear();
            contentRequests.clear();
        }
        if (root.hidden) root.hidden = false;
        if (!column.classList.contains('sb-prompt-owned')) {
            column.classList.add('sb-prompt-owned');
            // The legacy popup sits outside this column. Finding the column with a body-wide :has() made every DOM change re-check the document.
            document.getElementById('completion_prompt_manager_popup')?.setAttribute('data-sb-prompt-owned', '');
        }
        if (draft && session.isOpen() && !dirty()) {
            const live = kind === 'prompt'
                ? promptFor(draft.identifier)
                : kind === 'text-completion' ? model.readTextCompletionEntry(draft.identifier) : { ...draft, content: model.readUtility(draft.identifier) };
            if (!live && !draft.runtime) closeNow();
            else if (live && JSON.stringify(live) !== JSON.stringify(session.readBaseline())) {
                draft = structuredClone(live);
                draftScope = state.scope;
                session.rebase();
                renderEditor();
            }
        }
        if (renderList()) scheduleLayout();
    }

    editor.addEventListener('keydown', event => {
        if (event.isComposing) return;
        // Escape closes the innermost surface only; the settings page closes itself on any bubbling Escape.
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void closeEditor(); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
    });
    document.addEventListener('change', async event => {
        if (replayingChange || !dirty() || !(event.target instanceof HTMLSelectElement)) return;
        const select = event.target;
        const isBackendSwitch = select.id === 'main_api';
        const tcPresetIndex = { sysprompt_select: 1, instruct_presets: 2, context_presets: 3 }[select.id];
        const isRelevantPreset = kind === 'text-completion' ? tcPresetIndex !== undefined : select.id === 'settings_preset_openai';
        if (!isBackendSwitch && !isRelevantPreset) return;
        event.stopImmediatePropagation();
        const nextValue = select.value;
        const scope = JSON.parse(draftScope);
        const previousValue = isBackendSwitch
            ? kind === 'text-completion' ? scope[0] : main_api
            : tcPresetIndex !== undefined ? scope[tcPresetIndex] : [...select.options].find(option => option.textContent === scope[2])?.value;
        select.value = previousValue;
        if (!(await allowLeave())) return;
        closeNow();
        select.value = nextValue;
        replayingChange = true;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        replayingChange = false;
    }, true);
    document.addEventListener('sb:shell-tab-activated', async event => {
        if (event.detail.tabId === 'editor') {
            ensureVisibilityObserver();
            synchronize();
            if (tokensPending && !placingCounts) scheduleListTokens();
            return;
        }
        shell.cancelNavigation();
        closeOverlays();
        if (!dirty()) return;
        if (!(await allowLeave())) {
            window.SillyBunnyShell.openTab('left', 'editor');
            if (mobile.matches) document.querySelector('button[data-sb-settings-tab="editor"]')?.click();
        } else closeNow();
    });
    document.addEventListener('sb:settings-content-revealed', () => {
        ensureVisibilityObserver();
        if (!isPanelVisible()) return;
        if (syncPending) synchronize();
        else if (tokensPending && !placingCounts) scheduleListTokens();
    });
    document.addEventListener('change', event => {
        if (event.target instanceof HTMLSelectElement && event.target.matches('#sysprompt_select, #instruct_presets, #context_presets')) scheduleSynchronize();
    });
    document.addEventListener('sb:prompt-manager-rendered', scheduleSynchronize);
    document.getElementById('main_api')?.addEventListener('change', scheduleSynchronize);
    eventSource.on(event_types.APP_READY, synchronize);
    window.addEventListener('pagehide', () => session.flushDraft());
    Promise.all([
        loadListEditorStyles(),
        window.SillyBunnyAssets.loadStylesheetAsync('css/sillybunny-entity-list.css?v=20261118zza', { id: 'deferred-entity-list-css' }),
        window.SillyBunnyAssets.loadStylesheetAsync('css/sillybunny-prompt-editor.css?v=20261122j', { id: 'deferred-prompt-editor-css' }),
    ])
        .then(() => { stylesReady = true; synchronize(); })
        .catch(error => toastr.error(error.message));
}
