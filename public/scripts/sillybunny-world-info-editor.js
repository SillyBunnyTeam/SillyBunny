import {
    createWorldInfoEntry, deleteWIOriginalDataValue, deleteWorldInfoEntry, duplicateWorldInfoEntry,
    getWorldInfoDisplayEntries, getWorldInfoEditorState, moveWorldInfoEntry, refreshWorldInfoEditor,
    saveWorldInfo, setWIOriginalDataValue, setWorldInfoEditorAdapter, SORT_ORDER_KEY, worldInfoFilter, world_names, world_info,
} from './world-info.js';
import { characters } from '../script.js';
import { power_user } from './power-user.js';
import { FILTER_TYPES } from './filters.js';
import { navigation_option } from './utils.js';
import { accountStorage } from './util/AccountStorage.js';
import { t, translate } from './i18n.js';
import { eventSource, event_types } from './events.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from './popup.js';
import { confirmVerb } from './sillybunny-delete-confirm.js';
import { openActionMenu, closeActionMenu, isActionMenuOpen } from './sillybunny-action-menu.js';
import { createListEditor, loadListEditorStyles } from './sillybunny-editor/list-shell.js';
import { LAYOUT_MOBILE_QUERY } from './sillybunny-editor/breakpoints.js';
import { reconcileRows, rowEntry, bindListKeyboard, bindSortable } from './sillybunny-editor/list-rows.js';
import { createListSearch } from './sillybunny-editor/list-search.js';
import { createSearchEntry } from './sillybunny-editor/search-entry.js';
import { announceReorder, reorderMenuItems } from './sillybunny-editor/reorder-menu.js';
import { createListPagination } from './sillybunny-editor/list-pagination.js';
import { createSelectionMode } from './sillybunny-editor/selection-mode.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { createEntityRow } from './sillybunny-editor/entity-row.js';
import { createListHeader } from './sillybunny-editor/list-header.js';
import { openPicker, isPickerOpen } from './sillybunny-editor/picker.js';
import { characterTabGuardSelector, registerEditorNavigation } from './sillybunny-editor/navigation.js';
import { objectNavigation } from './sillybunny-editor/object-navigation.js';
import {
    duplicate, move, remove, reorder, setEnabled, entryBadge, entryKeyPreview, entryStrategy, entryTitle,
} from './sillybunny-world-info-model.js';
import { mountWorldInfoSettings } from './sillybunny-world-info-settings.js';
import { mountWorldInfoEntry, worldInfoDraftKey } from './sillybunny-world-info-entry.js';

const STYLESHEETS = [
    { href: 'css/sillybunny-entity-list.css?v=20261118zza', id: 'deferred-entity-list-css' },
    { href: 'css/sillybunny-world-info-editor.css?v=20261122g', id: 'deferred-world-info-editor-css' },
];
const mountedEditors = new WeakMap();
const itemKey = item => item.kind === 'settings' ? 'settings' : `entry:${item.uid}`;
/** Controls `update()` touches on every pass, captured once when the row is built. */
const entryRowRefs = new WeakMap();

/**
 * Row signature from exactly what `makeEntryRow` renders. `content` never reaches the row and
 * `disable` is applied by `update()`, so editing either reuses the row instead of rebuilding it.
 */
export function worldInfoRowSignature(entry, reorderable, fallbackTitle = 'Untitled entry') {
    return [entryTitle(entry, fallbackTitle), entryStrategy(entry), entryKeyPreview(entry), entryBadge(entry), reorderable ? 1 : 0].join('\u001f');
}

/** Collects stable, deduplicated character/persona links for a book without changing saved data. */
export function collectWorldInfoUsers(name, characterList, charLore, personas, descriptions) {
    if (!name) return [];
    const extraAvatars = new Set((charLore ?? []).filter(link => link.extraBooks?.includes(name)).map(link => link.name));
    const users = new Map();
    for (const character of characterList) {
        if (!character?.avatar) continue;
        const primary = character.data?.extensions?.world === name;
        // Upstream keys charLore by getCharaFilename() (no extension); accept the full avatar too.
        const extra = extraAvatars.has(character.avatar) || extraAvatars.has(character.avatar.replace(/\.[^/.]+$/, ''));
        if (!primary && !extra) continue;
        const value = `character:${character.avatar}`;
        users.set(value, {
            value, label: character.name, relation: primary ? 'primary' : 'extra',
            target: { kind: 'character-editor', id: character.avatar, via: 'world-info' },
        });
    }
    for (const [avatarId, label] of Object.entries(personas ?? {})) {
        if (descriptions?.[avatarId]?.lorebook !== name) continue;
        const value = `persona:${avatarId}`;
        users.set(value, { value, label, relation: 'persona', target: { kind: 'persona-editor', id: avatarId } });
    }
    return [...users.values()];
}

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

function icon(name) {
    const node = element('i', `fa-solid fa-${name}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

function run(action) {
    Promise.resolve().then(action).catch(error => globalThis.toastr?.error(error.message));
}

function menuItem(label, glyph, action, danger = false, disabled = false) {
    return { label, icon: `fa-solid fa-${glyph}`, danger, disabled, onSelect: () => run(action) };
}

function transport(id) {
    return document.getElementById(id);
}

function customSort() {
    return transport('world_info_sort_order')?.selectedOptions?.[0]?.dataset.rule === 'custom';
}

/** True while the sort is not Priority (the saved choice stands in for a search's temporary sort) or a view filter other than All is on. */
function viewAltered(worldInfo) {
    const sort = transport('world_info_sort_order');
    const sortValue = sort?.selectedOptions?.[0]?.dataset.rule === 'search' ? accountStorage.getItem(SORT_ORDER_KEY) || '0' : sort?.value ?? '0';
    const filtered = [...worldInfo.querySelectorAll('.world_info_view_filter.is-active')].some(control => control.dataset.filter !== 'all');
    return sortValue !== '0' || filtered;
}

function showStatus(host, options) {
    host.replaceChildren(createStatusPage(options).element);
}

/** UID lookup uses the filtered/sorted list, never UID arithmetic (UIDs may have gaps). */
export function pageForWorldInfoUid(entries, uid, pageSize) {
    if (!Number.isInteger(pageSize) || pageSize <= 0) throw new RangeError('pageSize must be a positive integer.');
    const index = entries.findIndex(entry => String(entry.uid) === String(uid));
    return Math.floor(Math.max(0, index) / pageSize) + 1;
}

/** Keeps held UIDs in order even when filters omit them; new display entries follow the fresh order. */
export function preserveWorldInfoEntryOrder(heldUids, displayEntries, allEntries) {
    const heldKeys = heldUids.map(String);
    const heldSet = new Set(heldKeys);
    const entriesByUid = new Map(allEntries.map(entry => [String(entry.uid), entry]));
    const heldEntries = heldKeys.flatMap(uid => {
        const entry = entriesByUid.get(uid);
        return entry ? [entry] : [];
    });
    return [...heldEntries, ...displayEntries.filter(entry => !heldSet.has(String(entry.uid)))];
}

export function createWorldInfoDeps() {
    return {
        saveWorldInfo,
        setOriginal: setWIOriginalDataValue,
        deleteOriginal: deleteWIOriginalDataValue,
        createEntry: createWorldInfoEntry,
        duplicateEntry: duplicateWorldInfoEntry,
        deleteEntry: deleteWorldInfoEntry,
        moveEntry: moveWorldInfoEntry,
    };
}

function updateBookDrafts(oldName, newName) {
    if (oldName === newName) return;
    const prefix = worldInfoDraftKey(oldName);
    try {
        const storage = globalThis.localStorage;
        const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(key => key?.startsWith(prefix));
        for (const key of keys) {
            if (newName !== undefined) storage.setItem(worldInfoDraftKey(newName, key.slice(prefix.length)), storage.getItem(key));
            storage.removeItem(key);
        }
    } catch (error) {
        console.warn('[sb-wi-editor] Failed to update book drafts', error);
    }
}

/** The shell stays inside WorldInfo so reloadEditor's focused-input deferral also protects drafts. */
export function mountWorldInfoEditor(container) {
    if (!(container instanceof HTMLElement)) throw new TypeError('World Info editor requires an HTMLElement.');
    if (mountedEditors.has(container)) return mountedEditors.get(container);
    const worldInfo = container.matches('#WorldInfo') ? container : container.querySelector('#WorldInfo');
    if (!worldInfo) throw new Error('World Info editor must be mounted inside #WorldInfo.');
    const host = worldInfo.querySelector('#wi-holder') ?? worldInfo;
    const deps = createWorldInfoDeps();
    const rows = new Map();
    let menuTrigger = null;
    let state = getWorldInfoEditorState();
    let renderedName;
    let entries = [];
    let activeController = null;
    let controllerKind = null;
    let shell = null;
    let sortable = null;
    let picker = null;
    let destroyed = false;
    let initialized = false;
    let preparingReveal = false;
    let pendingBook = null;
    let listDirty = false;
    let internalPaging = false;
    let renderRevision = 0;
    let shownRevision = 0;
    let dragBook = null;
    let heldOrder = null;
    let selection = null;
    let bulkBusy = false;

    const toggleSettings = () => shell.selectedKey === 'settings' ? shell.deselectItem() : shell.selectItem({ kind: 'settings' });
    const listHeader = createListHeader({
        title: '',
        className: 'sb-wi-list-header',
        titleClassName: 'sb-wi-book-name',
        subtitleClassName: 'sb-wi-list-subtitle',
        titleButton: { label: t`Worlds/Lorebooks`, className: 'sb-wi-book-switcher', onActivate: trigger => run(() => openBookPicker(trigger)) },
        actions: [
            { id: 'search', label: t`Search`, icon: 'magnifying-glass', toggle: true, onActivate: () => run(() => searchControl.toggle()) },
            { id: 'new', label: t`New Entry`, icon: 'plus', onActivate: () => run(() => clickTransport('world_popup_new')) },
            { id: 'book', label: t`World Info`, icon: 'ellipsis-vertical', menu: true, className: 'sb-wi-book-actions', onActivate: trigger => run(() => openBookMenu(trigger)) },
        ],
    });
    const bookSwitcher = listHeader.titleButton;
    const bookLabel = listHeader.element.querySelector('.sb-wi-book-name');
    const bookActions = listHeader.button('book');
    const newEntryButton = listHeader.button('new');
    const searchButton = listHeader.button('search');
    const selectionHeader = element('header', 'sb-wi-selection-header');
    const selectionBar = element('div', 'sb-wi-selection-bar');
    const searchEntry = createSearchEntry({
        clearLabel: t`Clear Entry`,
        variant: 'bar', className: 'sb-wi-search-entry', inputClassName: 'sb-wi-search',
        placeholder: t`Search…`, label: t`Search`, clearOnEscape: false,
    });
    // HUMAN: replace — Sort control label.
    const sortLabel = t`lorum ipsum`;
    const filterButton = element('button', 'sb-list-header__button sb-header-icon-button sb-wi-sort-button');
    filterButton.type = 'button';
    filterButton.dataset.actionId = 'sort';
    filterButton.title = sortLabel;
    filterButton.setAttribute('aria-label', sortLabel);
    filterButton.setAttribute('aria-haspopup', 'menu');
    filterButton.setAttribute('aria-expanded', 'false');
    filterButton.setAttribute('aria-pressed', 'false');
    filterButton.append(icon('arrow-down-wide-short'));
    const onSortClick = () => run(() => openFilterMenu(filterButton));
    filterButton.addEventListener('click', onSortClick);
    const searchField = element('div', 'sb-wi-search-field sb-list-search-bar');
    searchField.append(searchEntry.element, filterButton);
    const searchInput = searchEntry.input;
    searchField.hidden = true;
    searchInput.value = transport('world_info_search')?.value ?? '';

    const listBody = element('div', 'sb-wi-list-body');
    const entriesHeading = element('h3', 'sb-wi-list-heading', t`Lorebook Entries`);
    entriesHeading.tabIndex = -1;
    const entryBox = element('div', 'sb-wi-list-box ds-entity-list');
    entryBox.setAttribute('role', 'list');
    const listStatus = element('div', 'sb-wi-list-status');
    listBody.append(entriesHeading, entryBox, listStatus);

    const listContent = element('div', 'sb-wi-list-content');
    const searchStatus = element('div', 'sb-list-editor__status');
    searchStatus.setAttribute('aria-live', 'polite');

    const searchControl = createListSearch({
        field: searchField,
        input: searchInput,
        trigger: searchButton,
        scope: listContent,
        status: searchStatus,
        scroller: listBody,
        debounce: 300,
        closeEmptyOnBlur: true,
        onChange: query => {
            heldOrder = null;
            if (transport('world_info_search')) transport('world_info_search').value = query;
            worldInfoFilter.setFilterData(FILTER_TYPES.WORLD_INFO_SEARCH, query);
        },
    });
    const pagination = createListPagination({
        pageSizes: [10, 25, 50, 100, 500, 1000],
        readPageSize: () => accountStorage.getItem('WI_PerPage'),
        writePageSize: size => accountStorage.setItem('WI_PerPage', String(size)),
        guard: () => internalPaging || shell.guardLeave(),
        onChange: () => {
            if (!internalPaging) {
                heldOrder = null;
                updateDisplayEntries();
            }
            renderList();
        },
    });

    function entryController() {
        return controllerKind === 'entry' ? activeController : null;
    }

    function destroyDetail({ keepDraft = false } = {}) {
        keepDraft ||= entryController()?.isDirty() ?? false;
        const previous = activeController;
        activeController = null;
        controllerKind = null;
        previous?.destroy({ keepDraft });
    }

    function selectedUid() {
        return shell?.selectedItem?.kind === 'entry' ? shell.selectedItem.uid : null;
    }

    function rebase(uid, key) {
        if (String(selectedUid()) === String(uid)) entryController()?.rebaseKey(key);
    }

    async function clickTransport(id) {
        const name = state.name;
        if (await shell.guardLeave() && name === state.name) transport(id)?.click();
    }

    function openBookPicker(trigger) {
        picker = openPicker({
            trigger,
            title: t`Worlds/Lorebooks`,
            items: (world_names ?? []).map(name => ({ value: name, label: name })),
            selected: state.name,
            matchTriggerWidth: true,
            footer: [
                { label: t`New`, icon: 'fa-solid fa-plus', onSelect: () => run(() => clickTransport('world_create_button')) },
                { label: t`Import World Info`, icon: 'fa-solid fa-file-import', onSelect: () => run(() => clickTransport('world_import_button')) },
            ],
            onSelect: name => run(async () => {
                if (name === state.name || !(await shell.guardLeave())) return;
                const select = transport('world_editor_select');
                if (!(select instanceof HTMLSelectElement)) return;
                const index = (world_names ?? []).indexOf(name);
                if (index < 0) return;
                select.value = String(index);
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }),
        });
    }

    function menu(trigger, title, sections) {
        openActionMenu({
            trigger, title, sections: sections.map(section => Array.isArray(section) ? { items: section } : section),
            onClose: () => { if (menuTrigger === trigger) menuTrigger = null; },
        });
        menuTrigger = isActionMenuOpen(trigger) ? trigger : null;
    }

    function closeOwnedOverlays() {
        picker?.close();
        picker = null;
        if (menuTrigger && isActionMenuOpen(menuTrigger)) closeActionMenu({ animate: false });
        menuTrigger = null;
    }

    function committed(result) {
        if (result.ok) return true;
        globalThis.toastr?.error(t`World Info save failed`);
        return false;
    }

    function openBookMenu(trigger) {
        const action = (label, glyph, id, danger = false) => menuItem(label, glyph, () => clickTransport(id), danger, !state.data);
        menu(trigger, state.name ?? t`World Info`, [
            [menuItem(t`Global Settings`, 'gear', toggleSettings)],
            [menuItem(t`Used By…`, 'link', () => openUsedByPicker(trigger), false, !state.name)],
            [menuItem(t`Select`, 'check-double', () => selection.enter(null, trigger), false, !state.name || !Object.keys(state.data?.entries ?? {}).length)],
            [action(t`Rename World Info`, 'pencil', 'world_popup_name_button'), action(t`Duplicate World Info`, 'copy', 'world_duplicate'), action(t`Export World Info`, 'file-export', 'world_popup_export')],
            [action(t`Batch Import Embedded Lorebooks`, 'cubes-stacked', 'world_batch_import_embedded'), action(t`Fill Empty Memo/Titles With Keywords`, 'notes-medical', 'world_backfill_memos'), action(t`Apply Current Sorting as Order`, 'arrow-down-9-1', 'world_apply_current_sorting'), action(t`Refresh`, 'arrows-rotate', 'world_refresh')],
            [action(t`Delete World Info`, 'trash', 'world_popup_delete', true)],
        ]);
    }

    function openUsedByPicker(trigger) {
        const name = state.name;
        if (!name) return;
        const users = collectWorldInfoUsers(name, characters, world_info.charLore, power_user.personas, power_user.persona_descriptions);
        const relations = { primary: t`Primary Lorebook`, extra: t`Additional Lorebooks`, persona: t`Persona` };
        picker = openPicker({
            trigger,
            title: t`Used By`,
            emptyText: t`No Results`,
            items: users.map(user => ({
                value: user.value, label: user.label,
                icon: user.relation === 'persona' ? 'fa-solid fa-user' : 'fa-solid fa-address-card',
                subtitle: user.relation === 'persona' ? relations.persona
                    : `${relations[user.relation]} · ${t`lorum ipsum`}`, // HUMAN: replace — opens this character's chat.
            })),
            onSelect: value => run(() => {
                if (state.name !== name) return;
                const user = users.find(user => user.value === value);
                if (user) return objectNavigation.navigate(user.target, { from: { kind: 'world-info', id: name } });
            }),
        });
    }

    function openFilterMenu(trigger) {
        const viewButtons = [...worldInfo.querySelectorAll('.world_info_view_filter')];
        const sort = transport('world_info_sort_order');
        const options = [...(sort?.options ?? [])].filter(option => !option.hidden);
        menu(trigger, filterButton.getAttribute('aria-label'), [
            {
                title: t`Show`,
                items: viewButtons.map(control => ({
                    ...menuItem(translate(control.textContent.trim()), 'list', () => control.click()),
                    kind: 'radio',
                    checked: control.classList.contains('is-active'),
                })),
            },
            {
                title: t`Sort By`,
                items: options.map(option => ({
                    ...menuItem(translate(option.textContent.trim()), 'arrow-down-wide-short', () => {
                        sort.value = option.value;
                        sort.dispatchEvent(new Event('change', { bubbles: true }));
                    }),
                    kind: 'radio',
                    checked: option.selected,
                })),
            },
        ]);
    }

    async function setEntryEnabled(uid, enabled) {
        const { name, data } = state;
        heldOrder ??= entries.map(entry => entry.uid);
        const saving = setEnabled(deps, name, data, uid, enabled);
        const result = await saving;
        if (state.data !== data) return;
        for (const target of [uid].flat()) rebase(target, 'disable');
        await finishListMutation(data, result);
    }

    async function finishListMutation(data, result, navigation = navigation_option.previous) {
        if (state.data !== data || destroyed) return;
        if (committed(result)) {
            await refreshWorldInfoEditor(navigation, false);
            return;
        }
        updateDisplayEntries();
        entryController()?.sync({ name: state.name, data });
        shell.refresh();
    }

    async function duplicateEntry(uid) {
        const { name, data } = state;
        if (!(await shell.guardLeave())) return;
        if (state.data !== data) return;
        const result = await duplicate(deps, name, data, uid);
        await finishListMutation(data, result, result.entry?.uid);
    }

    async function deleteEntry(uid) {
        const { name, data } = state;
        if (!(await shell.guardLeave())) return;
        if (state.data !== data) return;
        if (!await Popup.show.confirm(t`Delete world info entry with UID: ${uid}?`, t`This action is irreversible!`, {
            ...confirmVerb(t`Delete`, { destructive: true }),
        })) return;
        if (state.data !== data) return;
        const result = await remove(deps, name, data, uid);
        if (!result.ok || state.data !== data) return finishListMutation(data, result);
        if (String(selectedUid()) === String(uid)) {
            destroyDetail();
            shell.deselectNow();
        }
        await refreshWorldInfoEditor(navigation_option.previous, false);
    }

    function existingSelectedUids(keys = selection.selectedKeys) {
        return keys.filter(uid => state.data?.entries?.[uid]);
    }

    const selectionTitle = count => t`${count} selected`;

    async function bulkAction(action) {
        if (bulkBusy) return;
        const uids = existingSelectedUids();
        if (!uids.length) return;
        bulkBusy = true;
        selectionBar.inert = true;
        selectionBar.setAttribute('aria-busy', 'true');
        try {
            return await action(uids);
        } finally {
            bulkBusy = false;
            selectionBar.inert = false;
            selectionBar.removeAttribute('aria-busy');
        }
    }

    async function deleteSelectedEntries(uids) {
        const { name, data } = state;
        if (!(await shell.guardLeave()) || state.data !== data) return;
        // HUMAN: replace — bulk delete confirmation; the selected count remains explicit.
        if (!await Popup.show.confirm(`${t`lorum ipsum`} (${uids.length})`, t`This action is irreversible!`, {
            ...confirmVerb(t`Delete`, { destructive: true }),
        })) return;
        if (state.data !== data) return;
        const targets = existingSelectedUids(uids);
        const result = await remove(deps, name, data, targets);
        if (!result.ok || state.data !== data) return finishListMutation(data, result);
        if (selectedUid() !== null && !data.entries[selectedUid()]) {
            destroyDetail();
            shell.deselectNow();
        }
        selection.select(existingSelectedUids());
        await refreshWorldInfoEditor(navigation_option.previous, false);
    }

    async function moveEntryBy(uid, direction) {
        if (searchControl.query || !customSort()) return false;
        const ids = entries.map(entry => entry.uid);
        const index = ids.findIndex(value => String(value) === String(uid));
        // An infinite direction (Alt+Home, Alt+End) goes to the first or last place of the whole list, across pages.
        const target = Math.max(0, Math.min(ids.length - 1, index + direction));
        if (index < 0 || target === index) return false;
        ids.splice(target, 0, ...ids.splice(index, 1));
        const previousOrder = heldOrder;
        const submittedOrder = heldOrder ? [...ids] : null;
        heldOrder = submittedOrder;
        const { name, data } = state;
        const saving = reorder(deps, name, data, ids);
        const result = await saving;
        if (state.data !== data) return false;
        if (!result.ok && heldOrder === submittedOrder) heldOrder = previousOrder;
        if (selectedUid() !== null && ids.some(uid => String(uid) === String(selectedUid()))) rebase(selectedUid(), 'displayIndex');
        await finishListMutation(data, result);
        return result.ok;
    }

    /** The moved entry's row, found again by its key because the move builds the list's rows anew; its page is shown first when a long move left it. */
    async function entryRowAfterMove(uid) {
        let row = rows.get(`entry:${uid}`)?.row;
        const page = pageForWorldInfoUid(entries, uid, pagination.pageSize);
        if (!row?.isConnected && page !== pagination.page) {
            internalPaging = true;
            try { await pagination.goTo(page); } finally { internalPaging = false; }
            row = rows.get(`entry:${uid}`)?.row;
        }
        return row?.isConnected ? row : null;
    }

    async function moveEntryByKey(uid, direction) {
        const name = entryTitle(state.data.entries[uid], t`Untitled entry`);
        if (!await moveEntryBy(uid, direction)) return;
        announceReorder({ name, position: entries.findIndex(entry => String(entry.uid) === String(uid)) + 1, count: entries.length });
        (await entryRowAfterMove(uid))?.focus({ preventScroll: true });
    }

    async function openMovePicker(trigger, uid) {
        const source = state.name;
        const uids = [uid].flat();
        if (!(await shell.guardLeave())) return;
        if (source !== state.name) return;
        picker = openPicker({
            trigger,
            title: t`Select Target Lorebook`,
            items: (world_names ?? []).filter(name => name !== source).map(name => ({ value: name, label: name })),
            onSelect: target => run(async () => {
                if (state.name !== source) return;
                const targets = existingSelectedUids(uids);
                if (!targets.length) return;
                const title = targets.length === 1 ? entryTitle(state.data.entries[targets[0]], t`Untitled entry`) : selectionTitle(targets.length);
                const prompt = element('p', '', t`Move/Copy '${title}' to:`);
                prompt.append(element('strong', '', target));
                const popup = new Popup(prompt, POPUP_TYPE.CONFIRM, '', {
                    okButton: false,
                    cancelButton: t`Cancel`,
                    customButtons: [{ text: t`Move`, result: POPUP_RESULT.CUSTOM1 }, { text: t`Copy`, result: POPUP_RESULT.CUSTOM2 }],
                });
                const choice = await popup.show();
                if (![POPUP_RESULT.CUSTOM1, POPUP_RESULT.CUSTOM2].includes(choice) || state.name !== source) return;
                if (!(await shell.guardLeave())) return;
                if (state.name !== source) return;
                const copy = choice === POPUP_RESULT.CUSTOM2;
                // moveWorldInfoEntry already calls reloadEditor for the open affected book.
                const transfer = () => move(deps, source, target, Array.isArray(uid) ? existingSelectedUids(targets) : uid, { copy });
                const result = Array.isArray(uid) ? await bulkAction(transfer) : await transfer();
                if (!result?.ok || state.name !== source) return;
                const affectedDetail = targets.some(target => String(target) === String(selectedUid()));
                const removedDetail = result.moved === targets.length || !state.data?.entries?.[selectedUid()];
                if (!copy && affectedDetail && removedDetail) {
                    destroyDetail();
                    shell.deselectNow();
                }
                if (!copy && selection.isActive) {
                    selection.select(result.moved === targets.length
                        ? selection.selectedKeys.filter(key => !targets.includes(key))
                        : existingSelectedUids());
                }
            }),
        });
    }

    /** The entry's menu as item arrays, shared by its row and the header of its editor. `focus` names where focus goes after a move. */
    function entryMenuSections(trigger, uid, focus = () => rows.get(`entry:${uid}`)?.row ?? null) {
        const entry = state.data.entries[uid];
        if (!entry) return [];
        const title = entryTitle(entry, t`Untitled entry`);
        const actions = [
            menuItem(t`Duplicate`, 'copy', () => duplicateEntry(uid)),
            menuItem(`${t`Move`}/${t`Copy`}`, 'arrows-up-down-left-right', () => openMovePicker(trigger, uid)),
        ];
        const index = entries.findIndex(item => String(item.uid) === String(uid));
        const moves = reorderMenuItems({
            index,
            count: entries.length,
            filtered: !customSort() || Boolean(searchControl.query),
            name: title,
            move: to => moveEntryBy(uid, to - index),
            onError: error => globalThis.toastr?.error(error.message),
            focus,
        });
        return [actions, moves, [menuItem(t`Delete`, 'trash', () => deleteEntry(uid), true)]];
    }

    function openEntryMenu(trigger, uid) {
        const entry = state.data.entries[uid];
        menu(trigger, entryTitle(entry, t`Untitled entry`), entryMenuSections(trigger, uid));
    }

    function makeEntryRow(entry) {
        const title = entryTitle(entry, t`Untitled entry`);
        const enabled = element('input', 'sb-switch');
        enabled.type = 'checkbox';
        enabled.checked = !entry.disable;
        enabled.setAttribute('role', 'switch');
        enabled.setAttribute('aria-label', t`Enable ${title}`);
        enabled.addEventListener('change', () => run(() => setEntryEnabled(entry.uid, enabled.checked)));
        const enableTarget = element('label', 'sb-wi-row-enable');
        enableTarget.append(enabled);
        const more = element('button', 'sb-wi-row-menu ds-entity-row__button');
        more.type = 'button';
        more.setAttribute('aria-label', t`Actions for ${title}`);
        more.title = t`Actions for ${title}`;
        more.append(icon('ellipsis-vertical'));
        more.addEventListener('click', event => {
            event.stopPropagation();
            run(() => openEntryMenu(more, entry.uid));
        });
        more.setAttribute('aria-haspopup', 'menu');
        more.setAttribute('aria-expanded', 'false');
        const strategy = entryStrategy(entry);
        const reorderable = customSort() && !searchControl.query;
        const { row, slots } = createEntityRow({
            key: `entry:${entry.uid}`,
            label: title,
            avatar: icon(strategy === 'constant' ? 'circle-dot' : strategy === 'vectorized' ? 'vector-square' : 'key'),
            // Position·order shares the subtitle so it survives narrow sidebars.
            subtitle: [entryKeyPreview(entry) || '—', entryBadge(entry)].join(' · '),
            grip: reorderable,
            suffix: [enableTarget, more],
            activation: 'activate',
            compatClasses: { row: ['sb-wi-row'], grip: ['sb-wi-grip'], avatar: ['sb-wi-row-icon'] },
            attributes: { 'data-uid': String(entry.uid) },
        });
        if (slots.grip) {
            // A pointer-only handle: the row takes focus and carries the Alt+arrow moves (see the prompt list).
            slots.grip.setAttribute('aria-disabled', 'false');
            slots.grip.title = t`Drag to Reorder ${title}`;
        }
        entryRowRefs.set(row, { enableInput: enabled, inertTargets: [enableTarget, more, slots.grip].filter(Boolean) });
        return row;
    }

    function updateDisplayEntries() {
        const displayEntries = state.data ? getWorldInfoDisplayEntries(state.data) : [];
        const allEntries = Object.values(state.data?.entries ?? {}).filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry));
        entries = heldOrder && state.data ? preserveWorldInfoEntryOrder(heldOrder, displayEntries, allEntries) : displayEntries;
        if (heldOrder) heldOrder = entries.map(entry => entry.uid);
        pagination.setTotal(entries.length);
    }

    function renderList() {
        if (!shell || destroyed) return;
        if (initialized && !preparingReveal && !isOpen()) {
            listDirty = true;
            return;
        }
        if (shell.isNavigating || shell.pointerActive) {
            listDirty = true;
            shell.deferRefresh();
            return;
        }
        listDirty = false;
        listHeader.setTitle(state.name || t`--- Pick to Edit ---`);
        bookLabel.title = state.name || '';
        for (const control of [newEntryButton, searchButton, filterButton]) control.disabled = !state.data;
        const altered = viewAltered(worldInfo);
        filterButton.setAttribute('aria-pressed', String(altered));
        listHeader.setPressed('search', altered);
        listHeader.setSubtitleHidden(!state.data);
        const allEntries = Object.values(state.data?.entries ?? {}).filter(entry => entry && typeof entry === 'object');
        const total = allEntries.length;
        const active = allEntries.filter(entry => !entry.disable).length;
        if (selection?.isActive) selection.select(existingSelectedUids());
        listHeader.setSubtitle(total === 1 ? t`${total} entry · ${active} active` : t`${total} entries · ${active} active`);
        listStatus.hidden = Boolean(state.data && entries.length);
        entriesHeading.hidden = !listStatus.hidden;
        entryBox.hidden = !listStatus.hidden;
        if (!state.data) {
            showStatus(listStatus, {
                state: 'empty', icon: 'book-atlas', title: t`--- Pick to Edit ---`, compact: true,
                actions: [{ label: t`Worlds/Lorebooks`, primary: true, onActivate: () => openBookPicker(bookSwitcher) }],
            });
        } else if (!entries.length) {
            showStatus(listStatus, {
                state: total ? 'no-results' : 'empty',
                icon: total ? 'magnifying-glass' : 'book-open',
                title: total ? t`No Results Found` : t`No Entries`, compact: true,
                description: total ? t`Try a different search` : undefined,
                actions: total ? [] : [{ label: t`New Entry`, primary: true, onActivate: () => run(() => clickTransport('world_popup_new')) }],
            });
        }
        const reorderable = customSort() && !searchControl.query;
        const untitled = t`Untitled entry`;
        const selecting = Boolean(selection?.isActive);
        const selected = String(selectedUid());
        reconcileRows({
            container: entryBox, cache: rows, entries: pagination.slice(entries), key: entry => `entry:${entry.uid}`,
            signature: entry => worldInfoRowSignature(entry, reorderable, untitled),
            create: makeEntryRow,
            update: (row, entry) => {
                row.classList.toggle('is-selected', !selecting && selected === String(entry.uid));
                row.classList.toggle('is-disabled', Boolean(entry.disable));
                const refs = entryRowRefs.get(row);
                if (!refs) return;
                refs.enableInput.checked = !entry.disable;
                for (const control of refs.inertTargets) control.inert = selecting;
            },
        });
        searchControl.report(entries.length, total);
        selection?.decorate();
        sortable = bindSortable(entryBox, {
            handle: '.sb-wi-grip', items: '> .sb-wi-row', disabled: selection?.isActive || !customSort() || Boolean(searchControl.query),
            touch: () => matchMedia(LAYOUT_MOBILE_QUERY).matches,
            start: () => { dragBook = state; },
            update: () => run(async () => {
                if (dragBook !== state) return;
                const ids = [...entryBox.children].map(row => row.dataset.uid);
                const previousOrder = heldOrder;
                if (heldOrder) {
                    const pageIds = new Set(pagination.slice(entries).map(entry => String(entry.uid)));
                    let next = 0;
                    heldOrder = heldOrder.map(uid => pageIds.has(String(uid)) ? ids[next++] : uid);
                }
                const submittedOrder = heldOrder;
                const { name, data } = state;
                const saving = reorder(deps, name, data, ids);
                const result = await saving;
                if (state.data !== data) return;
                if (!result.ok && heldOrder === submittedOrder) heldOrder = previousOrder;
                if (selectedUid() !== null) rebase(selectedUid(), 'displayIndex');
                await finishListMutation(data, result);
            }),
            stop: () => requestAnimationFrame(() => shell.flushRefresh()),
        });
    }

    function renderDetail(detail, item) {
        destroyDetail();
        controllerKind = item.kind;
        if (item.kind === 'settings') {
            activeController = mountWorldInfoSettings({ host: detail, onClose: () => shell.deselectItem() });
            return;
        }
        activeController = mountWorldInfoEntry({
            host: detail, name: state.name, data: state.data, uid: item.uid, deps,
            requestClose: () => shell.deselectItem(),
            // The header menu offers what the entry's row menu does.
            actions: { sections: trigger => entryMenuSections(trigger, item.uid, () => trigger).map(items => ({ items })) },
            // "Save as new entry" commits under a new UID; navigating to it reselects the replacement.
            onSaved: ({ uid } = {}) => run(() => refreshWorldInfoEditor(uid !== undefined && uid !== item.uid ? uid : navigation_option.previous, false)),
            onStateChange: ({ dirty, saving }) => {
                shell.root.dataset.dirty = String(dirty);
                shell.root.dataset.saving = String(saving);
            },
        });
    }

    shell = createListEditor({
        container: host, storageKey: 'sb-wi-list-width', rootTag: 'section', label: t`World Info`, escapeCloses: false,
        classNames: { root: 'sb-wi-editor', sidebar: 'sb-wi-list', divider: 'sb-wi-divider', detail: 'sb-wi-detail' },
        dragHandleSelector: '.sb-wi-grip[aria-disabled="false"]',
        renderList, renderDetail, getKey: itemKey,
        isDirty: () => entryController()?.isDirty() ?? false,
        onSave: () => entryController()?.save() ?? true,
        onDiscard: () => entryController()?.discard(),
        onDeselect: () => destroyDetail(),
        onSelect: () => renderList(),
        findRow: key => key === 'settings' ? bookActions : rows.get(key)?.row ?? null,
        focusTarget: () => activeController?.focusTarget() ?? null,
    });
    shell.root.hidden = true;
    listContent.append(listHeader.element, selectionHeader, searchField, listBody, pagination.element, selectionBar);
    shell.sidebar.append(listContent, searchStatus);
    selection = createSelectionMode({
        root: shell.root, list: entryBox, header: selectionHeader, actionBar: selectionBar,
        rowSelector: '.sb-wi-row', getKey: row => row.dataset.uid, keySourceSelector: '.sb-wi-grip',
        canEnter: () => Boolean(state.name && Object.keys(state.data?.entries ?? {}).length),
        title: selectionTitle, selectAllLabel: t`Select All`, iconOnlyAtNarrow: true,
        actions: [
            { id: 'enable', label: t`Enable`, icon: 'fa-solid fa-toggle-on', onActivate: () => run(() => bulkAction(uids => setEntryEnabled(uids, true))) },
            { id: 'disable', label: t`Disable`, icon: 'fa-solid fa-toggle-off', onActivate: () => run(() => bulkAction(uids => setEntryEnabled(uids, false))) },
            { id: 'move', label: `${t`Move`}/${t`Copy`}`, icon: 'fa-solid fa-arrows-up-down-left-right', onActivate: () => run(() => bulkAction(uids => openMovePicker(selectionBar.querySelector('[data-action-id="move"]'), uids))) },
            { id: 'delete', label: t`Delete`, icon: 'fa-solid fa-trash', danger: true, onActivate: () => run(() => bulkAction(deleteSelectedEntries)) },
        ],
        onChange: () => renderList(), onExit: () => renderList(),
    });
    const unbindRows = bindListKeyboard(listBody, {
        rowSelector: '.sb-wi-row', keySourceSelector: '.sb-wi-grip',
        ignoreSelector: 'button, input, select, textarea, a, label, [role="switch"], [role="button"]',
        onOpen: row => {
            if (selection.isActive) return;
            run(() => shell.selectItem({ kind: 'entry', uid: rowEntry(row).uid }));
        },
        onMove: (row, direction) => {
            if (selection.isActive || !customSort() || searchControl.query) return false;
            run(() => moveEntryByKey(rowEntry(row).uid, direction));
        },
    });
    const onEscape = event => {
        if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
        if (isPickerOpen() || isActionMenuOpen() || document.querySelector('dialog.popup[open]')) return;
        event.stopPropagation();
        if (shell.isOpen) {
            event.preventDefault();
            run(() => shell.deselectItem());
        }
    };
    shell.root.addEventListener('keydown', onEscape);
    // Capture before the upstream transport handlers synchronously begin their refresh.
    const onTransportChange = event => {
        if (event.target instanceof Element && event.target.matches('#world_info_sort_order, #world_editor_select')) heldOrder = null;
    };
    const onTransportClick = event => {
        if (event.target instanceof Element && event.target.closest('.world_info_view_filter, #world_refresh, #world_apply_current_sorting')) heldOrder = null;
    };
    worldInfo.addEventListener('change', onTransportChange, true);
    worldInfo.addEventListener('click', onTransportClick, true);
    const onBookRenamed = (oldName, newName) => updateBookDrafts(oldName, newName);
    const onBookDeleted = name => updateBookDrafts(name);
    eventSource.on(event_types.WORLDINFO_RENAMED, onBookRenamed);
    eventSource.on(event_types.WORLDINFO_DELETED, onBookDeleted);
    const unregister = registerEditorNavigation({
        session: {
            isOpen: () => Boolean(entryController()), isDirty: () => entryController()?.isDirty() ?? false,
            save: () => entryController()?.save() ?? true, discard: () => entryController()?.discard(),
            // The entry controller owns its pagehide backup listener and draft timer.
            flushDraft: () => {},
        },
        isActive: () => !shell.root.hidden && !worldInfo.closest('[hidden], [aria-hidden="true"]'),
        close: () => run(() => shell.deselectItem()),
        guardSelector: characterTabGuardSelector('world-info'), escape: false,
    });

    function isOpen() {
        return !destroyed && !shell.root.hidden && !worldInfo.closest('[hidden], [aria-hidden="true"]');
    }

    async function renderBook({ name, data, navigation = navigation_option.none }) {
        if (destroyed) return;
        if (initialized && !preparingReveal && !isOpen()) {
            pendingBook = { name, data, navigation };
            return;
        }
        const revision = ++renderRevision;
        const changedBook = renderedName !== undefined && renderedName !== name;
        if (changedBook || state.data !== data) heldOrder = null;
        if (changedBook) {
            selection.exit();
            closeOwnedOverlays();
            if (controllerKind === 'entry') {
                destroyDetail({ keepDraft: entryController()?.isDirty() ?? false });
                shell.deselectNow();
            }
            searchControl.setQuery('', { notify: false });
            if (transport('world_info_search')) transport('world_info_search').value = '';
            worldInfoFilter.setFilterData(FILTER_TYPES.WORLD_INFO_SEARCH, '', true);
            const sort = transport('world_info_sort_order');
            const searchOption = sort?.querySelector('option[data-rule="search"]');
            if (searchOption) {
                // Renames can reach this adapter without the legacy book-switch search reset.
                searchOption.hidden = true;
                if (searchOption.selected) sort.value = accountStorage.getItem(SORT_ORDER_KEY) || '0';
            }
        }
        state = { name, data };
        renderedName = name;
        updateDisplayEntries();
        entryController()?.sync({ name, data });
        // A newly created entry can be excluded by the current search/view filter; still open it.
        const target = Number.isFinite(navigation) && navigation >= 0 ? data?.entries?.[navigation] : null;
        const previousPage = pagination.page;
        const page = navigation === navigation_option.previous ? pagination.page
            : pageForWorldInfoUid(entries, target?.uid ?? selectedUid(), pagination.pageSize);
        if (page !== pagination.page) {
            internalPaging = true;
            try { await pagination.goTo(page); } finally { internalPaging = false; }
        }
        if (revision !== renderRevision || destroyed) return;
        if (target && !(await shell.selectItem({ kind: 'entry', uid: target.uid })) && revision === renderRevision && !destroyed) {
            internalPaging = true;
            try { await pagination.goTo(previousPage); } finally { internalPaging = false; }
        }
        if (revision !== renderRevision || destroyed) return;
        if (!data && controllerKind === 'entry') { destroyDetail(); shell.deselectNow(); }
        shell.refresh();
        shownRevision = revision;
    }

    const adapter = {
        render: renderBook,
        isOpen: () => !initialized || preparingReveal || isOpen(),
        captureState: () => controller.captureState(),
        restoreState: (snapshot, isCurrent) => controller.restoreState(snapshot, isCurrent),
    };

    const controller = {
        ready: null,
        async prepareReveal() {
            if (destroyed || !pendingBook && !listDirty) return;
            preparingReveal = true;
            try {
                if (pendingBook) {
                    const { navigation } = pendingBook;
                    pendingBook = null;
                    await refreshWorldInfoEditor(navigation, false);
                }
                if (listDirty) shell.refresh();
            } finally { preparingReveal = false; }
        },
        onReveal: () => shell.layout(),
        get renderRevision() { return renderRevision; },
        current: () => state.name ? { kind: 'world-info', id: state.name } : null,
        whenBookShown(name, { isCurrent = () => true, timeout = 5000, afterRender = -1 } = {}) {
            const deadline = Date.now() + timeout;
            return new Promise(resolve => {
                const check = () => {
                    if (destroyed || !isCurrent()) return resolve(false);
                    const visible = !shell.root.hidden && !worldInfo.closest('[hidden], [aria-hidden="true"]');
                    const rendered = shownRevision > afterRender && shownRevision === renderRevision;
                    if (visible && rendered && state.name === name && state.data && bookLabel.textContent === name) return resolve(true);
                    if (Date.now() >= deadline) return resolve(false);
                    setTimeout(check, 50);
                };
                check();
            });
        },
        captureState: () => ({ name: state.name, query: searchControl.query, searchOpen: searchControl.isOpen, page: pagination.page, scrollTop: listBody.scrollTop }),
        async restoreState(snapshot, isCurrent = () => true) {
            if (!snapshot || destroyed || !isCurrent() || snapshot.name !== state.name) return false;
            searchControl.setQuery(snapshot.query, { notify: false });
            searchField.hidden = !snapshot.searchOpen;
            searchButton.setAttribute('aria-expanded', String(snapshot.searchOpen));
            if (transport('world_info_search')) transport('world_info_search').value = snapshot.query;
            worldInfoFilter.setFilterData(FILTER_TYPES.WORLD_INFO_SEARCH, snapshot.query, true);
            heldOrder = null;
            updateDisplayEntries();
            await pagination.goTo(snapshot.page);
            if (destroyed || !isCurrent()) return false;
            renderList();
            listBody.scrollTop = snapshot.scrollTop;
            return true;
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            renderRevision++;
            closeOwnedOverlays();
            destroyDetail({ keepDraft: entryController()?.isDirty() ?? false });
            setWorldInfoEditorAdapter(null);
            unregister();
            eventSource.removeListener(event_types.WORLDINFO_RENAMED, onBookRenamed);
            eventSource.removeListener(event_types.WORLDINFO_DELETED, onBookDeleted);
            shell.root.removeEventListener('keydown', onEscape);
            worldInfo.removeEventListener('change', onTransportChange, true);
            worldInfo.removeEventListener('click', onTransportClick, true);
            unbindRows();
            filterButton.removeEventListener('click', onSortClick);
            listHeader.destroy();
            searchControl.destroy();
            selection.destroy();
            pagination.destroy();
            sortable?.destroy();
            shell.destroy();
            worldInfo.classList.remove('sb-wi-editor-mounted');
            mountedEditors.delete(container);
        },
    };
    mountedEditors.set(container, controller);
    controller.ready = Promise.all([
        Promise.resolve().then(() => { if (!destroyed) return setWorldInfoEditorAdapter(adapter); }),
        loadListEditorStyles(),
        ...STYLESHEETS.map(({ href, id }) => globalThis.SillyBunnyAssets?.loadStylesheetAsync?.(href, { id }) ?? Promise.resolve()),
    ]).then(() => {
        if (destroyed) return;
        worldInfo.classList.add('sb-wi-editor-mounted');
        shell.root.hidden = false;
        initialized = true;
        shell.scheduleLayout();
        renderList();
    }).catch(error => {
        controller.destroy();
        throw error;
    });
    controller.ready.catch(error => globalThis.toastr?.error(error.message));
    return controller;
}
