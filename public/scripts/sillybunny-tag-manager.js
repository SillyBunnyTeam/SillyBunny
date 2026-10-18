import { t, translate } from './i18n.js';
import { createEntityRow, entityKey } from './sillybunny-editor/entity-row.js';
import { createRow } from './sillybunny-editor/rows.js';
import { reconcileRows, bindListKeyboard, bindSortable } from './sillybunny-editor/list-rows.js';
import { createListSearch } from './sillybunny-editor/list-search.js';
import { createListHeader } from './sillybunny-editor/list-header.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { openActionMenu, closeActionMenu, MOBILE_QUERY } from './sillybunny-action-menu.js';
import { createSheetController, blockUpstreamDrawerClose } from './sillybunny-sheet.js';
import { animateIn, stopMotion, SPRING_SHEET } from './sillybunny-motion.js';

const STYLESHEETS = [
    { href: 'css/sillybunny-editor-shell.css?v=20261018b', id: 'deferred-editor-shell-css' },
    { href: 'css/sillybunny-entity-list.css?v=20261018a', id: 'deferred-entity-list-css' },
    { href: 'css/sillybunny-tag-manager.css?v=20261018a', id: 'deferred-tag-manager-css' },
];
let activeManager = null;
let opening = null;
let refreshQueued = false;

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

function icon(glyph) {
    const node = element('i', `fa-solid fa-${glyph}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

function button(label, glyph, action, className = '') {
    const node = element('button', `menu_button sb-tag-manager__button ${className}`);
    node.type = 'button';
    node.title = label;
    node.setAttribute('aria-label', label);
    node.append(icon(glyph));
    node.addEventListener('click', event => {
        event.stopPropagation();
        action(node);
    });
    return node;
}

/** Parses a pending tag name without mutating the shared tag model. */
export function parseTagName(value, tags, ownId = null) {
    const name = value.trim();
    // HUMAN: replace — A tag name must not be empty.
    if (!name) return { ok: false, error: t`lorum ipsum` };
    const normalized = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const duplicate = tags.some(tag => tag.id !== ownId
        && tag.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() === normalized);
    // HUMAN: replace — Another tag already has this name.
    if (duplicate) return { ok: false, error: t`lorum ipsum` };
    return { ok: true, name };
}

/** Counts each existing character/group once, ignoring duplicate assignments and dead map keys. */
export function countLiveTagEntities(tagMap, characters, groups) {
    const counts = new Map();
    const liveKeys = new Set([...characters.map(character => String(character.avatar)), ...groups.map(group => String(group.id))]);
    for (const key of liveKeys) {
        for (const id of new Set(Array.isArray(tagMap[key]) ? tagMap[key] : [])) {
            counts.set(id, (counts.get(id) ?? 0) + 1);
        }
    }
    return counts;
}

/** Updates legacy colours and the shared chip/dot tokens together, before any deferred reprint. */
export function updateTagColors(tag, root = document) {
    for (const node of root.querySelectorAll('.tag[id], [data-sb-tag-id], .bogus_folder_select[tagid]')) {
        const id = node.dataset.sbTagId ?? node.getAttribute('tagid') ?? node.id;
        if (id !== tag.id) continue;
        node.style.setProperty('--sb-tag-color', tag.color || 'var(--sb-muted-fg)');
        node.style.setProperty('--sb-tag-color2', tag.color2 || 'var(--SmartThemeBodyColor)');
        if (node.matches('.tag')) {
            node.style.backgroundColor = tag.color || '';
            node.style.color = tag.color2 || '';
        }
        if (node.matches('.bogus_folder_select')) {
            const avatar = node.querySelector('.avatar');
            if (avatar) {
                avatar.style.backgroundColor = tag.color || '';
                avatar.style.color = tag.color2 || '';
            }
        }
    }
}

/** Loads the dialog's nonblocking styles; failed attempts are removable/retryable like Persona. */
export async function loadTagManagerStyles() {
    const loader = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    if (!loader) return;
    await Promise.all(STYLESHEETS.map(async ({ href, id }) => {
        let link = document.getElementById(id);
        try {
            const loading = loader(href, { id });
            link = document.getElementById(id);
            await loading;
        } catch (error) {
            if (link instanceof HTMLLinkElement && document.getElementById(id) === link) link.remove();
            throw error;
        }
    }));
}

/** Reconciles an open dialog from upstream reprint paths without resetting its fields or scroller. */
export function refreshTagManager() {
    if (!activeManager || refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
        refreshQueued = false;
        activeManager?.refresh();
    });
}

/** Opens the single tag-management surface, preserving the upstream await-until-closed contract. */
export async function openTagManager(adapter) {
    if (activeManager) {
        activeManager.focus();
        return activeManager.closed;
    }
    if (opening) return opening;
    opening = (async () => {
        await loadTagManagerStyles();
        activeManager = createTagManager(adapter);
        activeManager.show();
        await activeManager.closed;
        activeManager = null;
    })();
    try {
        await opening;
    } finally {
        opening = null;
    }
}

/**
 * Builds the immediate-commit tag editor. All persistent writes and legacy flows belong to tags.js.
 * @param {object} adapter Live readers, commit/create/rename callbacks and upstream action handlers.
 * @returns {object} Surface lifecycle and reconciliation methods.
 */
export function createTagManager(adapter) {
    const { getState, commit, create, rename, actions, folderTypes } = adapter;
    const mobile = window.matchMedia(MOBILE_QUERY);
    const returnFocus = document.activeElement;
    const cache = new Map();
    const controls = new Map();
    let disposed = false;
    let suspended = false;
    let dragging = false;
    let reconciling = false;
    let finish;
    const closed = new Promise(resolve => finish = resolve);
    const host = element('dialog', 'sb-tag-manager-host');
    host.setAttribute('aria-labelledby', 'sb-tag-manager-title');
    const backdrop = element('div', 'sb-tag-manager__backdrop');
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.addEventListener('click', () => { if (!mobile.matches) close(); });
    backdrop.tabIndex = -1;
    backdrop.hidden = true;
    const root = element('section', 'sb-tag-manager');
    root.id = 'tag_view_list';
    root.hidden = true;
    const headerControl = createListHeader({ title: t`Tag Management`, className: 'sb-tag-manager__header', actions: [
        { id: 'more', label: t`Tag Management`, icon: 'ellipsis-vertical', menu: true, onActivate: trigger => openMenu(trigger, headerSections()) },
        { id: 'close', label: t`Close`, icon: 'xmark', onActivate: () => close() },
    ] });
    const header = headerControl.element;
    const handle = element('div', 'sb-tag-manager__handle');
    handle.setAttribute('aria-hidden', 'true');
    const title = header.querySelector('.sb-list-header__title');
    title.classList.add('sb-tag-manager__title');
    title.id = 'sb-tag-manager-title';
    headerControl.button('more').classList.add('sb-tag-manager__button', 'sb-tag-manager__menu');
    headerControl.button('close').classList.add('sb-tag-manager__button', 'sb-tag-manager__close');
    header.prepend(handle);
    const searchField = element('label', 'sb-tag-manager__search-field');
    const searchInput = element('input', 'text_pole sb-tag-manager__search');
    searchInput.type = 'search';
    searchInput.placeholder = t`Search...`;
    searchInput.setAttribute('aria-label', t`Search`);
    searchField.append(icon('magnifying-glass'), searchInput);
    const scroller = element('div', 'sb-tag-manager__body');
    const newInput = element('input', 'text_pole sb-tag-manager__new');
    newInput.setAttribute('aria-label', t`Create a new tag`);
    newInput.placeholder = t`Create a new tag`;
    const newError = element('small', 'sb-tag-manager__error');
    newError.id = 'sb-tag-manager-new-error';
    newError.hidden = true;
    newInput.setAttribute('aria-describedby', newError.id);
    const createButton = button(t`Create a new tag`, 'plus', () => createPending(), 'sb-tag-manager__add');
    const newEntry = createRow({ label: '', field: 'new-tag', suffix: [newInput, createButton] });
    newEntry.row.querySelector('.ds-row-text').remove();
    const newGroup = element('div', 'ds-pref-group sb-tag-manager__create');
    newGroup.append(newEntry.row, newError);
    const list = element('div', 'ds-pref-group ds-entity-list tag_view_list_tags');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', t`Tag Management`);
    const empty = element('div', 'sb-tag-manager__empty');
    const status = element('div', 'sb-list-editor__status');
    status.setAttribute('aria-live', 'polite');
    const restoreInput = element('input');
    restoreInput.type = 'file';
    restoreInput.id = 'tag_view_restore_input';
    restoreInput.accept = '.json';
    restoreInput.hidden = true;
    scroller.append(newGroup, list, empty);
    root.append(header, searchField, scroller, status, restoreInput);
    host.append(backdrop, root);
    const search = createListSearch({
        field: searchField, input: searchInput, scope: root, scroller, status,
        debounce: 300, onChange: () => refresh(),
    });
    searchInput.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.isComposing) return;
        // This search is always visible (there is no reveal button to reopen it).
        event.preventDefault();
        event.stopImmediatePropagation();
        search.clear();
    }, true);
    const sheet = createSheetController({
        sheet: root, backdrop, getInitialFocus: () => searchInput,
        getReturnFocus: () => returnFocus, canClose: () => canClose(), canAnimateClose: () => mobile.matches,
        onClose: () => {
            if (suspended) {
                // The shared action menu temporarily owns the one-sheet focus trap.
                root.hidden = false;
                backdrop.hidden = false;
                return;
            }
            dispose();
        },
    });

    function setError(input, error, message = '') {
        error.textContent = message;
        error.hidden = !message;
        input.setAttribute('aria-invalid', String(Boolean(message)));
    }

    function commitName(tag, input, error, focusInvalid = false) {
        if (!tag) return true;
        if (input.value === tag.name) {
            setError(input, error);
            return true;
        }
        const parsed = parseTagName(input.value, getState().tags, tag.id);
        if (!parsed.ok) {
            setError(input, error, parsed.error);
            if (focusInvalid) {
                if (input.closest('[hidden]')) search.clear();
                input.focus({ preventScroll: true });
            }
            return false;
        }
        input.value = parsed.name;
        setError(input, error);
        if (parsed.name !== tag.name) {
            rename(tag, parsed.name);
            commit();
            refresh();
        }
        return true;
    }

    function canClose() {
        for (const tag of getState().tags) {
            const entry = controls.get(tag.id);
            if (entry && !commitName(tag, entry.input, entry.error, true)) return false;
        }
        return true;
    }

    function close() {
        if (suspended || disposed) return false;
        if (mobile.matches) return sheet.close();
        if (!canClose()) return false;
        dispose();
        return true;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        closeActionMenu({ animate: false });
        sortable?.destroy();
        headerControl.destroy();
        unbindKeyboard();
        search.destroy();
        mobile.removeEventListener('change', layoutChanged);
        // The action-menu singleton reuses its sheet; do not remove its cached frame with this dialog.
        for (const layer of host.querySelectorAll('.sb-action-sheet, .sb-action-sheet-backdrop')) document.body.append(layer);
        host.close();
        host.remove();
        if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
        finish();
    }

    function mutate(action) {
        if (!canClose()) return;
        action();
        commit();
        refresh();
    }

    function item(label, glyph, action, options = {}) {
        return { label, icon: `fa-solid fa-${glyph}`, ...options, onSelect: () => {
            Promise.resolve().then(action).then(() => refresh()).catch(error => globalThis.toastr?.error(error.message));
        } };
    }

    function headerSections() {
        const { settings } = getState();
        return [
            { title: t`Sort mode`, items: [
                ['manual', t`Manual (Drag & Drop)`], ['alphabetical', t`Alphabetical (A-Z)`], ['by_entries', t`Most Used (By Count)`],
            ].map(([mode, label]) => item(label, 'arrow-down-wide-short', () => mutate(() => settings.tag_sort_mode = mode), { checked: settings.tag_sort_mode === mode })) },
            { items: [item(t`Tags as Folders`, 'folder', () => mutate(() => settings.bogus_folders = !settings.bogus_folders), { checked: Boolean(settings.bogus_folders) })] },
            { items: [item(t`Backup`, 'file-export', actions.backup), item(t`Restore`, 'file-import', actions.restore), item(t`Prune`, 'scissors', actions.prune)] },
        ];
    }

    function openMenu(trigger, sections) {
        if (!canClose()) return;
        suspended = mobile.matches;
        openActionMenu({ trigger, title: t`Tag Management`, sections, bounds: root, onClose: () => {
            if (!suspended || disposed) return;
            suspended = false;
            root.hidden = true;
            sheet.open();
            stopMotion(root);
            stopMotion(backdrop);
        } });
        // Native modal dialogs make body-mounted menus inert; keep the shared menu in their top layer.
        for (const layer of document.querySelectorAll('.sb-action-popover, .sb-action-sheet, .sb-action-sheet-backdrop')) {
            host.append(layer);
        }
    }

    function move(tag, direction) {
        const state = getState();
        if (state.settings.tag_sort_mode !== 'manual' || search.query) return;
        const ordered = adapter.sort(state.tags, countLiveTagEntities(state.tagMap, state.characters, state.groups));
        const index = ordered.indexOf(tag);
        if (!ordered[index + direction]) return;
        [ordered[index], ordered[index + direction]] = [ordered[index + direction], ordered[index]];
        mutate(() => ordered.forEach((entry, position) => entry.sort_order = position));
    }

    function rowSections(tag, row) {
        const state = getState();
        const ordered = adapter.sort(state.tags, countLiveTagEntities(state.tagMap, state.characters, state.groups));
        const index = ordered.indexOf(tag);
        const manual = state.settings.tag_sort_mode === 'manual' && !search.query;
        return [{ items: [
            // HUMAN: replace — Background colour action label.
            item(t`lorum ipsum`, 'palette', () => showColor(tag, 'color')),
            // HUMAN: replace — Text colour action label.
            item(t`lorum ipsum`, 'font', () => showColor(tag, 'color2')),
            item(t`Hide on character card`, 'eye-slash', () => mutate(() => tag.is_hidden_on_character_card = !tag.is_hidden_on_character_card), { checked: Boolean(tag.is_hidden_on_character_card) }),
        ] }, { items: [
            item(t`Move up`, 'arrow-up', () => move(tag, -1), { disabled: !manual || index === 0 }),
            item(t`Move down`, 'arrow-down', () => move(tag, 1), { disabled: !manual || index === ordered.length - 1 }),
        ] }, { items: [item(t`Delete`, 'trash-can', async () => {
            await actions.delete(row);
            refresh();
        }, { danger: true })] }];
    }

    function showColor(tag, property) {
        const entry = controls.get(tag.id);
        let picker = entry.pickers[property];
        if (!picker) {
            const wrapper = element('div', 'tag_view_color_picker');
            wrapper.dataset.value = property;
            picker = element('toolcool-color-picker');
            const defaultColor = property === 'color' ? 'rgba(0, 0, 0, 0.5)' : getState().settings.main_text_color;
            picker.id = `${tag.id}-tag-${property}`;
            picker.setAttribute('color', tag[property] || defaultColor);
            picker.setAttribute('data-default-color', defaultColor);
            // HUMAN: replace — Background/text colour picker accessible label.
            picker.setAttribute('aria-label', t`lorum ipsum`);
            picker.addEventListener('change', event => actions.color(event, property));
            const reset = button(t`Link to theme color`, 'link', () => picker.color = defaultColor);
            const dismiss = button(t`Close`, 'xmark', () => entry.colors.hidden = true);
            wrapper.append(picker, reset, dismiss);
            entry.colors.append(wrapper);
            entry.pickers[property] = picker;
        }
        const color = tag[property] || picker.getAttribute('data-default-color');
        if (picker.getAttribute('color') !== color) picker.setAttribute('color', color);
        entry.colors.hidden = false;
        for (const child of entry.colors.children) child.hidden = child !== picker.parentElement;
        requestAnimationFrame(() => {
            picker.scrollIntoView?.({ block: 'nearest' });
            picker.shadowRoot?.querySelector('.button')?.click();
        });
    }

    function makeRow(tag) {
        // Restore can replace an object while retaining its id; event handlers always resolve the live object.
        const currentTag = () => getState().tags.find(candidate => candidate.id === tag.id);
        const input = element('input', 'sb-tag-manager__name tag_view_name');
        input.dataset.sbRename = 'true';
        input.value = tag.name;
        input.setAttribute('aria-label', t`Rename`);
        const error = element('small', 'sb-tag-manager__error');
        error.id = `sb-tag-error-${tag.id}`;
        error.hidden = true;
        input.setAttribute('aria-describedby', error.id);
        const name = element('div', 'sb-tag-manager__name-field');
        name.append(input, error);
        const dot = element('span', 'sb-tag-manager__dot');
        dot.dataset.sbTagId = tag.id;
        dot.setAttribute('aria-hidden', 'true');
        const folder = button('', 'folder', () => mutate(() => actions.folder(row)), 'tag_as_folder sb-tag-manager__folder');
        const more = button(t`Manage tags`, 'ellipsis-vertical', trigger => openMenu(trigger, rowSections(currentTag(), row)), 'sb-tag-manager__row-menu');
        more.setAttribute('aria-haspopup', 'menu');
        const entity = createEntityRow({
            key: entityKey('tag', tag.id), label: tag.name, title: name, avatar: dot,
            subtitle: '', grip: true, suffix: [folder, more],
            compatClasses: { row: ['tag_view_item'] }, attributes: { id: tag.id },
        });
        const { row, slots } = entity;
        // Preserve the upstream counter's number + nonbreaking space + localized tag_entries format.
        const count = element('span');
        const countValue = element('span', 'tag_view_counter_value');
        const countLabel = element('span', '', translate('entries', 'tag_entries'));
        countLabel.dataset.i18n = 'tag_entries';
        count.append(countValue, document.createTextNode('\u00a0'), countLabel);
        entity.update({ subtitle: count });
        slots.grip.classList.add('drag-handle');
        row.tabIndex = 0;
        const colors = element('div', 'sb-tag-manager__colors');
        colors.hidden = true;
        const pickers = {};
        row.append(colors);
        controls.set(tag.id, { entity, input, error, folder, colors, pickers, countValue });
        input.addEventListener('blur', () => {
            // insertBefore temporarily blurs a focused input; a DOM move is not a user commit.
            if (!reconciling) commitName(currentTag(), input, error);
        });
        input.addEventListener('input', () => {
            if (input.getAttribute('aria-invalid') !== 'true') return;
            const parsed = parseTagName(input.value, getState().tags, tag.id);
            setError(input, error, parsed.ok ? '' : parsed.error);
        });
        input.addEventListener('keydown', event => {
            if (event.isComposing) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                input.value = currentTag()?.name ?? '';
                setError(input, error);
            } else if (event.key === 'Enter') {
                event.preventDefault();
                commitName(currentTag(), input, error, true);
            }
        });
        return row;
    }

    function refresh() {
        if (disposed || dragging || reconciling) return;
        const state = getState();
        const counts = countLiveTagEntities(state.tagMap, state.characters, state.groups);
        const sorted = adapter.sort(state.tags, counts);
        const query = search.query.trim().toLowerCase();
        const focused = root.contains(document.activeElement) ? document.activeElement : null;
        const pendingField = focused instanceof HTMLInputElement ? {
            value: focused.value, start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection,
        } : null;
        const scrollTop = scroller.scrollTop;
        // Keep pending fields mounted even when an external update or search hides their row.
        reconciling = true;
        try {
            reconcileRows({ container: list, cache, entries: sorted, key: tag => entityKey('tag', tag.id), signature: tag => tag.id,
                create: makeRow, update: (row, tag) => {
                    const entry = controls.get(tag.id);
                    if (focused !== entry.input && entry.input.getAttribute('aria-invalid') !== 'true') entry.input.value = tag.name;
                    entry.entity.update({ label: tag.name });
                    entry.countValue.textContent = String(counts.get(tag.id) ?? 0);
                    entry.folder.hidden = !state.settings.bogus_folders;
                    const type = folderTypes[tag.folder_type] ?? folderTypes.NONE;
                    entry.folder.title = translate(type.tooltip);
                    entry.folder.setAttribute('aria-label', entry.folder.title);
                    entry.folder.replaceChildren(icon((type.fa_icon ?? 'fa-folder').replace(/^fa-/, '')));
                    entry.folder.setAttribute('aria-pressed', String(tag.folder_type === 'OPEN' || tag.folder_type === 'CLOSED'));
                    entry.entity.slots.grip.hidden = Boolean(query);
                    row.hidden = Boolean(query) && !tag.name.toLowerCase().includes(query);
                    updateTagColors(tag, row);
                },
            });
            const liveIds = new Set(state.tags.map(tag => tag.id));
            for (const id of controls.keys()) if (!liveIds.has(id)) controls.delete(id);
            if (focused?.isConnected) {
                if (pendingField) focused.value = pendingField.value;
                if (document.activeElement !== focused) focused.focus({ preventScroll: true });
                if (pendingField && pendingField.start !== null) {
                    focused.setSelectionRange(pendingField.start, pendingField.end, pendingField.direction);
                }
            }
            scroller.scrollTop = scrollTop;
        } finally {
            reconciling = false;
        }
        const shown = [...list.children].filter(row => !row.hidden).length;
        list.hidden = !shown;
        empty.hidden = Boolean(shown);
        if (!shown) empty.replaceChildren(createStatusPage({ icon: 'tags', title: query ? t`No results` : t`Create a new tag`, compact: true }).element);
        search.report(shown, state.tags.length);
        sortable?.setDisabled(Boolean(query));
    }

    function createPending() {
        if (!newInput.value.trim()) return;
        const parsed = parseTagName(newInput.value, getState().tags);
        setError(newInput, newError, parsed.ok ? '' : parsed.error);
        if (!parsed.ok) return;
        const tag = create(parsed.name);
        newInput.value = '';
        search.clear();
        commit();
        refresh();
        controls.get(tag.id)?.input.focus({ preventScroll: false });
    }
    newInput.addEventListener('blur', createPending);
    newInput.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); createPending(); }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            newInput.value = '';
            setError(newInput, newError);
        }
    });
    const unbindKeyboard = bindListKeyboard(list, { onRename: row => row.querySelector('input')?.focus() });
    const sortable = bindSortable(list, {
        handle: '.drag-handle', items: '.tag_view_item', touch: () => mobile.matches,
        start: () => { dragging = true; }, update: () => {
            const ids = [...list.children].map(row => row.id);
            const state = getState();
            state.tags.forEach(tag => tag.sort_order = ids.indexOf(tag.id));
            state.settings.tag_sort_mode = 'manual';
            commit();
        }, stop: () => { dragging = false; refresh(); },
    });
    let dragStart = null;
    handle.addEventListener('pointerdown', event => {
        dragStart = event.clientY;
        handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener('pointerup', event => {
        if (mobile.matches && dragStart !== null && event.clientY - dragStart >= 80) close();
        dragStart = null;
    });
    handle.addEventListener('pointercancel', () => dragStart = null);
    host.addEventListener('cancel', event => { event.preventDefault(); close(); });
    host.addEventListener('close', () => { if (!disposed) dispose(); });
    blockUpstreamDrawerClose(host);
    function layoutChanged() {
        if (disposed) return;
        host.dataset.mobile = String(mobile.matches);
        if (mobile.matches) {
            root.hidden = true;
            sheet.open();
        } else {
            stopMotion(root);
            stopMotion(backdrop);
            root.hidden = false;
            backdrop.hidden = false;
        }
    }
    mobile.addEventListener('change', layoutChanged);
    refresh();
    return {
        root, host, closed, refresh, close, canClose,
        focus: () => searchInput.focus({ preventScroll: true }),
        show() {
            document.body.append(host);
            host.showModal();
            layoutChanged();
            if (!mobile.matches) animateIn(root, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], SPRING_SHEET);
            searchInput.focus({ preventScroll: true });
        },
    };
}
