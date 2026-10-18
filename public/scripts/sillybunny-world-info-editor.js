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
import { openActionMenu, closeActionMenu, isActionMenuOpen } from './sillybunny-action-menu.js';
import { createListEditor, loadListEditorStyles } from './sillybunny-editor/list-shell.js';
import { reconcileRows, rowEntry, bindListKeyboard, bindSortable } from './sillybunny-editor/list-rows.js';
import { createListSearch } from './sillybunny-editor/list-search.js';
import { createListPagination } from './sillybunny-editor/list-pagination.js';
import { createSelectionMode } from './sillybunny-editor/selection-mode.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { createRow } from './sillybunny-editor/rows.js';
import { openPicker, isPickerOpen } from './sillybunny-editor/picker.js';
import { characterTabGuardSelector, registerEditorNavigation } from './sillybunny-editor/navigation.js';
import { objectNavigation } from './sillybunny-editor/object-navigation.js';
import {
    duplicate, move, remove, reorder, setEnabled, entryBadge, entryKeyPreview, entryStrategy, entryTitle,
} from './sillybunny-world-info-model.js';
import { mountWorldInfoSettings } from './sillybunny-world-info-settings.js';
import { mountWorldInfoEntry, worldInfoDraftKey } from './sillybunny-world-info-entry.js';

const STYLESHEET = { href: 'css/sillybunny-world-info-editor.css?v=20261018e', id: 'deferred-world-info-editor-css' };
const mountedEditors = new WeakMap();
const itemKey = item => item.kind === 'settings' ? 'settings' : `entry:${item.uid}`;

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

function button(label, glyph, action, className = '') {
    const node = element('button', `menu_button ${glyph ? 'menu_button_icon' : ''} ${className}`);
    node.type = 'button';
    node.setAttribute('aria-label', label);
    node.title = label;
    if (glyph) node.append(icon(glyph));
    else node.textContent = label;
    node.addEventListener('click', event => {
        event.stopPropagation();
        run(() => action(node));
    });
    return node;
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

    const listHeader = element('header', 'sb-wi-list-header');
    const bookSwitcher = button(t`Worlds/Lorebooks`, null, trigger => openBookPicker(trigger), 'sb-wi-book-switcher');
    const bookTitles = element('span', 'sb-wi-list-titles');
    const bookLabel = element('span', 'sb-wi-book-name');
    const bookSubtitle = element('span', 'sb-wi-list-subtitle');
    bookTitles.append(bookLabel, bookSubtitle);
    bookSwitcher.replaceChildren(bookTitles, icon('chevron-down'));
    bookSwitcher.setAttribute('aria-haspopup', 'dialog');
    bookSwitcher.setAttribute('aria-expanded', 'false');
    const headerSpacer = element('span', 'sb-wi-list-header-spacer');
    headerSpacer.setAttribute('aria-hidden', 'true');
    const bookActions = button(t`World Info`, 'ellipsis-vertical', trigger => openBookMenu(trigger), 'sb-wi-book-actions');
    bookActions.setAttribute('aria-haspopup', 'menu');
    bookActions.setAttribute('aria-expanded', 'false');
    const toggleSettings = () => shell.selectedKey === 'settings' ? shell.deselectItem() : shell.selectItem({ kind: 'settings' });
    const newEntryButton = button(t`New Entry`, 'plus', () => clickTransport('world_popup_new'));
    const searchButton = button(t`Search`, 'magnifying-glass', () => searchControl.toggle());
    // HUMAN: replace — Sort control label.
    const filterButton = button(t`lorum ipsum`, 'arrow-down-wide-short', trigger => openFilterMenu(trigger), 'sb-wi-sort-button');
    filterButton.setAttribute('aria-haspopup', 'menu');
    filterButton.setAttribute('aria-expanded', 'false');
    listHeader.append(bookSwitcher, headerSpacer, searchButton, newEntryButton, filterButton, bookActions);
    const selectionHeader = element('header', 'sb-wi-selection-header');
    const selectionBar = element('div', 'sb-wi-selection-bar');
    const searchField = element('label', 'sb-wi-search-field');
    searchField.hidden = true;
    const searchInput = element('input', 'sb-wi-search');
    searchInput.type = 'search';
    searchInput.value = transport('world_info_search')?.value ?? '';
    searchInput.placeholder = t`Search...`;
    searchInput.setAttribute('aria-label', t`Search`);
    searchField.append(icon('magnifying-glass'), searchInput);

    const listBody = element('div', 'sb-wi-list-body');
    const entriesHeading = element('h3', 'sb-wi-list-heading', t`Lorebook entries`);
    entriesHeading.tabIndex = -1;
    const entryBox = element('div', 'sb-wi-list-box ds-pref-group');
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
        heightProperty: '--sb-wi-search-height',
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
        globalThis.toastr?.error(t`World Info Save Failed`);
        return false;
    }

    function openBookMenu(trigger) {
        const action = (label, glyph, id, danger = false) => menuItem(label, glyph, () => clickTransport(id), danger, !state.data);
        menu(trigger, state.name ?? t`World Info`, [
            [menuItem(t`Global Settings`, 'gear', toggleSettings)],
            [menuItem(t`lorum ipsum`, 'link', () => openUsedByPicker(trigger), false, !state.name)], // HUMAN: replace — Used by book action.
            [menuItem(t`Select`, 'check-double', () => selection.enter(null, trigger), false, !state.name || !Object.keys(state.data?.entries ?? {}).length)],
            [action(t`Rename World Info`, 'pencil', 'world_popup_name_button'), action(t`Duplicate World Info`, 'copy', 'world_duplicate'), action(t`Export World Info`, 'file-export', 'world_popup_export')],
            [action(t`Batch Import Embedded Lorebooks`, 'cubes-stacked', 'world_batch_import_embedded'), action(t`Fill empty Memo/Titles with Keywords`, 'notes-medical', 'world_backfill_memos'), action(t`Apply current sorting as Order`, 'arrow-down-9-1', 'world_apply_current_sorting'), action(t`Refresh`, 'arrows-rotate', 'world_refresh')],
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
            title: t`lorum ipsum`, // HUMAN: replace — Used by picker title.
            emptyText: t`No results`,
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
                // HUMAN: replace — Show section title.
                title: t`lorum ipsum`,
                items: viewButtons.map(control => ({
                    ...menuItem(translate(control.textContent.trim()), control.classList.contains('is-active') ? 'check' : 'circle', () => control.click()),
                    checked: control.classList.contains('is-active'),
                })),
            },
            {
                // HUMAN: replace — Sort by section title.
                title: t`lorum ipsum`,
                items: options.map(option => ({
                    ...menuItem(translate(option.textContent.trim()), option.selected ? 'check' : 'circle', () => {
                        sort.value = option.value;
                        sort.dispatchEvent(new Event('change', { bubbles: true }));
                    }),
                    checked: option.selected,
                })),
            },
        ]);
    }

    async function setEntryEnabled(uid, enabled) {
        const { name, data } = state;
        heldOrder ??= entries.map(entry => entry.uid);
        const saving = setEnabled(deps, name, data, uid, enabled);
        for (const target of [uid].flat()) rebase(target, 'disable');
        const result = await saving;
        if (state.data !== data) return;
        if (committed(result)) await refreshWorldInfoEditor(navigation_option.previous, false);
    }

    async function duplicateEntry(uid) {
        const { name, data } = state;
        if (!(await shell.guardLeave())) return;
        if (state.data !== data) return;
        const result = await duplicate(deps, name, data, uid);
        if (committed(result) && state.data === data) await refreshWorldInfoEditor(result.entry.uid, false);
    }

    async function deleteEntry(uid) {
        const { name, data } = state;
        if (!(await shell.guardLeave())) return;
        if (state.data !== data) return;
        if (!await Popup.show.confirm(t`Delete world info entry with UID: ${uid}?`, t`This action is irreversible!`)) return;
        if (state.data !== data) return;
        const result = await remove(deps, name, data, uid);
        if (!committed(result) || state.data !== data) return;
        if (String(selectedUid()) === String(uid)) {
            destroyDetail();
            shell.deselectNow();
        }
        await refreshWorldInfoEditor(navigation_option.previous, false);
    }

    function existingSelectedUids(keys = selection.selectedKeys) {
        return keys.filter(uid => state.data?.entries?.[uid]);
    }

    // HUMAN: replace — selection count label; no matching count key exists in the locale.
    const selectionTitle = count => `${count} ${t`lorum ipsum`}`;

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
        if (!await Popup.show.confirm(`${t`lorum ipsum`} (${uids.length})`, t`This action is irreversible!`)) return;
        if (state.data !== data) return;
        const targets = existingSelectedUids(uids);
        const result = await remove(deps, name, data, targets);
        if (!committed(result) || state.data !== data) return;
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
        const target = index + direction;
        if (index < 0 || target < 0 || target >= ids.length) return false;
        [ids[index], ids[target]] = [ids[target], ids[index]];
        if (heldOrder) heldOrder = [...ids];
        const { name, data } = state;
        const saving = reorder(deps, name, data, ids);
        rebase(uid, 'displayIndex');
        const result = await saving;
        if (committed(result) && state.data === data) await refreshWorldInfoEditor(navigation_option.previous, false);
        return true;
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
                    cancelButton: t`Cancel`,
                    customButtons: [{ text: t`Move`, result: POPUP_RESULT.CUSTOM1 }, { text: t`Copy`, result: POPUP_RESULT.CUSTOM2 }],
                });
                popup.okButton.hidden = true;
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

    function openEntryMenu(trigger, uid) {
        const entry = state.data.entries[uid];
        const actions = [
            menuItem(t`Duplicate`, 'copy', () => duplicateEntry(uid)),
            menuItem(`${t`Move`}/${t`Copy`}`, 'arrows-up-down-left-right', () => openMovePicker(trigger, uid)),
        ];
        if (customSort() && !searchControl.query) actions.push(
            menuItem(t`Move up`, 'arrow-up', () => moveEntryBy(uid, -1)),
            menuItem(t`Move down`, 'arrow-down', () => moveEntryBy(uid, 1)),
        );
        menu(trigger, entryTitle(entry, t`Untitled entry`), [actions, [menuItem(t`Delete`, 'trash', () => deleteEntry(uid), true)]]);
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
        const more = button(t`Actions for ${title}`, 'ellipsis-vertical', trigger => openEntryMenu(trigger, entry.uid), 'sb-wi-row-menu');
        more.setAttribute('aria-haspopup', 'menu');
        more.setAttribute('aria-expanded', 'false');
        const strategy = entryStrategy(entry);
        const row = createRow({
            label: title,
            // Position·order shares the subtitle so it survives narrow sidebars.
            subtitle: [entryKeyPreview(entry) || '—', entryBadge(entry)].join(' · '),
            field: `entry:${entry.uid}`,
            prefix: icon(strategy === 'constant' ? 'circle-dot' : strategy === 'vectorized' ? 'vector-square' : 'key'),
            suffix: [enableTarget, more],
        }).row;
        row.classList.add('sb-wi-row');
        row.dataset.uid = String(entry.uid);
        row.tabIndex = 0;
        row.setAttribute('role', 'listitem');
        row.setAttribute('aria-label', title);
        if (customSort() && !searchControl.query) {
            const grip = element('div', 'sb-wi-grip menu_button menu_button_icon');
            grip.setAttribute('role', 'button');
            grip.setAttribute('aria-disabled', 'false');
            grip.setAttribute('aria-label', t`Drag to reorder ${title}`);
            grip.append(icon('grip-vertical'));
            row.prepend(grip);
        }
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
        bookLabel.textContent = state.name || t`--- Pick to Edit ---`;
        for (const control of [newEntryButton, searchButton, filterButton]) control.disabled = !state.data;
        bookSubtitle.hidden = !state.data;
        const allEntries = Object.values(state.data?.entries ?? {}).filter(entry => entry && typeof entry === 'object');
        const total = allEntries.length;
        const active = allEntries.filter(entry => !entry.disable).length;
        if (selection?.isActive) selection.select(existingSelectedUids());
        // HUMAN: replace — entry-count and active-count subtitle labels.
        bookSubtitle.textContent = `${total} ${t`lorum ipsum`} · ${active} ${t`lorum ipsum`}`;
        listStatus.hidden = Boolean(state.data && entries.length);
        entriesHeading.hidden = !listStatus.hidden;
        entryBox.hidden = !listStatus.hidden;
        if (!state.data) {
            showStatus(listStatus, {
                icon: 'book-atlas', title: t`--- Pick to Edit ---`, compact: true,
                actions: [
                    { label: t`Worlds/Lorebooks`, primary: true, onActivate: () => openBookPicker(bookSwitcher) },
                    { label: t`New`, onActivate: () => run(() => clickTransport('world_create_button')) },
                    { label: t`Global Settings`, onActivate: () => run(toggleSettings) },
                ],
            });
        } else if (!entries.length) {
            // HUMAN: replace — empty-book title; a filtered nonempty book instead shows No results.
            showStatus(listStatus, {
                icon: total ? 'magnifying-glass' : 'book-open',
                title: total ? t`No results` : t`lorum ipsum`, compact: true,
                actions: total ? [] : [{ label: t`New Entry`, primary: true, onActivate: () => run(() => clickTransport('world_popup_new')) }],
            });
        }
        reconcileRows({
            container: entryBox, cache: rows, entries: pagination.slice(entries), key: entry => `entry:${entry.uid}`,
            signature: entry => JSON.stringify([entry, customSort(), Boolean(searchControl.query)]),
            create: makeEntryRow,
            update: (row, entry) => {
                row.classList.toggle('is-selected', !selection?.isActive && String(selectedUid()) === String(entry.uid));
                row.classList.toggle('is-disabled', Boolean(entry.disable));
                for (const control of row.querySelectorAll('.sb-wi-row-enable, .sb-wi-row-menu, .sb-wi-grip')) control.inert = Boolean(selection?.isActive);
            },
        });
        searchControl.report(entries.length, total);
        selection?.decorate();
        sortable = bindSortable(entryBox, {
            handle: '.sb-wi-grip', items: '> .sb-wi-row', disabled: selection?.isActive || !customSort() || Boolean(searchControl.query),
            touch: () => matchMedia('(max-width: 768px)').matches,
            start: () => { dragBook = state; },
            update: () => run(async () => {
                if (dragBook !== state) return;
                const ids = [...entryBox.children].map(row => row.dataset.uid);
                if (heldOrder) {
                    const pageIds = new Set(pagination.slice(entries).map(entry => String(entry.uid)));
                    let next = 0;
                    heldOrder = heldOrder.map(uid => pageIds.has(String(uid)) ? ids[next++] : uid);
                }
                const { name, data } = state;
                const saving = reorder(deps, name, data, ids);
                if (selectedUid() !== null) rebase(selectedUid(), 'displayIndex');
                const result = await saving;
                if (committed(result) && state.data === data) await refreshWorldInfoEditor(navigation_option.previous, false);
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
    listContent.append(listHeader, selectionHeader, searchField, listBody, pagination.element, selectionBar);
    shell.sidebar.append(listContent, searchStatus);
    selection = createSelectionMode({
        root: shell.root, list: entryBox, header: selectionHeader, actionBar: selectionBar,
        rowSelector: '.sb-wi-row', getKey: row => row.dataset.uid, keySourceSelector: '.sb-wi-grip',
        canEnter: () => Boolean(state.name && Object.keys(state.data?.entries ?? {}).length),
        title: selectionTitle, selectAllLabel: t`Select All`,
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
            run(() => moveEntryBy(rowEntry(row).uid, direction));
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
        isActive: () => !shell.root.hidden && !worldInfo.closest('[hidden], [aria-hidden="true"], [inert]'),
        close: () => run(() => shell.deselectItem()),
        guardSelector: characterTabGuardSelector('world-info'), escape: false,
    });

    function isOpen() {
        return !destroyed && !shell.root.hidden && !worldInfo.closest('[hidden], [aria-hidden="true"], [inert]');
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
                    const visible = !shell.root.hidden && !worldInfo.closest('[hidden], [aria-hidden="true"], [inert]');
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
        globalThis.SillyBunnyAssets?.loadStylesheetAsync?.(STYLESHEET.href, { id: STYLESHEET.id }) ?? Promise.resolve(),
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
