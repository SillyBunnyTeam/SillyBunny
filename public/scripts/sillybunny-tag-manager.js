import { t, translate } from './i18n.js';
import { createEntityRow, entityKey } from './sillybunny-editor/entity-row.js';
import { reconcileRows, bindListKeyboard, bindSortable } from './sillybunny-editor/list-rows.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { openPicker } from './sillybunny-editor/picker.js';
import { openDialog } from './sillybunny-editor/dialog.js';
import { LAYOUT_MOBILE_QUERY } from './sillybunny-editor/breakpoints.js';
import { openActionMenu, openPopover } from './sillybunny-action-menu.js';

const STYLESHEETS = [
    { href: 'css/sillybunny-editor-shell.css?v=20261018b', id: 'deferred-editor-shell-css' },
    { href: 'css/sillybunny-entity-list.css?v=20261018a', id: 'deferred-entity-list-css' },
    { href: 'css/sillybunny-tag-manager.css?v=20261021a', id: 'deferred-tag-manager-css' },
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
    const { getState, commit, create, rename, actions } = adapter;
    const layout = window.matchMedia(LAYOUT_MOBILE_QUERY);
    const cache = new Map();
    const controls = new Map();
    let disposed = false;
    let dragging = false;
    let reconciling = false;
    let finish;
    const closed = new Promise(resolve => finish = resolve);
    /** @type {ReturnType<typeof openDialog>|null} */
    let frame = null;
    const search = {
        get query() { return frame?.search?.query ?? ''; },
        clear() { frame?.search?.clear(); },
        report(shown, total) { frame?.search?.report(shown, total); },
    };
    const list = element('div', 'ds-pref-group ds-entity-list tag_view_list_tags');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', t`Tag Management`);
    const empty = element('div', 'sb-tag-manager__empty');
    const restoreInput = element('input');
    restoreInput.type = 'file';
    restoreInput.id = 'tag_view_restore_input';
    restoreInput.accept = '.json';
    restoreInput.hidden = true;
    const content = document.createDocumentFragment();
    content.append(list, empty, restoreInput);

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
        sortable?.destroy();
        unbindKeyboard();
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
            ].map(([mode, label]) => item(label, 'arrow-down-wide-short', () => mutate(() => settings.tag_sort_mode = mode), { kind: 'radio', checked: settings.tag_sort_mode === mode })) },
            { items: [item(t`Backup`, 'file-export', actions.backup), item(t`Restore`, 'file-import', actions.restore), item(t`Prune`, 'scissors', actions.prune)] },
        ];
    }

    function openMenu(trigger, sections) {
        if (!canClose()) return;
        openActionMenu({ trigger, title: t`Tag Management`, sections, bounds: frame?.surface ?? null });
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
        ] }, { items: [
            item(t`Hide on character card`, 'eye-slash', () => mutate(() => tag.is_hidden_on_character_card = !tag.is_hidden_on_character_card), { kind: 'check', checked: Boolean(tag.is_hidden_on_character_card) }),
        ] }, { items: [
            item(t`Move up`, 'arrow-up', () => move(tag, -1), { disabled: !manual || index === 0 }),
            item(t`Move down`, 'arrow-down', () => move(tag, 1), { disabled: !manual || index === ordered.length - 1 }),
        ] }, { items: [item(t`Delete`, 'trash-can', async () => {
            await actions.delete(row);
            refresh();
        }, { danger: true })] }];
    }

    function renderTagMembers(tag, container) {
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
            const remove = button(t`Remove`, 'minus', () => {
                actions.removeMember(tag, member.key);
                renderTagMembers(tag, container);
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
        if (!rows.length) rows.push(createStatusPage({ icon: 'users', title: t`No Members`, compact: true }).element);
        container.replaceChildren(...rows);
    }

    function openMembers(tag) {
        if (!frame || !tag) return;
        const list = element('div', 'ds-pref-group ds-entity-list sb-tag-manager__members');
        list.setAttribute('role', 'list');
        const add = button(t`Add`, 'plus', () => {
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
                emptyText: t`No results`,
                bounds: frame?.surface ?? null,
                onSelect: key => {
                    if (assigned.has(key)) return;
                    actions.addMember(tag, key);
                    commit();
                    renderTagMembers(tag, list);
                },
            });
        }, 'sb-tag-manager__member-add');
        const content = document.createDocumentFragment();
        content.append(list);
        const page = frame.push({ title: tag.name, content, initialFocus: () => add });
        add.classList.add('sb-dialog__icon-button');
        page.header.querySelector('.sb-dialog__header-end').append(add);
        renderTagMembers(tag, list);
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
        const more = button(t`Manage tags`, 'ellipsis-vertical', trigger => openMenu(trigger, rowSections(currentTag(), row)), 'sb-tag-manager__row-menu');
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
        controls.set(tag.id, { entity, input, error, colors, pickers, countValue });
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
        const scroller = frame?.body ?? null;
        const focused = list.contains(document.activeElement) ? document.activeElement : null;
        const pendingField = focused instanceof HTMLInputElement ? {
            value: focused.value, start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection,
        } : null;
        const scrollTop = scroller?.scrollTop ?? 0;
        // Keep pending fields mounted even when an external update or search hides their row.
        reconciling = true;
        try {
            reconcileRows({ container: list, cache, entries: sorted, key: tag => entityKey('tag', tag.id), signature: tag => tag.id,
                create: makeRow, update: (row, tag) => {
                    const entry = controls.get(tag.id);
                    if (focused !== entry.input && entry.input.getAttribute('aria-invalid') !== 'true') entry.input.value = tag.name;
                    entry.entity.update({ label: tag.name });
                    entry.countValue.textContent = String(counts.get(tag.id) ?? 0);
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
            if (scroller) scroller.scrollTop = scrollTop;
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

    function createPending(input, error, popover) {
        const parsed = parseTagName(input.value, getState().tags);
        setError(input, error, parsed.ok ? '' : parsed.error);
        if (!parsed.ok) return;
        const tag = create(parsed.name);
        search.clear();
        commit();
        refresh();
        popover.close();
        controls.get(tag.id)?.input.focus({ preventScroll: false });
    }

    function openCreatePopover(trigger) {
        const content = element('div', 'sb-manager-name-popover');
        const label = element('strong', 'sb-manager-name-popover__label', t`Create a new tag`);
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
        const popup = openPopover({ trigger, content, title: t`Create a new tag`, titleLabel: label, titleInput: input, bounds: frame?.surface ?? null, initialFocus: () => input });
    }
    const unbindKeyboard = bindListKeyboard(list, {
        keySourceSelector: '.drag-handle',
        onOpen: row => { openMembers(getState().tags.find(tag => tag.id === row.id)); return true; },
        onRename: row => row.querySelector('input')?.focus(),
    });
    const sortable = bindSortable(list, {
        handle: '.drag-handle', items: '.tag_view_item', touch: () => layout.matches,
        start: () => { dragging = true; }, update: () => {
            const ids = [...list.children].map(row => row.id);
            const state = getState();
            state.tags.forEach(tag => tag.sort_order = ids.indexOf(tag.id));
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
                search: { placeholder: t`Search...`, label: t`Search`, collapsed: true, escapeClearsFirst: true, typeToSearchSelector: '.tag_view_item', debounce: 300, onChange: () => refresh() },
                // A pending invalid rename blocks the menus as it blocks closing.
                menu: () => (canClose() ? headerSections() : []),
                menuLabel: t`Tag Management`,
                canClose: () => canClose(),
            });
            frame.surface.id = 'tag_view_list';
            const add = button(t`Create a new tag`, 'plus', openCreatePopover, 'sb-tag-manager__add');
            add.classList.add('sb-dialog__icon-button');
            frame.header.querySelector('.sb-dialog__header-end').prepend(add);
            frame.closed.then(dispose);
            refresh();
        },
    };
}
