import {
    createWorldInfoEntry, deleteWIOriginalDataValue, deleteWorldInfoEntry, duplicateWorldInfoEntry,
    getWorldInfoDisplayEntries, getWorldInfoEditorState, moveWorldInfoEntry, refreshWorldInfoEditor,
    saveWorldInfo, setWIOriginalDataValue, setWorldInfoEditorAdapter, SORT_ORDER_KEY, worldInfoFilter, world_names,
} from './world-info.js';
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
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { createRow } from './sillybunny-editor/rows.js';
import { openPicker, isPickerOpen } from './sillybunny-editor/picker.js';
import { characterTabGuardSelector, registerEditorNavigation } from './sillybunny-editor/navigation.js';
import {
    duplicate, move, remove, reorder, setEnabled, entryBadge, entryKeyPreview, entryStrategy, entryTitle,
} from './sillybunny-world-info-model.js';
import { mountWorldInfoSettings } from './sillybunny-world-info-settings.js';
import { mountWorldInfoEntry, worldInfoDraftKey } from './sillybunny-world-info-entry.js';

const STYLESHEET = { href: 'css/sillybunny-world-info-editor.css?v=20261017g', id: 'deferred-world-info-editor-css' };
const mountedEditors = new WeakMap();
const itemKey = item => item.kind === 'settings' ? 'settings' : `entry:${item.uid}`;

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

function menuItem(label, glyph, action, danger = false) {
    return { label, icon: `fa-solid fa-${glyph}`, danger, onSelect: () => run(action) };
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
    let internalPaging = false;
    let renderRevision = 0;
    let dragBook = null;

    const listHeader = element('header', 'sb-wi-list-header');
    const bookSwitcher = button(t`Worlds/Lorebooks`, null, trigger => openBookPicker(trigger), 'sb-wi-book-switcher');
    const bookTitles = element('span', 'sb-wi-list-titles');
    const bookLabel = element('span', 'sb-wi-book-name');
    const bookSubtitle = element('span', 'sb-wi-list-subtitle');
    bookTitles.append(bookLabel, bookSubtitle);
    bookSwitcher.replaceChildren(bookTitles, icon('chevron-down'));
    bookSwitcher.setAttribute('aria-haspopup', 'dialog');
    bookSwitcher.setAttribute('aria-expanded', 'false');
    const bookActions = button(t`World Info`, 'ellipsis-vertical', trigger => openBookMenu(trigger));
    bookActions.setAttribute('aria-haspopup', 'menu');
    bookActions.setAttribute('aria-expanded', 'false');
    const toggleSettings = () => shell.selectedKey === 'settings' ? shell.deselectItem() : shell.selectItem({ kind: 'settings' });
    const settingsButton = button(t`Global Settings`, 'gear', toggleSettings, 'sb-wi-settings-button');
    settingsButton.setAttribute('aria-pressed', 'false');
    const newEntryButton = button(t`New Entry`, 'plus', () => clickTransport('world_popup_new'));
    const searchButton = button(t`Search`, 'magnifying-glass', () => searchControl.toggle());
    // HUMAN: replace — Sort control label.
    const filterButton = button(t`lorum ipsum`, 'arrow-down-wide-short', trigger => openFilterMenu(trigger), 'sb-wi-sort-button');
    filterButton.setAttribute('aria-haspopup', 'menu');
    filterButton.setAttribute('aria-expanded', 'false');
    listHeader.append(bookSwitcher, searchButton, newEntryButton, filterButton, settingsButton, bookActions);
    const searchField = element('label', 'sb-wi-search-field');
    searchField.hidden = true;
    const searchInput = element('input', 'sb-wi-search');
    searchInput.type = 'search';
    searchInput.value = transport('world_info_search')?.value ?? '';
    searchInput.placeholder = t`Search...`;
    searchInput.setAttribute('aria-label', t`Search`);
    searchField.append(icon('magnifying-glass'), searchInput);

    const listBody = element('div', 'sb-wi-list-body');
    const entryBox = element('div', 'sb-wi-list-box ds-pref-group');
    entryBox.setAttribute('role', 'list');
    const listStatus = element('div', 'sb-wi-list-status');
    listBody.append(entryBox, listStatus);

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
            if (transport('world_info_search')) transport('world_info_search').value = query;
            worldInfoFilter.setFilterData(FILTER_TYPES.WORLD_INFO_SEARCH, query);
        },
    });
    const pagination = createListPagination({
        pageSizes: [10, 25, 50, 100, 500, 1000],
        readPageSize: () => accountStorage.getItem('WI_PerPage'),
        writePageSize: size => accountStorage.setItem('WI_PerPage', String(size)),
        guard: () => internalPaging || shell.guardLeave(),
        onChange: () => renderList(),
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
        const action = (label, glyph, id, danger = false) => menuItem(label, glyph, () => clickTransport(id), danger);
        // A narrow sidebar hides the gear button (CSS); Global Settings moves into this menu.
        const settingsItem = getComputedStyle(settingsButton).display === 'none'
            ? [menuItem(t`Global Settings`, 'gear', toggleSettings)] : [];
        menu(trigger, state.name ?? t`World Info`, [
            ...(settingsItem.length ? [settingsItem] : []),
            [action(t`Rename World Info`, 'pencil', 'world_popup_name_button'), action(t`Duplicate World Info`, 'copy', 'world_duplicate'), action(t`Export World Info`, 'file-export', 'world_popup_export')],
            [action(t`Batch Import Embedded Lorebooks`, 'cubes-stacked', 'world_batch_import_embedded'), action(t`Fill empty Memo/Titles with Keywords`, 'notes-medical', 'world_backfill_memos'), action(t`Apply current sorting as Order`, 'arrow-down-9-1', 'world_apply_current_sorting'), action(t`Refresh`, 'arrows-rotate', 'world_refresh')],
            [action(t`Delete World Info`, 'trash', 'world_popup_delete', true)],
        ]);
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
        const saving = setEnabled(deps, name, data, uid, enabled);
        rebase(uid, 'disable');
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

    async function moveEntryBy(uid, direction) {
        if (searchControl.query || !customSort()) return false;
        const ids = entries.map(entry => entry.uid);
        const index = ids.findIndex(value => String(value) === String(uid));
        const target = index + direction;
        if (index < 0 || target < 0 || target >= ids.length) return false;
        [ids[index], ids[target]] = [ids[target], ids[index]];
        const { name, data } = state;
        const saving = reorder(deps, name, data, ids);
        rebase(uid, 'displayIndex');
        const result = await saving;
        if (committed(result) && state.data === data) await refreshWorldInfoEditor(navigation_option.previous, false);
        return true;
    }

    async function openMovePicker(trigger, uid) {
        const source = state.name;
        if (!(await shell.guardLeave())) return;
        if (source !== state.name) return;
        picker = openPicker({
            trigger,
            title: t`Select Target Lorebook`,
            items: (world_names ?? []).filter(name => name !== source).map(name => ({ value: name, label: name })),
            onSelect: target => run(async () => {
                if (state.name !== source || !state.data?.entries?.[uid]) return;
                const prompt = element('p', '', t`Move/Copy '${entryTitle(state.data.entries[uid], t`Untitled entry`)}' to:`);
                prompt.append(element('strong', '', target));
                const popup = new Popup(prompt, POPUP_TYPE.CONFIRM, '', {
                    cancelButton: t`Cancel`,
                    customButtons: [{ text: t`Move`, result: POPUP_RESULT.CUSTOM1 }, { text: t`Copy`, result: POPUP_RESULT.CUSTOM2 }],
                });
                popup.okButton.hidden = true;
                const choice = await popup.show();
                if (![POPUP_RESULT.CUSTOM1, POPUP_RESULT.CUSTOM2].includes(choice) || state.name !== source) return;
                if (!(await shell.guardLeave())) return;
                // moveWorldInfoEntry already calls reloadEditor for the open affected book.
                await move(deps, source, target, uid, { copy: choice === POPUP_RESULT.CUSTOM2 });
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

    function renderList() {
        if (!shell || destroyed) return;
        if (shell.isNavigating || shell.pointerActive) { shell.deferRefresh(); return; }
        bookLabel.textContent = state.name || t`--- Pick to Edit ---`;
        bookActions.hidden = !state.name;
        newEntryButton.disabled = !state.data;
        const allEntries = Object.values(state.data?.entries ?? {}).filter(entry => entry && typeof entry === 'object');
        const total = allEntries.length;
        const active = allEntries.filter(entry => !entry.disable).length;
        // HUMAN: replace — entry-count and active-count subtitle labels.
        bookSubtitle.textContent = `${total} ${t`lorum ipsum`} · ${active} ${t`lorum ipsum`}`;
        settingsButton.setAttribute('aria-pressed', String(shell.selectedKey === 'settings'));
        listStatus.hidden = Boolean(state.data && entries.length);
        entryBox.hidden = !listStatus.hidden;
        if (!state.data) {
            showStatus(listStatus, {
                icon: 'book-atlas', title: t`--- Pick to Edit ---`, compact: true,
                actions: [
                    { label: t`Worlds/Lorebooks`, primary: true, onActivate: () => openBookPicker(bookSwitcher) },
                    { label: t`New`, onActivate: () => run(() => clickTransport('world_create_button')) },
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
                row.classList.toggle('is-selected', String(selectedUid()) === String(entry.uid));
                row.classList.toggle('is-disabled', Boolean(entry.disable));
            },
        });
        searchControl.report(entries.length, total);
        sortable = bindSortable(entryBox, {
            handle: '.sb-wi-grip', items: '> .sb-wi-row', disabled: !customSort() || Boolean(searchControl.query),
            touch: () => matchMedia('(max-width: 768px)').matches,
            start: () => { dragBook = state; },
            update: () => run(async () => {
                if (dragBook !== state) return;
                const ids = [...entryBox.children].map(row => row.dataset.uid);
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
        onDeselect: () => {
            destroyDetail();
            settingsButton.setAttribute('aria-pressed', 'false');
        },
        onSelect: item => {
            settingsButton.setAttribute('aria-pressed', String(item.kind === 'settings'));
            renderList();
        },
        findRow: key => key === 'settings' ? settingsButton : rows.get(key)?.row ?? null,
        focusTarget: () => activeController?.focusTarget() ?? null,
    });
    shell.root.hidden = true;
    listContent.append(listHeader, searchField, listBody, pagination.element);
    shell.sidebar.append(listContent, searchStatus);
    const unbindRows = bindListKeyboard(listBody, {
        rowSelector: '.sb-wi-row', keySourceSelector: '.sb-wi-grip',
        ignoreSelector: 'button, input, select, textarea, a, label, [role="switch"], [role="button"]',
        onOpen: row => {
            run(() => shell.selectItem({ kind: 'entry', uid: rowEntry(row).uid }));
        },
        onMove: (row, direction) => {
            if (!customSort() || searchControl.query) return false;
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

    const adapter = { render: async ({ name, data, navigation = navigation_option.none }) => {
        if (destroyed) return;
        const revision = ++renderRevision;
        const changedBook = renderedName !== undefined && renderedName !== name;
        if (changedBook) {
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
        entries = data ? getWorldInfoDisplayEntries(data) : [];
        entryController()?.sync({ name, data });
        pagination.setTotal(entries.length);
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
    } };

    const controller = { destroy() {
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
        unbindRows();
        searchControl.destroy();
        pagination.destroy();
        sortable?.destroy();
        shell.destroy();
        worldInfo.classList.remove('sb-wi-editor-mounted');
        mountedEditors.delete(container);
    } };
    mountedEditors.set(container, controller);
    Promise.all([
        Promise.resolve().then(() => { if (!destroyed) return setWorldInfoEditorAdapter(adapter); }),
        loadListEditorStyles(),
        globalThis.SillyBunnyAssets?.loadStylesheetAsync?.(STYLESHEET.href, { id: STYLESHEET.id }) ?? Promise.resolve(),
    ]).then(() => {
        if (destroyed) return;
        worldInfo.classList.add('sb-wi-editor-mounted');
        shell.root.hidden = false;
        shell.scheduleLayout();
        renderList();
    }).catch(error => globalThis.toastr?.error(error.message));
    return controller;
}
