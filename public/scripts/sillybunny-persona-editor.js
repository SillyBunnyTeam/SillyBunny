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
import { createListEditor, LIST_EDITOR_STYLESHEET } from './sillybunny-editor/list-shell.js';
import { reconcileRows, rowEntry, bindListKeyboard } from './sillybunny-editor/list-rows.js';
import { createListSearch } from './sillybunny-editor/list-search.js';
import { createListPagination } from './sillybunny-editor/list-pagination.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { createEntityRow, entityKey } from './sillybunny-editor/entity-row.js';
import { characterTabGuardSelector, registerEditorNavigation } from './sillybunny-editor/navigation.js';
import { objectNavigation } from './sillybunny-editor/object-navigation.js';
import { mountPersonaSettings } from './sillybunny-persona-settings.js';
import { mountPersonaDetail, personaDraftKey } from './sillybunny-persona-detail.js';

const STYLESHEETS = [
    { href: 'css/sillybunny-entity-list.css?v=20261018a', id: 'deferred-entity-list-css' },
    { href: 'css/sillybunny-persona-editor.css?v=20261018a', id: 'deferred-persona-editor-css' },
    { href: 'css/sillybunny-persona-detail.css?v=20261018a', id: 'deferred-persona-detail-css' },
];
const mountedEditors = new WeakMap();
const itemKey = item => item.kind === 'persona' ? entityKey('persona', item.avatarId) : item.kind;

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
export async function loadPersonaEditorStyles(stylesheets = [LIST_EDITOR_STYLESHEET, ...STYLESHEETS]) {
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
    let allIds = [];
    let entries = [];
    let heldOrder = null;
    let activeController = null;
    let controllerKind = null;
    let shell = null;
    let menuTrigger = null;
    let destroyed = false;
    let internalPaging = false;
    let listRevision = 0;
    let avatarRevision = 0;
    let initialized = false;
    let preparingReveal = false;
    let pendingRefresh = null;
    let refreshPromise = null;

    const listHeader = element('header', 'sb-persona-list-header');
    const titles = element('div', 'sb-persona-list-titles');
    const subtitle = element('span', 'sb-persona-list-subtitle');
    titles.append(element('span', 'sb-persona-list-title', t`Persona`), subtitle);
    const spacer = element('span', 'sb-persona-list-header-spacer');
    spacer.setAttribute('aria-hidden', 'true');
    const searchButton = button(t`Search`, 'magnifying-glass', () => searchControl.toggle());
    const newButton = button(t`New`, 'plus', () => shell.selectItem({ kind: 'create' }), 'sb-persona-new');
    // HUMAN: replace — Sort control label.
    const sortButton = button(t`Sort`, 'arrow-down-wide-short', trigger => openSortMenu(trigger), 'sb-persona-sort-button');
    const listMenu = button(t`Persona Management`, 'ellipsis-vertical', trigger => openListMenu(trigger), 'sb-persona-list-menu');
    for (const control of [sortButton, listMenu]) {
        control.setAttribute('aria-haspopup', 'menu');
        control.setAttribute('aria-expanded', 'false');
    }
    listHeader.append(titles, spacer, searchButton, newButton, sortButton, listMenu);

    const searchField = element('label', 'sb-persona-search-field');
    searchField.hidden = true;
    const searchInput = element('input', 'sb-persona-search');
    searchInput.type = 'search';
    searchInput.placeholder = t`Search...`;
    searchInput.setAttribute('aria-label', t`Search`);
    searchField.append(icon('magnifying-glass'), searchInput);
    const listBody = element('div', 'sb-persona-list-body');
    const heading = element('h3', 'sb-persona-list-heading', t`Your Persona`);
    heading.tabIndex = -1;
    const listBox = element('div', 'sb-persona-list-box ds-pref-group ds-entity-list');
    listBox.setAttribute('role', 'list');
    const listStatus = element('div', 'sb-persona-list-status');
    listBody.append(heading, listBox, listStatus);
    const listContent = element('div', 'sb-persona-list-content');
    const searchStatus = element('div', 'sb-list-editor__status');
    searchStatus.setAttribute('aria-live', 'polite');
    const searchControl = createListSearch({
        field: searchField, input: searchInput, trigger: searchButton, scope: listContent,
        status: searchStatus, scroller: listBody, debounce: 300, heightProperty: '--sb-persona-search-height',
        onChange: () => {
            heldOrder = null;
            updateDisplayEntries();
            run(() => goToPage(1));
            renderList();
        },
    });
    const pagination = createListPagination({
        pageSizes: [5, 10, 25, 50, 100, 250, 500, 1000],
        readPageSize: () => accountStorage.getItem('Personas_PerPage'),
        writePageSize: size => accountStorage.setItem('Personas_PerPage', String(size)),
        guard: () => internalPaging || shell.guardLeave(),
        onChange: () => {
            if (!internalPaging) {
                heldOrder = null;
                updateDisplayEntries();
            }
            renderList();
        },
    });

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
            [menuItem(t`Backup`, 'file-export', () => clickTransport('#personas_backup')), menuItem(t`Restore`, 'file-import', () => clickTransport('#personas_restore'))],
            [menuItem(t`Usage Stats`, 'chart-simple', () => clickTransport('.user_stats_button'))],
        ]);
    }

    function openSortMenu(trigger) {
        menu(trigger, sortButton.getAttribute('aria-label'), [{
            // HUMAN: replace — Sort by section title.
            title: t`Sort type`,
            items: [['asc', t`A-Z`], ['desc', t`Z-A`]].map(([order, label]) => ({
                ...menuItem(label, 'arrow-down-wide-short', () => {
                    power_user.persona_sort_order = order;
                    saveSettingsDebounced();
                    heldOrder = null;
                    updateDisplayEntries();
                    renderList();
                }),
                kind: 'radio',
                checked: power_user.persona_sort_order === order,
            })),
        }]);
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

    function openPersonaMenu(trigger, avatarId) {
        const record = getPersonaRecord(avatarId);
        if (!record) return;
        menu(trigger, record.name, [
            // HUMAN: replace — Use this persona action.
            [menuItem(t`Use this persona`, 'circle-check', () => usePersona(avatarId), false, getPersonaEditorStates(avatarId).inUse)],
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
            [state.locked.chat, 'lock', t`Persona is locked to the current chat`],
            [state.locked.character, 'link', t`Persona is locked to the current character`],
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
        const more = button(t`Actions for ${name}`, 'ellipsis-vertical', trigger => openPersonaMenu(trigger, avatarId), 'sb-persona-row-menu ds-entity-row__button');
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
        pagination.setTotal(entries.length);
    }

    function renderList() {
        if (!shell || destroyed) return;
        if (initialized && !preparingReveal && !isOpen()) {
            pendingRefresh ??= { reason: 'states', avatarId: undefined };
            return;
        }
        if (shell.isNavigating || shell.pointerActive) { shell.deferRefresh(); return; }
        // HUMAN: replace — Persona-count subtitle.
        subtitle.textContent = `${allIds.length} ${t`personas available`}`;
        listStatus.hidden = entries.length > 0;
        heading.hidden = !listStatus.hidden;
        listBox.hidden = !listStatus.hidden;
        if (!entries.length) {
            listStatus.replaceChildren(createStatusPage({
                icon: allIds.length ? 'magnifying-glass' : 'user',
                // HUMAN: replace — Empty persona library title.
                title: allIds.length ? t`No results` : t`No personas available`, compact: true,
                actions: allIds.length ? [] : [{ label: t`New`, primary: true, onActivate: () => run(() => shell.selectItem({ kind: 'create' })) }],
            }).element);
        }
        reconcileRows({
            container: listBox, cache: rows, entries: pagination.slice(entries), key: avatarId => entityKey('persona', avatarId),
            signature: avatarId => avatarId,
            create: makePersonaRow,
            update: (row, avatarId) => {
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
                row.classList.toggle('is-selected', selectedAvatarId() === avatarId);
                const more = entity.slots.suffix.firstElementChild;
                more.setAttribute('aria-label', t`Actions for ${name}`);
                more.title = t`Actions for ${name}`;
            },
        });
        searchControl.report(entries.length, allIds.length);
    }

    async function goToPage(page, isCurrent = () => true) {
        internalPaging = true;
        try { await pagination.goTo(page, { isCurrent }); } finally { internalPaging = false; }
    }

    async function selectPersona(avatarId, section, isCurrent = () => true) {
        if (destroyed || !isCurrent() || !getPersonaRecord(avatarId)) return false;
        if (!(await shell.selectItem({ kind: 'persona', avatarId }, { isCurrent })) || destroyed) return false;
        if (destroyed || !isCurrent()) return false;
        const index = entries.indexOf(avatarId);
        if (index >= 0) await goToPage(pagination.pageOf(index), isCurrent);
        if (destroyed || !isCurrent()) return false;
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
    listContent.append(listHeader, searchField, listBody, pagination.element);
    shell.sidebar.append(listContent, searchStatus);
    const unbindRows = bindListKeyboard(listBody, {
        rowSelector: '.sb-persona-row',
        onOpen: row => run(() => shell.selectItem({ kind: 'persona', avatarId: rowEntry(row) })),
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
        return !destroyed && !shell.root.hidden && !shell.root.closest('[hidden], [aria-hidden="true"], [inert]');
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
            pagination.setTotal(entries.length);
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
            searchControl.destroy();
            pagination.destroy();
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
