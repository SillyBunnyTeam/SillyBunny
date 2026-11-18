import { getThumbnailUrlForViewport, saveSettingsDebounced } from '../script.js';
import { isFirefox } from './browser-fixes.js';
import { power_user } from './power-user.js';
import {
    deletePersonaRecord, duplicatePersonaRecord, getPersonaDisplayAvatars, getPersonaEditorStates,
    getPersonaRecord, listPersonaAvatars, setPersonaEditorAdapter, usePersona,
} from './personas.js';
import { accountStorage } from './util/AccountStorage.js';
import { t } from './i18n.js';
import { eventSource, event_types } from './events.js';
import { openActionMenu, closeActionMenu, isActionMenuOpen } from './sillybunny-action-menu.js';
import { isPickerOpen } from './sillybunny-editor/picker.js';
import { createListEditor, LIST_EDITOR_STYLESHEET, EDITOR_CHROME_STYLESHEET } from './sillybunny-editor/list-shell.js';
import { reconcileRows, rowEntry, bindListKeyboard } from './sillybunny-editor/list-rows.js';
import { createListSearch } from './sillybunny-editor/list-search.js';
import { createSearchEntry } from './sillybunny-editor/search-entry.js';
import { createListShowMore } from './sillybunny-editor/list-show-more.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { createSelectionMode } from './sillybunny-editor/selection-mode.js';
import { confirmDestructiveAction } from './sillybunny-delete-confirm.js';
import { createEntityRow, entityKey } from './sillybunny-editor/entity-row.js';
import { createFolderMotion, createFolderRow, folderCountLabel } from './sillybunny-editor/folder-row.js';
import { getFolderId, getFolders, setFolder, setFolderExpanded, subscribe as subscribeFolders } from './sillybunny-folders.js';
import { characterTabGuardSelector, registerEditorNavigation } from './sillybunny-editor/navigation.js';
import { objectNavigation } from './sillybunny-editor/object-navigation.js';
import { mountPersonaSettings } from './sillybunny-persona-settings.js';
import { mountPersonaDetail, personaDraftKey } from './sillybunny-persona-detail.js';

const STYLESHEETS = [
    { href: 'css/sillybunny-entity-list.css?v=20261118zza', id: 'deferred-entity-list-css' },
    { href: 'css/sillybunny-persona-editor.css?v=20261117l', id: 'deferred-persona-editor-css' },
    { href: 'css/sillybunny-persona-detail.css?v=20261118zv', id: 'deferred-persona-detail-css' },
];
const DEFAULT_BATCH_SIZE = 50;
const mountedEditors = new WeakMap();
const itemKey = item => item.kind === 'persona' ? entityKey('persona', item.avatarId) : item.kind;

/** The saved per-page size is the batch size; a missing or invalid value falls back to the default. */
function batchSize() {
    const saved = Number(accountStorage.getItem('Personas_PerPage'));
    return Number.isInteger(saved) && saved > 0 ? saved : DEFAULT_BATCH_SIZE;
}

function openFolderManager() {
    return globalThis.SillyBunnyFolderManager?.open?.('personas')
        ?? import('./sillybunny-folder-manager.js').then(module => module.openFolderManager('personas'));
}

/**
 * Marks the rows of each folder section so CSS can frame a folder header and its members as one group.
 * @param {HTMLElement} container Rows container in display order.
 */
function decorateFolderSections(container) {
    const rows = [...container.children];
    const sectionOf = row => {
        const entry = rowEntry(row);
        return entry?.kind === 'folder' ? entry.folder?.id ?? null : entry?.folderId ?? null;
    };
    rows.forEach((row, index) => {
        const section = sectionOf(row);
        const isHeader = rowEntry(row)?.kind === 'folder';
        const next = rows[index + 1];
        const nextSection = next ? sectionOf(next) : null;
        const previousSection = index > 0 ? sectionOf(rows[index - 1]) : null;
        row.classList.toggle('is-folder-member', Boolean(section) && !isHeader);
        row.classList.toggle('is-folder-section-start', Boolean(section) && (isHeader || previousSection !== section));
        row.classList.toggle('is-folder-section-end', Boolean(section) && (nextSection !== section || rowEntry(next)?.kind === 'folder'));
    });
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
    const node = element('button', `menu_button menu_button_icon ${className}`);
    node.type = 'button';
    node.setAttribute('aria-label', label);
    node.title = label;
    node.append(icon(glyph));
    node.addEventListener('click', event => {
        event.stopPropagation();
        run(() => action(node));
    });
    return node;
}

function menuItem(label, glyph, action, danger = false, disabled = false) {
    return { label, icon: `fa-solid fa-${glyph}`, danger, disabled, onSelect: () => run(action) };
}

/**
 * Loads the deferred Persona styles, removing failed links so a later mount can retry.
 * @param {{ href: string, id: string }[]} [stylesheets]
 * @returns {Promise<void>}
 */
export async function loadPersonaEditorStyles(stylesheets = [LIST_EDITOR_STYLESHEET, EDITOR_CHROME_STYLESHEET, ...STYLESHEETS]) {
    const loader = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    if (!loader) return;
    await Promise.all(stylesheets.map(async ({ href, id }) => {
        let link = document.getElementById(id);
        try {
            const loading = loader(href, { id });
            link = document.getElementById(id);
            await loading;
        } catch (error) {
            // The shared loader retains failed links; only remove this attempt's link before retrying.
            if (link instanceof HTMLLinkElement && document.getElementById(id) === link) link.remove();
            throw error;
        }
    }));
}

export function preservePersonaOrder(heldIds, displayIds, allIds) {
    const existing = new Set(allIds);
    const held = new Set(heldIds);
    return [...heldIds.filter(id => existing.has(id)), ...displayIds.filter(id => !held.has(id))];
}

export function mountPersonaEditor(container) {
    if (!(container instanceof HTMLElement)) throw new TypeError('Persona editor requires an HTMLElement.');
    if (!container.matches('#PersonaManagement')) throw new Error('Persona editor must be mounted inside #PersonaManagement.');
    if (mountedEditors.has(container)) return mountedEditors.get(container);

    const rows = new Map();
    const entityRows = new WeakMap();
    const folderRows = new WeakMap();
    let allIds = [];
    let entries = [];
    let batches = 1;
    let heldOrder = null;
    let activeController = null;
    let controllerKind = null;
    let shell = null;
    let menuTrigger = null;
    let destroyed = false;
    let listRevision = 0;
    let avatarRevision = 0;
    let initialized = false;
    let preparingReveal = false;
    let pendingRefresh = null;
    let refreshPromise = null;
    let selection = null;
    let bulkBusy = false;
    const folderMotion = createFolderMotion();

    const listHeader = element('header', 'sb-persona-list-header');
    const titles = element('div', 'sb-persona-list-titles');
    const subtitle = element('span', 'sb-persona-list-subtitle');
    titles.append(element('span', 'sb-persona-list-title', t`Persona`), subtitle);
    const spacer = element('span', 'sb-persona-list-header-spacer');
    spacer.setAttribute('aria-hidden', 'true');
    const searchButton = button(t`Search`, 'magnifying-glass', () => searchControl.toggle());
    const newButton = button(t`New`, 'plus', () => shell.selectItem({ kind: 'create' }), 'sb-persona-new');
    const sortButton = button(t`Sort`, 'arrow-down-wide-short', trigger => openSortMenu(trigger), 'sb-persona-sort-button');
    const listMenu = button(t`Persona Management`, 'ellipsis-vertical', trigger => openListMenu(trigger), 'sb-persona-list-menu');
    [searchButton, newButton, sortButton, listMenu].forEach(control => control.classList.add('sb-header-icon-button'));
    for (const control of [sortButton, listMenu]) {
        control.setAttribute('aria-haspopup', 'menu');
        control.setAttribute('aria-expanded', 'false');
    }
    for (const control of [searchButton, sortButton]) control.setAttribute('aria-pressed', 'false');
    listHeader.append(titles, spacer, searchButton, newButton, listMenu);

    const searchEntry = createSearchEntry({
        clearLabel: t`Clear Entry`,
        variant: 'bar', className: 'sb-persona-search-entry', inputClassName: 'sb-persona-search',
        placeholder: t`Search…`, label: t`Search`, clearOnEscape: false,
    });
    // The sort button ends the search bar, so the header keeps its other buttons and the title keeps its room.
    const searchField = element('div', 'sb-persona-search-field sb-list-search-bar');
    searchField.append(searchEntry.element, sortButton);
    const searchInput = searchEntry.input;
    searchField.hidden = true;
    const listBody = element('div', 'sb-persona-list-body');
    const heading = element('h3', 'sb-persona-list-heading', t`Your Persona`);
    heading.tabIndex = -1;
    const listBox = element('div', 'sb-persona-list-box ds-pref-group ds-entity-list');
    const rowsContainer = element('div', 'sb-persona-list-rows ds-entity-list__rows');
    rowsContainer.setAttribute('role', 'list');
    const listFooter = element('div', 'ds-entity-list__footer');
    listFooter.hidden = true;
    listBox.append(rowsContainer, listFooter);
    const listStatus = element('div', 'sb-persona-list-status');
    listBody.append(heading, listBox, listStatus);
    const listContent = element('div', 'sb-persona-list-content');
    const selectionHeader = element('header', 'sb-persona-selection-header');
    const selectionBar = element('div', 'sb-persona-selection-bar');
    const searchStatus = element('div', 'sb-list-editor__status');
    searchStatus.setAttribute('aria-live', 'polite');
    const searchControl = createListSearch({
        field: searchField, input: searchInput, trigger: searchButton, scope: listContent,
        status: searchStatus, scroller: listBody, debounce: 300, closeEmptyOnBlur: true,
        onChange: () => {
            heldOrder = null;
            batches = 1;
            updateDisplayEntries();
            renderList();
        },
    });
    const showMore = createListShowMore({ onShowMore: showMoreRows });
    listFooter.append(showMore.element);

    function detailController() {
        return controllerKind === 'persona' || controllerKind === 'create' ? activeController : null;
    }

    function destroyDetail({ keepDraft = false } = {}) {
        keepDraft ||= detailController()?.isDirty() ?? false;
        const previous = activeController;
        activeController = null;
        controllerKind = null;
        previous?.destroy({ keepDraft });
        if (shell) {
            shell.root.dataset.dirty = 'false';
            shell.root.dataset.saving = 'false';
            delete shell.root.dataset.personaAvatarId;
        }
    }

    function selectedAvatarId() {
        return shell?.selectedItem?.kind === 'persona' ? shell.selectedItem.avatarId : null;
    }

    function menu(trigger, title, sections) {
        openActionMenu({
            trigger, title, sections: sections.map(section => Array.isArray(section) ? { items: section } : section),
            onClose: () => { if (menuTrigger === trigger) menuTrigger = null; },
        });
        menuTrigger = isActionMenuOpen(trigger) ? trigger : null;
    }

    async function clickTransport(selector) {
        if (await shell.guardLeave()) document.querySelector(selector)?.click();
    }

    function openListMenu(trigger) {
        menu(trigger, t`Persona Management`, [
            [menuItem(t`Global Settings`, 'gear', () => shell.selectedKey === 'settings' ? shell.deselectItem() : shell.selectItem({ kind: 'settings' }))],
            [menuItem(t`Select`, 'check-double', () => selection.enter(null, trigger), false, bulkBusy || !allIds.length)],
            [menuItem(t`Manage Folders`, 'folder', openFolderManager)],
            [menuItem(t`Backup`, 'file-export', () => clickTransport('#personas_backup')), menuItem(t`Restore`, 'file-import', () => clickTransport('#personas_restore'))],
            [menuItem(t`Usage Stats`, 'chart-simple', () => clickTransport('.user_stats_button'))],
        ]);
    }

    function openSortMenu(trigger) {
        menu(trigger, sortButton.getAttribute('aria-label'), [{
            title: t`Sort By`,
            items: [['asc', t`A-Z`], ['desc', t`Z-A`]].map(([order, label]) => ({
                ...menuItem(label, 'arrow-down-wide-short', () => {
                    power_user.persona_sort_order = order;
                    saveSettingsDebounced();
                    heldOrder = null;
                    batches = 1;
                    updateDisplayEntries();
                    renderList();
                }),
                kind: 'radio',
                checked: power_user.persona_sort_order === order,
            })),
        }]);
    }

    /** The Search toggle and the sort button show that the list is not in its default order. */
    function syncSortState() {
        const altered = power_user.persona_sort_order !== 'asc';
        sortButton.setAttribute('aria-pressed', String(altered));
        searchButton.setAttribute('aria-pressed', String(altered));
    }

    async function duplicatePersona(avatarId) {
        if (!(await shell.guardLeave())) return;
        const duplicatedId = await duplicatePersonaRecord(avatarId);
        await refresh('list');
        if (duplicatedId) await selectPersona(duplicatedId);
    }

    async function deletePersona(avatarId) {
        if (!(await shell.guardLeave())) return;
        if (!(await deletePersonaRecord(avatarId))) return;
        if (selectedAvatarId() === avatarId) {
            destroyDetail();
            shell.deselectNow();
        }
        await refresh('list');
    }

    const existingSelected = (keys = selection.selectedKeys) => keys.filter(avatarId => getPersonaRecord(avatarId));

    async function bulkAction(action) {
        if (bulkBusy) return;
        const avatarIds = existingSelected();
        if (!avatarIds.length) return;
        bulkBusy = true;
        selectionBar.inert = true;
        selectionBar.setAttribute('aria-busy', 'true');
        try {
            return await action(avatarIds);
        } finally {
            bulkBusy = false;
            selectionBar.inert = false;
            selectionBar.removeAttribute('aria-busy');
        }
    }

    function moveSelectedToFolder(trigger, avatarIds) {
        const folders = getFolders('personas');
        const inFolder = folderId => avatarIds.every(avatarId => (folders.some(folder => folder.id === getFolderId('personas', avatarId))
            ? getFolderId('personas', avatarId) : null) === folderId);
        const place = folderId => () => {
            setFolder('personas', avatarIds, folderId);
            selection.exit();
        };
        menu(trigger, t`Move to Folder`, [[
            { ...menuItem(t`No Folder`, 'folder', place(null)), kind: 'radio', checked: inFolder(null) },
            ...folders.map(folder => ({ ...menuItem(folder.name, 'folder', place(folder.id)), kind: 'radio', checked: inFolder(folder.id) })),
        ]]);
    }

    async function duplicateSelected(avatarIds) {
        if (!(await shell.guardLeave())) return;
        for (const avatarId of avatarIds) await duplicatePersonaRecord(avatarId);
        await refresh('list');
        selection.exit();
    }

    async function deleteSelected(avatarIds) {
        if (!(await shell.guardLeave())) return;
        // HUMAN: replace — bulk delete confirmation; the selected count remains explicit.
        const text = avatarIds.length === 1 ? t`Delete this persona? This cannot be undone.` : t`Delete ${avatarIds.length} personas? This cannot be undone.`;
        if (!await confirmDestructiveAction({ text, confirmLabel: t`Delete` })) return;
        const states = avatarIds.map(avatarId => getPersonaEditorStates(avatarId));
        const deleted = [];
        // One confirmation covers the set, so each persona goes through the single delete without its own.
        for (const avatarId of avatarIds) {
            if (await deletePersonaRecord(avatarId, { silent: true })) deleted.push(avatarId);
        }
        if (states.some((state, index) => state.default && deleted.includes(avatarIds[index]))) {
            globalThis.toastr?.warning(t`The default persona was deleted. You will need to set a new default persona.`, t`Default persona deleted`);
        }
        if (states.some((state, index) => state.locked.chat && deleted.includes(avatarIds[index]))) {
            globalThis.toastr?.warning(t`The locked persona was deleted. You will need to set a new persona for this chat.`, t`Persona deleted`);
        }
        if (deleted.includes(selectedAvatarId())) {
            destroyDetail();
            shell.deselectNow();
        }
        await refresh('list');
        selection.exit();
    }

    function openPersonaMenu(trigger, avatarId) {
        const record = getPersonaRecord(avatarId);
        if (!record) return;
        menu(trigger, record.name, [
            // HUMAN: replace — Use this persona action.
            [menuItem(t`Use This Persona`, 'circle-check', () => usePersona(avatarId), false, getPersonaEditorStates(avatarId).inUse)],
            [menuItem(t`Duplicate`, 'copy', () => duplicatePersona(avatarId))],
            [menuItem(t`Delete`, 'trash', () => deletePersona(avatarId), true)],
        ]);
    }

    function badges(avatarId) {
        const state = getPersonaEditorStates(avatarId);
        const badges = [];
        for (const [shown, glyph, label, accent] of [
            [state.inUse, 'circle-check', t`Current Persona`, true],
            [state.default, 'crown', t`Default Persona`],
            [state.locked.chat, 'lock', t`Persona Is Locked to the Current Chat`],
            [state.locked.character, 'link', t`Persona Is Locked to the Current Character`],
        ]) {
            if (!shown) continue;
            const badge = icon(glyph);
            badge.removeAttribute('aria-hidden');
            badge.setAttribute('role', 'img');
            badge.setAttribute('aria-label', label);
            badge.title = label;
            if (accent) badge.classList.add('is-in-use');
            badges.push(badge);
        }
        return badges;
    }

    function makePersonaRow(avatarId) {
        const { name, descriptor } = getPersonaRecord(avatarId);
        const more = button(t`Actions for ${name}`, 'ellipsis-vertical', trigger => openPersonaMenu(trigger, avatarId), 'sb-persona-row-menu sb-list-editor__row-menu ds-entity-row__button');
        more.setAttribute('aria-haspopup', 'menu');
        more.setAttribute('aria-expanded', 'false');
        const entity = createEntityRow({
            key: entityKey('persona', avatarId), label: name,
            avatar: { src: getThumbnailUrlForViewport('persona', avatarId, isFirefox()), alt: '' },
            subtitle: descriptor?.title || descriptor?.description?.split(/\r?\n/, 1)[0] || '',
            badges: badges(avatarId), suffix: [more], activation: 'activate',
            compatClasses: { row: ['sb-persona-row'], badge: ['sb-persona-row-badges'] },
            attributes: { 'data-avatar-id': avatarId, 'data-avatar-revision': String(avatarRevision) },
        });
        entityRows.set(entity.row, entity);
        return entity.row;
    }

    function updateDisplayEntries() {
        const displayIds = getPersonaDisplayAvatars(allIds, searchControl.query).filter(id => getPersonaRecord(id));
        entries = heldOrder ? preservePersonaOrder(heldOrder, displayIds, allIds).filter(id => getPersonaRecord(id)) : displayIds;
        if (heldOrder) heldOrder = [...entries];
    }

    /** Folder headers followed by their members, then the unfiled personas, in the order of `entries`. */
    function buildRows() {
        const filtered = Boolean(searchControl.query.trim());
        const folders = getFolders('personas');
        const membersByFolder = new Map(folders.map(folder => [folder.id, []]));
        const unfiled = [];
        for (const avatarId of entries) {
            const members = membersByFolder.get(getFolderId('personas', avatarId));
            if (members) members.push(avatarId);
            else unfiled.push(avatarId);
        }
        const rowsList = [];
        const personaRow = (avatarId, folderId) => ({ kind: 'persona', key: entityKey('persona', avatarId), avatarId, folderId });
        for (const folder of folders) {
            const members = membersByFolder.get(folder.id);
            if (filtered && !members.length) continue;
            const expanded = filtered || folder.expanded;
            rowsList.push({
                kind: 'folder',
                key: `folder:personas:${folder.id}`,
                folder: { ...folder, scope: 'personas' },
                scope: 'personas',
                count: members.length,
                countLabel: folderCountLabel(members.length, 'personas'),
                expanded,
                temporaryExpansion: filtered,
                inert: Boolean(selection?.isActive),
            });
            if (expanded) for (const avatarId of members) rowsList.push(personaRow(avatarId, folder.id));
        }
        for (const avatarId of unfiled) rowsList.push(personaRow(avatarId, null));
        return rowsList;
    }

    function makeFolderRow(entry) {
        const factory = createFolderRow(entry);
        folderRows.set(factory.row, factory);
        return factory.row;
    }

    function renderList() {
        if (!shell || destroyed) return;
        if (initialized && !preparingReveal && !isOpen()) {
            pendingRefresh ??= { reason: 'states', avatarId: undefined };
            return;
        }
        if (shell.isNavigating || shell.pointerActive) { shell.deferRefresh(); return; }
        subtitle.textContent = allIds.length === 1 ? t`1 persona` : t`${allIds.length} personas`;
        listStatus.hidden = entries.length > 0;
        heading.hidden = !listStatus.hidden;
        listBox.hidden = !listStatus.hidden;
        if (!entries.length) {
            listStatus.replaceChildren(createStatusPage({
                state: allIds.length ? 'no-results' : 'empty',
                icon: allIds.length ? 'magnifying-glass' : 'user',
                title: allIds.length ? t`No Results Found` : t`No Personas`, compact: true,
                description: allIds.length ? t`Try a different search` : undefined,
                actions: allIds.length ? [] : [{ label: t`New`, primary: true, onActivate: () => run(() => shell.selectItem({ kind: 'create' })) }],
            }).element);
        }
        const allRows = buildRows();
        const size = batchSize();
        batches = Math.min(batches, Math.max(1, Math.ceil(allRows.length / size)));
        const shownRows = allRows.slice(0, batches * size);
        showMore.update({ shown: shownRows.length, total: allRows.length });
        listFooter.hidden = showMore.isComplete;
        reconcileRows({
            container: rowsContainer, cache: rows, entries: shownRows, key: entry => entry.key,
            signature: entry => entry.kind === 'folder' ? 'folder' : entry.avatarId,
            create: entry => entry.kind === 'folder' ? makeFolderRow(entry) : makePersonaRow(entry.avatarId),
            update: (row, entry) => {
                if (entry.kind === 'folder') {
                    folderRows.get(row).update(entry);
                    return;
                }
                const { avatarId } = entry;
                const { name, descriptor } = getPersonaRecord(avatarId);
                const entity = entityRows.get(row);
                const changes = {
                    label: name, badges: badges(avatarId),
                    subtitle: descriptor?.title || descriptor?.description?.split(/\r?\n/, 1)[0] || '',
                };
                if (row.dataset.avatarRevision !== String(avatarRevision)) {
                    changes.avatar = { src: getThumbnailUrlForViewport('persona', avatarId, true), alt: '' };
                    changes.attributes = { 'data-avatar-revision': String(avatarRevision) };
                }
                entity.update(changes);
                row.classList.toggle('is-selected', !selection?.isActive && selectedAvatarId() === avatarId);
                const more = entity.slots.suffix.firstElementChild;
                more.setAttribute('aria-label', t`Actions for ${name}`);
                more.title = t`Actions for ${name}`;
            },
        });
        decorateFolderSections(rowsContainer);
        folderMotion.reveal(rowsContainer);
        syncSortState();
        if (selection?.isActive) selection.decorate({ prune: true });
        syncSelectionState();
        searchControl.report(entries.length, allIds.length);
    }

    /** Selection hides the open-row mark and takes the rows' own controls and the folder headers out of use. */
    function syncSelectionState() {
        const active = Boolean(selection?.isActive);
        for (const row of rowsContainer.children) {
            const entry = rowEntry(row);
            if (entry?.kind === 'folder') {
                row.inert = active;
                row.tabIndex = active ? -1 : 0;
                if (active) row.setAttribute('aria-disabled', 'true');
                else row.removeAttribute('aria-disabled');
                continue;
            }
            row.classList.toggle('is-selected', !active && selectedAvatarId() === entry?.avatarId);
            for (const suffix of row.querySelectorAll('.ds-entity-row__suffix')) suffix.inert = active;
        }
    }

    function showMoreRows() {
        const shownBefore = rowsContainer.children.length;
        batches++;
        renderList();
        // A button that hides itself would drop the keyboard focus: continue at the first row that was added.
        if (showMore.isComplete && (document.activeElement === showMore.button || !listContent.contains(document.activeElement))) {
            rowsContainer.children[shownBefore]?.focus({ preventScroll: true });
        }
    }

    /** Shows the row of a persona: opens its folder and loads the batch that holds it. */
    function revealPersona(avatarId) {
        if (!entries.includes(avatarId)) return;
        const folderId = getFolderId('personas', avatarId);
        const folder = folderId ? getFolders('personas').find(candidate => candidate.id === folderId) : null;
        if (folder && !folder.expanded && !searchControl.query.trim()) setFolderExpanded('personas', folder.id, true);
        const index = buildRows().findIndex(entry => entry.kind === 'persona' && entry.avatarId === avatarId);
        // The list only grows: revealing a row never hides the batches that were already shown.
        if (index >= 0) batches = Math.max(batches, Math.floor(index / batchSize()) + 1);
        renderList();
    }

    async function selectPersona(avatarId, section, isCurrent = () => true) {
        if (destroyed || !isCurrent() || !getPersonaRecord(avatarId)) return false;
        if (!(await shell.selectItem({ kind: 'persona', avatarId }, { isCurrent })) || destroyed) return false;
        if (destroyed || !isCurrent()) return false;
        revealPersona(avatarId);
        if (section && selectedAvatarId() === avatarId) detailController()?.scrollToSection(section);
        return true;
    }

    function renderDetail(detail, item) {
        destroyDetail();
        if (item.kind === 'persona') shell.root.dataset.personaAvatarId = item.avatarId;
        controllerKind = item.kind;
        if (item.kind === 'settings') {
            activeController = mountPersonaSettings({ host: detail, onClose: () => shell.deselectItem() });
            return;
        }
        activeController = mountPersonaDetail({
            host: detail, avatarId: item.kind === 'create' ? null : item.avatarId,
            mode: item.kind === 'create' ? 'create' : 'edit',
            requestClose: () => objectNavigation.back({
                current: { kind: 'persona-editor', id: selectedAvatarId() }, fallback: () => shell.deselectItem(),
            }),
            onSaved: ({ avatarId, created }) => run(async () => {
                await refresh(created ? 'list' : 'persona', avatarId);
                if (created && activeController && shell.selectedItem === item) await selectPersona(avatarId);
            }),
            onStateChange: ({ dirty, saving }) => {
                shell.root.dataset.dirty = String(dirty);
                shell.root.dataset.saving = String(saving);
            },
        });
    }

    shell = createListEditor({
        container, storageKey: 'sb-persona-list-width', rootTag: 'section', label: t`Persona Management`, escapeCloses: false,
        classNames: { root: 'sb-persona-editor', sidebar: 'sb-persona-list', divider: 'sb-persona-divider', detail: 'sb-persona-detail' },
        renderList, renderDetail, getKey: itemKey,
        isDirty: () => detailController()?.isDirty() ?? false,
        onSave: () => detailController()?.save() ?? true,
        onDiscard: () => detailController()?.discard(),
        onDeselect: () => destroyDetail(), onSelect: () => renderList(),
        findRow: key => key === 'settings' ? listMenu : key === 'create' ? newButton : rows.get(key)?.row ?? listMenu,
        focusTarget: () => activeController?.focusTarget() ?? null,
    });
    shell.root.hidden = true;
    listContent.append(listHeader, selectionHeader, searchField, listBody, selectionBar);
    shell.sidebar.append(listContent, searchStatus);
    selection = createSelectionMode({
        root: shell.root, list: rowsContainer, header: selectionHeader, actionBar: selectionBar,
        rowSelector: '.sb-persona-row', getKey: row => row.dataset.avatarId,
        getAllKeys: () => entries, range: true, iconOnlyAtNarrow: true,
        canEnter: () => !bulkBusy && allIds.length > 0,
        actions: [
            { id: 'folder', label: t`Move to Folder`, icon: 'fa-solid fa-folder', onActivate: keys => moveSelectedToFolder(selectionBar.querySelector('[data-action-id="folder"]'), existingSelected(keys)) },
            { id: 'duplicate', label: t`Duplicate`, icon: 'fa-solid fa-copy', onActivate: () => run(() => bulkAction(duplicateSelected)) },
            { id: 'delete', label: t`Delete`, icon: 'fa-solid fa-trash', danger: true, onActivate: () => run(() => bulkAction(deleteSelected)) },
        ],
        onChange: () => syncSelectionState(), onExit: () => syncSelectionState(),
    });
    const unbindRows = bindListKeyboard(listBody, {
        rowSelector: '.sb-persona-row, .sb-folder-row:not([aria-disabled="true"])',
        onOpen: row => {
            const entry = rowEntry(row);
            if (selection.isActive) return true;
            if (entry?.kind === 'folder') {
                if (!entry.temporaryExpansion) {
                    folderMotion.toggle(row, entry.expanded, () => setFolderExpanded('personas', entry.folder.id, !entry.expanded));
                    row.focus({ preventScroll: true });
                }
                return true;
            }
            if (entry?.avatarId) run(() => shell.selectItem({ kind: 'persona', avatarId: entry.avatarId }));
            return true;
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
    function isOpen() {
        return !destroyed && !shell.root.hidden && !shell.root.closest('[hidden], [aria-hidden="true"]');
    }
    const unregister = registerEditorNavigation({
        session: {
            isOpen: () => Boolean(detailController()), isDirty: () => detailController()?.isDirty() ?? false,
            save: () => detailController()?.save() ?? true, discard: () => detailController()?.discard(),
            // The detail controller owns its pagehide backup listener and draft timer.
            flushDraft: () => {},
        },
        isActive: isOpen, close: () => run(() => shell.deselectItem()),
        guardSelector: characterTabGuardSelector('persona'), escape: false,
    });

    async function applyRefresh(reason, avatarId) {
        if (destroyed) return;
        heldOrder ??= [...entries];
        if (reason === 'list') {
            const revision = ++listRevision;
            const avatars = await listPersonaAvatars();
            if (destroyed || revision !== listRevision) return;
            if (initialized && !preparingReveal && !isOpen()) {
                void refresh('list', avatarId);
                return;
            }
            allIds = avatars;
            avatarRevision++;
            updateDisplayEntries();
        } else if (reason === 'persona' || reason === 'avatar') {
            if (reason === 'avatar') avatarRevision++;
            allIds = allIds.filter(id => getPersonaRecord(id));
            entries = entries.filter(id => getPersonaRecord(id));
        }
        activeController?.refresh(reason === 'list' ? 'avatar' : reason, avatarId);
        shell.refresh();
    }

    function queueRefresh(reason, avatarId) {
        const priority = { states: 0, persona: 1, avatar: 2, list: 3 };
        const previous = pendingRefresh;
        pendingRefresh = {
            reason: previous && priority[previous.reason] > priority[reason] ? previous.reason : reason,
            avatarId: previous && previous.avatarId !== avatarId ? undefined : avatarId,
        };
    }

    async function applyPendingRefresh() {
        const next = pendingRefresh;
        pendingRefresh = null;
        try {
            await applyRefresh(next.reason, next.avatarId);
        } catch (error) {
            if (!destroyed) queueRefresh(next.reason, next.avatarId);
            throw error;
        }
    }

    function refresh(reason, avatarId) {
        if (destroyed) return Promise.resolve();
        queueRefresh(reason, avatarId);
        if (!initialized || !isOpen()) return Promise.resolve();
        refreshPromise ??= Promise.resolve().then(async () => {
            while (isOpen() && pendingRefresh) {
                await applyPendingRefresh();
            }
        }).finally(() => {
            refreshPromise = null;
        });
        return refreshPromise;
    }

    async function prepareReveal() {
        if (destroyed || !pendingRefresh) return;
        preparingReveal = true;
        try {
            while (!destroyed && pendingRefresh) {
                await applyPendingRefresh();
            }
        } finally { preparingReveal = false; }
    }

    const subscriptions = [];
    const subscribe = (type, handler) => {
        if (!type) return;
        eventSource.on(type, handler);
        subscriptions.push(() => eventSource.removeListener(type, handler));
    };
    const avatarFrom = payload => typeof payload === 'string' ? payload : payload?.avatarId;
    // The legacy adapter forwards PERSONA_UPDATED and chat state once; do not subscribe twice.
    for (const type of [event_types.PERSONA_RENAMED]) {
        subscribe(type, payload => refresh('persona', avatarFrom(payload)));
    }
    subscribe(event_types.PERSONA_CHANGED, () => refresh('states'));
    subscribe(event_types.PERSONA_CREATED, payload => refresh('list', avatarFrom(payload)));
    subscribe(event_types.PERSONA_DELETED, payload => {
        const avatarId = avatarFrom(payload);
        if (avatarId) {
            try { localStorage.removeItem(personaDraftKey(avatarId)); } catch { /* Storage can be unavailable. */ }
        }
        return refresh('persona', avatarId);
    });
    subscribe(event_types.SETTINGS_UPDATED, () => refresh('persona'));
    subscriptions.push(subscribeFolders(({ scope }) => {
        if (scope && scope !== 'personas') return;
        renderList();
        activeController?.refresh('folders');
    }));

    const controller = {
        ready: null,
        selectPersona,
        prepareReveal,
        onReveal: () => shell.layout(),
        destroy() {
            if (destroyed) return;
            destroyed = true;
            listRevision++;
            if (menuTrigger && isActionMenuOpen(menuTrigger)) closeActionMenu({ animate: false });
            menuTrigger = null;
            destroyDetail();
            setPersonaEditorAdapter(null);
            unregister();
            subscriptions.forEach(dispose => dispose());
            shell.root.removeEventListener('keydown', onEscape);
            unbindRows();
            selection.destroy();
            searchControl.destroy();
            showMore.destroy();
            rows.clear();
            shell.destroy();
            container.classList.remove('sb-persona-editor-mounted');
            mountedEditors.delete(container);
        },
    };
    mountedEditors.set(container, controller);
    controller.ready = Promise.resolve().then(async () => {
        if (destroyed) return;
        await setPersonaEditorAdapter({ isOpen, refresh });
        if (destroyed) return;
        await Promise.all([applyRefresh('list'), loadPersonaEditorStyles()]);
        if (destroyed) return;
        container.classList.add('sb-persona-editor-mounted');
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

/** Routes to Persona, waits for its mounted controller, then selects a stable avatar. */
export async function openPersonaEditor({ avatarId, section, isCurrent = () => true } = {}) {
    if (!isCurrent()) return false;
    const route = globalThis.SillyBunnyShell?.openTab;
    if (!route) throw new Error('The Characters shell is not ready.');
    let expired = false;
    let timer;
    const current = () => !expired && isCurrent();
    const opening = async () => {
        const routedController = await route('characters', 'persona');
        if (routedController === false || !current()) return false;
        const container = document.getElementById('PersonaManagement');
        const controller = routedController ?? mountPersonaEditor(container);
        await controller.ready;
        if (!current()) return false;
        if (!avatarId) return true;
        return controller.selectPersona(avatarId, section, current);
    };
    try {
        return await Promise.race([
            opening(),
            new Promise(resolve => {
                timer = setTimeout(() => { expired = true; resolve(false); }, 5000);
            }),
        ]);
    } finally {
        expired = true;
        clearTimeout(timer);
    }
}
