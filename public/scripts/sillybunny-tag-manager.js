import { t, translate } from './i18n.js';
import { createEntityRow, entityKey } from './sillybunny-editor/entity-row.js';
import { reconcileRows, bindListKeyboard, bindSortable } from './sillybunny-editor/list-rows.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { openPicker } from './sillybunny-editor/picker.js';
import { openDialog, createIconButton } from './sillybunny-editor/dialog.js';
import { reorderMenuItems } from './sillybunny-editor/reorder-menu.js';
import { LAYOUT_MOBILE_QUERY } from './sillybunny-editor/breakpoints.js';
import { openActionMenu, openPopover } from './sillybunny-action-menu.js';
import { confirmDestructiveAction } from './sillybunny-delete-confirm.js';

const STYLESHEETS = [
    { href: 'css/sillybunny-editor-shell.css?v=20261118zv', id: 'deferred-editor-shell-css' },
    { href: 'css/sillybunny-entity-list.css?v=20261118zza', id: 'deferred-entity-list-css' },
    { href: 'css/sillybunny-tag-manager.css?v=20261117h', id: 'deferred-tag-manager-css' },
];
const BATCH_SIZE = 50;
/** @type {typeof import('./sillybunny-editor/list-show-more.js').createListShowMore|null} */
let createListShowMore = null;
/** @type {typeof import('./sillybunny-editor/selection-mode.js').createSelectionMode|null} */
let createSelectionMode = null;
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

function rowButton(label, glyph, action, className = '') {
    const node = element('button', `ds-entity-row__button ${className}`.trim());
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
    if (!name) return { ok: false, error: t`Enter a name.` };
    const normalized = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const duplicate = tags.some(tag => tag.id !== ownId
        && tag.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() === normalized);
    if (duplicate) return { ok: false, error: t`That name is already in use.` };
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

/** The Show More row and the selection mode are only needed once the dialog opens, so their modules stay out of the startup graph. */
export async function loadTagManagerModules() {
    [{ createListShowMore }, { createSelectionMode }] = await Promise.all([
        import('./sillybunny-editor/list-show-more.js'),
        import('./sillybunny-editor/selection-mode.js'),
    ]);
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
        await Promise.all([loadTagManagerStyles(), loadTagManagerModules()]);
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
    const { getState, commit, create, rename, actions } = adapter;
    const layout = window.matchMedia(LAYOUT_MOBILE_QUERY);
    const cache = new Map();
    const controls = new Map();
    let disposed = false;
    let dragging = false;
    let reconciling = false;
    let batches = 1;
    let lastQuery = '';
    let revealId = null;
    let lastView = null;
    let addButton = null;
    let visibleIds = [];
    let selection = null;
    let bulkBusy = false;
    let finish;
    const closed = new Promise(resolve => finish = resolve);
    /** @type {ReturnType<typeof openDialog>|null} */
    let frame = null;
    const search = {
        get query() { return frame?.search?.query ?? ''; },
        clear() { frame?.search?.clear(); },
        report(shown, total) { frame?.search?.report(shown, total); },
    };
    const box = element('div', 'ds-entity-list sb-tag-manager__list');
    // The upstream reprint paths look rows up under `.tag_view_list_tags`, so the rows container carries it.
    const list = element('div', 'ds-entity-list__rows tag_view_list_tags');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', t`Tag Management`);
    const footer = element('div', 'ds-entity-list__footer');
    footer.hidden = true;
    const showMore = createListShowMore({ onShowMore: () => {
        batches += 1;
        refresh();
    } });
    footer.append(showMore.element);
    box.append(list, footer);
    const empty = element('div', 'sb-tag-manager__empty');
    const selectionBar = element('div', 'sb-tag-manager__selection-bar');
    const sortButton = createIconButton(t`Sort`, 'arrow-down-wide-short', 'sb-header-icon-button sb-tag-manager__sort');
    sortButton.setAttribute('aria-haspopup', 'menu');
    sortButton.setAttribute('aria-pressed', 'false');
    sortButton.addEventListener('click', () => openMenu(sortButton, sortSections(), t`Sort`));
    const restoreInput = element('input');
    restoreInput.type = 'file';
    restoreInput.id = 'tag_view_restore_input';
    restoreInput.accept = '.json';
    restoreInput.hidden = true;
    const content = document.createDocumentFragment();
    content.append(box, empty, restoreInput);

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
        if (disposed || !frame) return false;
        return frame.close('close', 'close');
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        selection?.destroy();
        sortable?.destroy();
        unbindKeyboard();
        finish();
    }

    function mutate(action) {
        if (!canClose()) return false;
        action();
        commit();
        refresh();
        return true;
    }

    function item(label, glyph, action, options = {}) {
        return { label, icon: `fa-solid fa-${glyph}`, ...options, onSelect: () => {
            Promise.resolve().then(action).then(() => refresh()).catch(error => globalThis.toastr?.error(error.message));
        } };
    }

    function headerSections(trigger) {
        return [
            { items: [item(t`Select`, 'check-double', () => selection.enter(null, trigger), { disabled: bulkBusy || !getState().tags.length })] },
            { items: [item(t`Backup`, 'file-export', actions.backup), item(t`Restore`, 'file-import', actions.restore), item(t`Prune`, 'scissors', actions.prune)] },
        ];
    }

    function sortSections() {
        const { settings } = getState();
        return [{ title: t`Sort mode`, items: [
            ['manual', t`Manual (Drag & Drop)`], ['alphabetical', t`Alphabetical (A-Z)`], ['by_entries', t`Most Used (By Count)`],
        ].map(([mode, label]) => item(label, 'arrow-down-wide-short', () => mutate(() => settings.tag_sort_mode = mode), { kind: 'radio', checked: settings.tag_sort_mode === mode })) }];
    }

    /** The Search toggle and the sort button show that the list is not in its manual order. */
    function syncSortState() {
        const altered = getState().settings.tag_sort_mode !== 'manual';
        sortButton?.setAttribute('aria-pressed', String(altered));
        frame?.searchToggle?.setAttribute('aria-pressed', String(altered));
    }

    const existingSelected = (keys = selection.selectedKeys) => {
        const live = new Set(getState().tags.map(tag => tag.id));
        return keys.filter(id => live.has(id));
    };

    async function deleteSelected(keys) {
        const ids = existingSelected(keys);
        if (!ids.length || bulkBusy || !canClose()) return;
        bulkBusy = true;
        selectionBar.inert = true;
        try {
            // HUMAN: replace — bulk delete confirmation; the selected count remains explicit.
            const text = ids.length === 1 ? t`Delete this tag? This cannot be undone.` : t`Delete ${ids.length} tags? This cannot be undone.`;
            if (!await confirmDestructiveAction({ text, confirmLabel: t`Delete` })) return;
            await actions.deleteMany(existingSelected(ids));
            selection.exit();
            refresh();
        } finally {
            bulkBusy = false;
            selectionBar.inert = false;
        }
    }

    /** Rows take no edit while they are being selected: the name field and the manage button leave the tab order. */
    function syncSelectionState() {
        const active = Boolean(selection?.isActive);
        for (const entry of controls.values()) {
            entry.input.inert = active;
            for (const suffix of entry.entity.row.querySelectorAll('.ds-entity-row__suffix')) suffix.inert = active;
        }
        sortable?.setDisabled(active || Boolean(search.query));
    }

    function openMenu(trigger, sections, title = t`Tag Management`) {
        if (!canClose()) return;
        openActionMenu({ trigger, title, sections, bounds: frame?.surface ?? null });
    }

    function move(tag, direction) {
        const state = getState();
        if (state.settings.tag_sort_mode !== 'manual' || search.query) return false;
        const ordered = adapter.sort(state.tags, countLiveTagEntities(state.tagMap, state.characters, state.groups));
        const index = ordered.indexOf(tag);
        if (!ordered[index + direction]) return false;
        [ordered[index], ordered[index + direction]] = [ordered[index + direction], ordered[index]];
        revealId = tag.id;
        const moved = mutate(() => ordered.forEach((entry, position) => entry.sort_order = position));
        revealId = null;
        return moved;
    }

    function rowSections(tag, row) {
        const state = getState();
        const ordered = adapter.sort(state.tags, countLiveTagEntities(state.tagMap, state.characters, state.groups));
        const index = ordered.indexOf(tag);
        const moves = reorderMenuItems({
            index,
            count: ordered.length,
            filtered: state.settings.tag_sort_mode !== 'manual' || Boolean(search.query),
            name: tag.name,
            move: to => move(tag, to - index),
            onError: error => globalThis.toastr?.error(error.message),
            focus: () => row,
        });
        return [{ items: [
            item(t`Background Color`, 'palette', () => showColor(tag, 'color')),
            item(t`Text Color`, 'font', () => showColor(tag, 'color2')),
        ] }, { items: [
            item(t`Hide on Character Card`, 'eye-slash', () => mutate(() => tag.is_hidden_on_character_card = !tag.is_hidden_on_character_card), { kind: 'check', checked: Boolean(tag.is_hidden_on_character_card) }),
        ] }, { items: moves }, { items: [item(t`Delete`, 'trash-can', () => actions.delete(row), { danger: true })] }];
    }

    function renderTagMembers(tag, container, onAdd) {
        const state = getState();
        const keys = Object.entries(state.tagMap).filter(([, ids]) => Array.isArray(ids) && ids.includes(tag.id)).map(([key]) => key);
        const members = [
            ...state.characters.filter(character => keys.includes(String(character.avatar))).map(character => ({
                key: String(character.avatar), name: String(character.name ?? character.avatar), avatar: adapter.getAvatar?.(character),
            })),
            ...state.groups.filter(group => keys.includes(String(group.id))).map(group => ({
                key: String(group.id), name: String(group.name ?? group.id), avatar: adapter.getGroupAvatar?.(group),
            })),
        ];
        const rows = members.map(member => {
            const remove = rowButton(t`Remove`, 'minus', () => {
                actions.removeMember(tag, member.key);
                renderTagMembers(tag, container, onAdd);
                commit();
            }, 'sb-tag-manager__member-remove');
            return createEntityRow({
                key: `tag-member:${tag.id}:${member.key}`,
                label: member.name,
                title: member.name,
                avatar: member.avatar ?? null,
                suffix: [remove],
                compatClasses: { row: ['ds-entity-row--surface'] },
            }).row;
        });
        if (!rows.length) {
            rows.push(createStatusPage({
                state: 'empty', icon: 'users', title: t`No Members`, compact: true,
                actions: [{ label: t`Add`, primary: true, onActivate: onAdd }],
            }).element);
        }
        container.replaceChildren(...rows);
    }

    function openMembers(tag) {
        if (!frame || !tag) return;
        const list = element('div', 'ds-entity-list sb-tag-manager__members');
        list.setAttribute('role', 'list');
        const add = createIconButton(t`Add`, 'plus', 'sb-tag-manager__member-add');
        const onAdd = () => {
            const state = getState();
            const assigned = new Set(Object.entries(state.tagMap).filter(([, ids]) => Array.isArray(ids) && ids.includes(tag.id)).map(([key]) => key));
            const items = [
                ...state.characters.filter(character => !assigned.has(String(character.avatar))).map(character => ({ value: String(character.avatar), label: String(character.name ?? character.avatar) })),
                ...state.groups.filter(group => !assigned.has(String(group.id))).map(group => ({ value: String(group.id), label: String(group.name ?? group.id) })),
            ];
            openPicker({
                trigger: add,
                title: t`Add`,
                items,
                selected: null,
                searchLabel: t`Search`,
                emptyText: t`No Results`,
                bounds: frame?.surface ?? null,
                onSelect: key => {
                    if (assigned.has(key)) return;
                    actions.addMember(tag, key);
                    commit();
                    renderTagMembers(tag, list, onAdd);
                },
            });
        };
        add.addEventListener('click', onAdd);
        const content = document.createDocumentFragment();
        content.append(list);
        const page = frame.push({ title: tag.name, content, initialFocus: () => add });
        page.header.querySelector('.sb-dialog__header-end').append(add);
        renderTagMembers(tag, list, onAdd);
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
            picker.setAttribute('aria-label', property === 'color' ? t`Background Color` : t`Text Color`);
            picker.addEventListener('change', event => actions.color(event, property));
            const reset = rowButton(t`Link to Theme Color`, 'link', () => picker.color = defaultColor);
            const dismiss = rowButton(t`Close`, 'xmark', () => entry.colors.hidden = true);
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

    /** Upstream's label is plural only ("1 entries"), so a count of one takes the singular, which has no upstream locale key. */
    function setCount(entry, count) {
        entry.countValue.textContent = String(count);
        const label = entry.countLabel;
        if (count === 1) {
            label.textContent = t`entry`;
            label.removeAttribute('data-i18n');
        } else if (!label.dataset.i18n) {
            label.textContent = translate('entries', 'tag_entries');
            label.dataset.i18n = 'tag_entries';
        }
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
        const name = element('div', 'sb-tag-manager__field');
        name.append(input, error);
        const dot = element('span', 'sb-tag-manager__dot');
        dot.dataset.sbTagId = tag.id;
        dot.setAttribute('aria-hidden', 'true');
        const more = rowButton(t`Manage Tags`, 'ellipsis-vertical', trigger => openMenu(trigger, rowSections(currentTag(), row), currentTag().name), 'sb-tag-manager__row-menu');
        more.setAttribute('aria-haspopup', 'menu');
        const entity = createEntityRow({
            key: entityKey('tag', tag.id), label: tag.name, title: name, avatar: dot,
            subtitle: '', grip: true, suffix: [more],
            activation: 'navigate',
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
        slots.grip.addEventListener('click', event => event.stopPropagation());
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-haspopup', 'dialog');
        const colors = element('div', 'sb-tag-manager__colors');
        colors.hidden = true;
        const pickers = {};
        row.append(colors);
        controls.set(tag.id, { entity, input, error, colors, pickers, countValue, countLabel });
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

    /** Fields whose change alters a mounted row, the rows shown or their order. */
    function viewFingerprint(sorted, counts, query, pinned, sortMode) {
        const parts = [query, batches, sortMode, [...pinned].join(',')];
        for (const tag of sorted) parts.push(`${tag.id}\u0002${tag.name}\u0002${tag.color ?? ''}\u0002${tag.color2 ?? ''}\u0002${counts.get(tag.id) ?? 0}`);
        return parts.join('\u0001');
    }

    function refresh() {
        if (disposed || dragging || reconciling) return;
        const state = getState();
        const counts = countLiveTagEntities(state.tagMap, state.characters, state.groups);
        const sorted = adapter.sort(state.tags, counts);
        const query = search.query.trim().toLowerCase();
        if (query !== lastQuery) {
            lastQuery = query;
            batches = 1;
        }
        const matches = query ? sorted.filter(tag => tag.name.toLowerCase().includes(query)) : sorted;
        visibleIds = matches.map(tag => tag.id);
        syncSortState();
        if (revealId !== null) {
            const index = matches.findIndex(tag => tag.id === revealId);
            if (index >= 0) batches = Math.max(batches, Math.ceil((index + 1) / BATCH_SIZE));
            revealId = null;
        }
        const shownTags = matches.slice(0, batches * BATCH_SIZE);
        const shownIds = new Set(shownTags.map(tag => tag.id));
        // A row with a pending edit stays mounted, hidden, when a search or a batch limit would drop it.
        const pinned = new Set();
        for (const [id, entry] of controls) {
            if (entry.input === document.activeElement || entry.input.getAttribute('aria-invalid') === 'true') pinned.add(id);
        }
        const fingerprint = viewFingerprint(sorted, counts, query, pinned, state.settings.tag_sort_mode);
        if (fingerprint === lastView) return;
        lastView = fingerprint;
        const scroller = frame?.body ?? null;
        const focused = list.contains(document.activeElement) ? document.activeElement : null;
        const pendingField = focused instanceof HTMLInputElement ? {
            value: focused.value, start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection,
        } : null;
        const scrollTop = scroller?.scrollTop ?? 0;
        reconciling = true;
        try {
            const keys = reconcileRows({ container: list, cache, entries: sorted.filter(tag => shownIds.has(tag.id) || pinned.has(tag.id)),
                key: tag => entityKey('tag', tag.id), signature: tag => tag.id,
                create: makeRow, update: (row, tag) => {
                    const entry = controls.get(tag.id);
                    if (focused !== entry.input && entry.input.getAttribute('aria-invalid') !== 'true') entry.input.value = tag.name;
                    entry.entity.update({ label: tag.name });
                    setCount(entry, counts.get(tag.id) ?? 0);
                    entry.entity.slots.grip.hidden = Boolean(query);
                    row.hidden = !shownIds.has(tag.id);
                    updateTagColors(tag, row);
                },
            });
            for (const id of controls.keys()) if (!keys.has(String(entityKey('tag', id)))) controls.delete(id);
            if (focused?.isConnected) {
                if (pendingField) focused.value = pendingField.value;
                if (document.activeElement !== focused) focused.focus({ preventScroll: true });
                if (pendingField && pendingField.start !== null) {
                    focused.setSelectionRange(pendingField.start, pendingField.end, pendingField.direction);
                }
            }
            if (scroller) scroller.scrollTop = scrollTop;
        } finally {
            reconciling = false;
        }
        const shown = shownTags.length;
        box.hidden = !shown;
        empty.hidden = Boolean(shown);
        if (!shown) {
            empty.replaceChildren(createStatusPage({
                state: query ? 'no-results' : 'empty', icon: 'tags', title: query ? t`No Results Found` : t`Create a New Tag`, compact: true,
                description: query ? t`Try a different search` : undefined,
                actions: query ? [] : [{ label: t`New`, primary: true, onActivate: () => openCreatePopover(addButton) }],
            }).element);
        }
        showMore.update({ shown, total: matches.length });
        footer.hidden = showMore.isComplete;
        search.report(matches.length, state.tags.length);
        selection?.decorate({ prune: true });
        syncSelectionState();
    }

    function createPending(input, error, popover) {
        const parsed = parseTagName(input.value, getState().tags);
        setError(input, error, parsed.ok ? '' : parsed.error);
        if (!parsed.ok) return;
        const tag = create(parsed.name);
        search.clear();
        commit();
        revealId = tag.id;
        refresh();
        popover.close();
        controls.get(tag.id)?.input.focus({ preventScroll: false });
    }

    function openCreatePopover(trigger) {
        const content = element('div', 'sb-manager-name-popover');
        const label = element('strong', 'sb-manager-name-popover__label', t`Create a New Tag`);
        const input = element('input', 'text_pole sb-dialog__entry sb-manager-name-popover__input');
        input.type = 'text';
        label.id = 'sb-tag-manager-new-label';
        const error = element('small', 'sb-tag-manager__error sb-manager-name-popover__error');
        error.hidden = true;
        input.setAttribute('aria-describedby', error.id = 'sb-tag-manager-new-error');
        const create = element('button', 'menu_button sb-dialog__response is-suggested menu_button_primary sb-manager-name-popover__create', t`Create`);
        create.type = 'button';
        create.disabled = true;
        const updateValidity = () => {
            const parsed = parseTagName(input.value, getState().tags);
            create.disabled = !parsed.ok;
            setError(input, error, input.value.trim() && !parsed.ok ? parsed.error : '');
        };
        create.addEventListener('click', () => createPending(input, error, popup));
        input.addEventListener('input', updateValidity);
        input.addEventListener('keydown', event => {
            if (event.isComposing || event.keyCode === 229) return;
            if (event.key !== 'Enter') return;
            updateValidity();
            if (!create.disabled) { event.preventDefault(); create.click(); }
        });
        content.append(label, input, error, create);
        const popup = openPopover({ trigger, content, title: t`Create a New Tag`, titleLabel: label, titleInput: input, bounds: frame?.surface ?? null, initialFocus: () => input });
    }
    const unbindKeyboard = bindListKeyboard(list, {
        keySourceSelector: '.drag-handle',
        onOpen: row => {
            if (!selection?.isActive) openMembers(getState().tags.find(tag => tag.id === row.id));
            return true;
        },
        onRename: row => { if (!selection?.isActive) row.querySelector('input')?.focus(); },
    });
    const sortable = bindSortable(list, {
        handle: '.drag-handle', items: '.tag_view_item', touch: () => layout.matches,
        start: () => { dragging = true; }, update: () => {
            const state = getState();
            // Rows beyond the loaded batches keep the order they had, after the rows that were dragged.
            const previous = adapter.sort(state.tags, countLiveTagEntities(state.tagMap, state.characters, state.groups));
            const loaded = new Set([...list.children].map(row => row.id));
            const order = [...loaded, ...previous.map(tag => tag.id).filter(id => !loaded.has(id))];
            state.tags.forEach(tag => tag.sort_order = order.indexOf(tag.id));
            state.settings.tag_sort_mode = 'manual';
            commit();
        }, stop: () => { dragging = false; refresh(); },
    });
    refresh();
    const searchInput = () => frame?.surface.querySelector('.sb-dialog__search-input') ?? null;
    return {
        /** The dialog surface (`#tag_view_list`), available after show(). */
        get root() { return frame?.surface ?? null; },
        get host() { return frame?.root ?? null; },
        closed, refresh, close, canClose,
        focus: () => (frame?.search?.isOpen ? searchInput() : frame?.searchToggle)?.focus({ preventScroll: true }),
        show() {
            if (frame) return;
            frame = openDialog({
                tier: 'window',
                title: t`Tag Management`,
                className: 'sb-tag-manager',
                content,
                search: { placeholder: t`Search…`, label: t`Search`, collapsed: true, escapeClearsFirst: true, closeEmptyOnBlur: true, typeToSearchSelector: '.tag_view_item', debounce: 300, controls: [sortButton], onChange: () => refresh() },
                // A pending invalid rename blocks the menus as it blocks closing.
                menu: trigger => (canClose() ? headerSections(trigger) : []),
                menuLabel: t`Tag Management`,
                canClose: () => canClose(),
            });
            frame.surface.id = 'tag_view_list';
            frame.body.after(selectionBar);
            const slots = {
                get header() { return frame.header; },
                get headerStart() { return frame.headerStart; },
                get headerEnd() { return frame.headerEnd; },
                get titleNode() { return frame.titleNode; },
                get search() { return frame.search; },
                get closeButton() { return frame.closeButton; },
            };
            selection = createSelectionMode({
                root: frame.surface, list, rowSelector: '.tag_view_item', getKey: row => row.id, keySourceSelector: '.drag-handle',
                range: true, iconOnlyAtNarrow: true, headerSlots: slots, actionBar: selectionBar,
                getAllKeys: () => visibleIds,
                canEnter: () => !bulkBusy && canClose() && getState().tags.length > 0,
                actions: [
                    { id: 'delete', label: t`Delete`, icon: 'fa-solid fa-trash', danger: true, onActivate: keys => deleteSelected(keys) },
                ],
                onChange: () => syncSelectionState(), onExit: () => syncSelectionState(),
            });
            const add = createIconButton(t`Create a New Tag`, 'plus', 'sb-tag-manager__add');
            add.addEventListener('click', () => openCreatePopover(add));
            add.addEventListener('keydown', event => {
                if (event.key === 'Enter') event.stopPropagation();
            });
            addButton = add;
            frame.header.querySelector('.sb-dialog__header-end').prepend(add);
            frame.closed.then(dispose);
            lastView = null;
            refresh();
        },
    };
}
