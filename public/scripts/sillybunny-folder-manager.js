import { t } from './i18n.js';
import { folderCountLabel } from './sillybunny-editor/folder-row.js';
import { createEntityRow, entityKey } from './sillybunny-editor/entity-row.js';
import { reconcileRows, bindListKeyboard, bindSortable } from './sillybunny-editor/list-rows.js';
import { bindListFocus } from './sillybunny-editor/list-focus.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { openPicker } from './sillybunny-editor/picker.js';
import { openAlert, openDialog, createIconButton } from './sillybunny-editor/dialog.js';
import { announceReorder, LONG_LIST, reorderMenuItems } from './sillybunny-editor/reorder-menu.js';
import { LAYOUT_MOBILE_QUERY } from './sillybunny-editor/breakpoints.js';
import { openActionMenu } from './sillybunny-action-menu.js';
import { createSelectionMode } from './sillybunny-editor/selection-mode.js';
import { confirmDestructiveAction } from './sillybunny-delete-confirm.js';
import * as settingsFolderStore from './sillybunny-folders.js';
import { DEFAULT_FOLDER_COLOR, createFolderColorPicker, openFolderNamePopover, parseFolderName } from './sillybunny-editor/folder-popovers.js';

const STYLESHEETS = [
    { href: 'css/sillybunny-editor-shell.css?v=20261125a', id: 'deferred-editor-shell-css' },
    { href: 'css/sillybunny-entity-list.css?v=20261118zza', id: 'deferred-entity-list-css' },
    { href: 'css/sillybunny-folder-manager.css?v=20261117h', id: 'deferred-folder-manager-css' },
];

const MEMBER_KINDS = Object.freeze({ characters: 'character', groups: 'group', personas: 'persona', backgrounds: 'background', conversations: 'conversation' });
const SCOPES = Object.freeze(Object.keys(MEMBER_KINDS));
const PLACEHOLDER_COPY = 'TODO(copy)';

let activeManager = null;
let opening = null;

/** Persona, background and conversation wording is not written yet, so it shows the placeholder and says so in markup. */
function scopeCopy(scope) {
    if (scope === 'groups') {
        return {
            empty: t`Create a folder to sort groups in the list.`,
            noMembers: t`Add groups to this folder to list them under it.`,
            deleteBody: t`The groups in this folder stay in your library. They are no longer in a folder.`,
        };
    }
    if (scope === 'personas' || scope === 'backgrounds' || scope === 'conversations') return { empty: PLACEHOLDER_COPY, noMembers: PLACEHOLDER_COPY, deleteBody: PLACEHOLDER_COPY };
    return {
        empty: t`Create a folder to sort characters in the list.`,
        noMembers: t`Add characters to this folder to list them under it.`,
        deleteBody: t`The characters in this folder stay in your library. They are no longer in a folder.`,
    };
}

function markCopyPlaceholder(page) {
    const description = page.querySelector('.sb-status-page__description');
    if (description?.textContent === PLACEHOLDER_COPY) description.setAttribute('data-sb-copy-placeholder', 'true');
    return page;
}

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
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
        event.preventDefault();
        event.stopPropagation();
        action(node);
    });
    return node;
}

const folderName = parseFolderName;

function countLabel(count, scope) {
    return folderCountLabel(count, scope);
}

async function loadDefaultAdapter(scope) {
    if (scope === 'groups') {
        const groups = await import('./group-chats.js');
        return {
            getItems: () => groups.groups ?? [],
            getKey: group => String(group.id),
            getName: group => String(group.name ?? group.id ?? ''),
            getAvatar: group => groups.getGroupAvatarElement?.(group) ?? null,
        };
    }
    if (scope === 'backgrounds') {
        const gallery = await import('./sillybunny-background-gallery.js');
        return gallery.createBackgroundFolderAdapter();
    }
    if (scope === 'personas') {
        const [script, powerUser] = await Promise.all([import('../script.js'), import('./power-user.js')]);
        return {
            getItems: () => Object.keys(powerUser.power_user.personas ?? {}),
            getKey: avatarId => String(avatarId),
            getName: avatarId => String(powerUser.power_user.personas?.[avatarId] ?? avatarId),
            getAvatar: avatarId => {
                const image = document.createElement('img');
                image.src = script.getThumbnailUrlForViewport?.('persona', avatarId) ?? avatarId;
                image.alt = '';
                return image;
            },
        };
    }
    const script = await import('../script.js');
    return {
        getItems: () => script.characters ?? [],
        getKey: character => String(character.avatar),
        getName: character => String(character.name ?? character.avatar ?? ''),
        getAvatar: character => {
            const image = document.createElement('img');
            image.src = character.avatar === 'none'
                ? script.default_avatar
                : script.getThumbnailUrlForViewport?.('avatar', character.avatar) ?? character.avatar;
            image.alt = '';
            return image;
        },
    };
}

async function loadStyles() {
    const loader = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    if (!loader) return;
    await Promise.all(STYLESHEETS.map(async ({ href, id }) => {
        let link = document.getElementById(id);
        try {
            const pending = loader(href, { id });
            link = document.getElementById(id);
            await pending;
        } catch (error) {
            if (link instanceof HTMLLinkElement && document.getElementById(id) === link) link.remove();
            throw error;
        }
    }));
}

function renderColor(dot, color) {
    if (color) dot.style.setProperty('--sb-folder-color', color);
    else dot.style.removeProperty('--sb-folder-color');
}

function colorPicker(entry, folder, refresh, store) {
    if (!entry.picker) {
        const wrapper = element('div', 'sb-folder-manager__colors');
        const picker = createFolderColorPicker({
            value: folder.color,
            onChange: color => {
                store.setFolderColor(entry.scope, folder.id, color);
                refresh();
            },
        });
        const close = rowButton(t`Close`, 'xmark', () => wrapper.hidden = true);
        wrapper.append(picker, close);
        entry.row.append(wrapper);
        entry.picker = picker;
        entry.colors = wrapper;
    }
    const value = folder.color || DEFAULT_FOLDER_COLOR;
    if (entry.picker.getAttribute('color') !== value) entry.picker.setAttribute('color', value);
    entry.colors.hidden = false;
    requestAnimationFrame(() => {
        entry.picker.scrollIntoView?.({ block: 'nearest' });
        entry.picker.shadowRoot?.querySelector('.button')?.click();
    });
}

/**
 * Creates the Folder Manager surface. The adapter is intentionally small so the
 * folder UI can be exercised with an in-memory entity source as well as the app.
 * `adapter.store` is where the folders live: the eleven functions of `sillybunny-folders.js` (`getFolders`,
 * `getFolderMembers`, `createFolder`, `renameFolder`, `deleteFolder`, `moveFolder` by a delta, `setFolderColor`,
 * `setFolderExpanded`, `setFolder`, `removeFromFolder`, `subscribe`), each taking the scope first. It defaults to that
 * module, which keeps the folders of characters, groups, personas and backgrounds in the settings; the conversations
 * keep theirs on the server and pass their own.
 */
export function createFolderManager(scope, adapter) {
    if (!SCOPES.includes(scope)) throw new TypeError(`Invalid folder manager scope: ${scope}`);
    const store = adapter?.store ?? settingsFolderStore;
    const layout = window.matchMedia?.(LAYOUT_MOBILE_QUERY) ?? { matches: false };
    const cache = new Map();
    const entries = new Map();
    let disposed = false;
    let reconciling = false;
    let dragging = false;
    let finish;
    const closed = new Promise(resolve => finish = resolve);
    /** @type {ReturnType<typeof openDialog>|null} */
    let frame = null;
    /** @type {{ folderId: string, page: object, toolbar: HTMLElement, list: HTMLElement }|null} */
    let members = null;
    let addButton = null;
    let selection = null;
    let bulkBusy = false;
    let visibleIds = [];

    const status = element('div', 'sb-folder-manager__status');
    status.setAttribute('aria-live', 'polite');
    const list = element('div', 'ds-entity-list sb-folder-manager__list');
    list.setAttribute('role', 'list');
    const selectionBar = element('div', 'sb-folder-manager__selection-bar');
    const content = document.createDocumentFragment();
    content.append(list, status);
    let sortable;
    let unbindKeyboard;
    let unsubscribe;

    /** Settings keep a membership for a persona or character that was removed outside the app, so the count follows what still exists, like the members page. */
    function liveMemberCount(folderId) {
        const existing = new Set(currentItems().map(item => String(adapter.getKey(item))));
        return store.getFolderMembers(scope, folderId).filter(key => existing.has(key)).length;
    }

    function currentItems() {
        const source = adapter?.getItems?.() ?? [];
        return [...source].filter(item => item && typeof adapter?.getKey?.(item) === 'string');
    }

    function itemRow(item) {
        const key = String(adapter.getKey(item));
        const name = String(adapter.getName(item) ?? key);
        const avatar = adapter.getAvatar?.(item) ?? null;
        // A member may be in several folders (a background); Remove takes it out of this one only.
        const remove = rowButton(t`Remove`, 'minus', () => {
            store.removeFromFolder(scope, [key], members?.folderId);
            refresh();
        }, 'sb-folder-manager__remove');
        const entity = createEntityRow({
            key: entityKey(MEMBER_KINDS[scope], key),
            label: name,
            title: name,
            avatar,
            suffix: [remove],
        });
        entity.row.classList.add('sb-folder-manager__member-row');
        entity.row.classList.add('ds-entity-row--surface');
        return entity.row;
    }

    function folderMenu(trigger, folder) {
        const folders = store.getFolders(scope);
        const index = folders.findIndex(candidate => candidate.id === folder.id);
        const sections = [{ items: [
            { label: t`Rename`, icon: 'fa-solid fa-pen', onSelect: () => entries.get(folder.id)?.input?.focus() },
            { label: t`Colour`, icon: 'fa-solid fa-palette', onSelect: () => colorPicker(entries.get(folder.id), folder, refresh, store) },
        ] }, { items: [
            { label: t`Expanded by Default`, icon: 'fa-solid fa-arrows-up-down', kind: 'check', checked: folder.expanded,
                onSelect: () => { store.setFolderExpanded(scope, folder.id, !folder.expanded); refresh(); } },
        ] }, { items: reorderMenuItems({
            index,
            count: folders.length,
            filtered: Boolean(frame?.search?.query.trim()),
            extremes: folders.length >= LONG_LIST,
            // The row keeps the folder object it was created with, so a rename shows only in the store's copy.
            name: folders[index]?.name ?? folder.name,
            move: to => {
                const moved = store.moveFolder(scope, folder.id, to - index);
                refresh();
                return moved;
            },
            focus: () => entries.get(folder.id)?.row ?? null,
        }) }, { items: [{ label: t`Delete`, icon: 'fa-solid fa-trash-can', danger: true, onSelect: () => confirmDelete(folder) }] }];
        openActionMenu({ trigger, title: folder.name, sections, bounds: frame?.surface ?? null });
    }

    function folderRow(folder) {
        const dot = element('span', 'sb-folder-manager__dot');
        renderColor(dot, folder.color);
        const input = element('input', 'sb-folder-manager__name');
        input.type = 'text';
        input.value = folder.name;
        input.setAttribute('aria-label', t`Rename`);
        const error = element('small', 'sb-folder-manager__error');
        error.hidden = true;
        const name = element('div', 'sb-folder-manager__field');
        name.append(input, error);
        const count = element('span', 'sb-folder-manager__count', countLabel(liveMemberCount(folder.id), scope));
        const more = rowButton(t`Manage Folder`, 'ellipsis-vertical', trigger => folderMenu(trigger, folder), 'sb-folder-manager__row-menu');
        more.setAttribute('aria-haspopup', 'menu');
        const entity = createEntityRow({
            key: `folder:${scope}:${folder.id}`,
            label: folder.name,
            title: name,
            subtitle: count,
            avatar: dot,
            grip: true,
            suffix: [more],
            activation: 'navigate',
        });
        entity.row.classList.add('sb-folder-manager__folder-row');
        entity.row.setAttribute('aria-haspopup', 'dialog');
        entity.slots.grip?.classList.add('drag-handle');
        entity.row.dataset.folderId = folder.id;
        entity.row.addEventListener('click', event => {
            if (event.target.closest('button, input, .drag-handle')) return;
            openMembers(folder.id);
        });
        entity.row.addEventListener('keydown', event => {
            if (event.isComposing || event.target !== entity.row || !['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            openMembers(folder.id);
        });
        const state = { row: entity.row, input, error, dot, scope };
        entries.set(folder.id, state);
        entity.slots.grip?.addEventListener('click', event => event.stopPropagation());
        const commitName = (focusInvalid = false) => {
            const parsed = folderName(input.value);
            if (!parsed.ok) {
                error.textContent = parsed.error;
                error.hidden = false;
                input.setAttribute('aria-invalid', 'true');
                if (focusInvalid) input.focus({ preventScroll: true });
                return false;
            }
            error.hidden = true;
            input.removeAttribute('aria-invalid');
            if (parsed.name !== store.getFolders(scope).find(candidate => candidate.id === folder.id)?.name) store.renameFolder(scope, folder.id, parsed.name);
            input.value = parsed.name;
            return true;
        };
        input.addEventListener('input', () => {
            if (input.getAttribute('aria-invalid') === 'true' && folderName(input.value).ok) {
                error.hidden = true;
                input.removeAttribute('aria-invalid');
            }
        });
        input.addEventListener('blur', () => { if (!reconciling) { commitName(); refresh(); } });
        input.addEventListener('keydown', event => {
            if (event.isComposing) return;
            if (event.key === 'Enter') { event.preventDefault(); commitName(true); refresh(); }
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                input.value = store.getFolders(scope).find(candidate => candidate.id === folder.id)?.name ?? '';
                error.hidden = true;
                input.removeAttribute('aria-invalid');
            }
        });
        return entity.row;
    }

    function renderFolderRow(row, folder) {
        const entry = entries.get(folder.id);
        if (!entry) return;
        if (document.activeElement !== entry.input && entry.input.getAttribute('aria-invalid') !== 'true') entry.input.value = folder.name;
        entry.row.dataset.folderId = folder.id;
        entry.dot.style.setProperty('--sb-folder-color', folder.color || 'var(--sb-muted-fg)');
        const count = entry.row.querySelector('.sb-folder-manager__count');
        if (count) count.textContent = countLabel(liveMemberCount(folder.id), scope);
    }

    function renderFolders() {
        if (disposed || dragging) return;
        const folders = store.getFolders(scope);
        reconciling = true;
        try {
            reconcileRows({
                container: list,
                cache,
                entries: folders,
                key: folder => `folder:${scope}:${folder.id}`,
                signature: folder => folder.id,
                create: folderRow,
                update: (row, folder) => renderFolderRow(row, folder),
            });
        } finally {
            reconciling = false;
        }
        const liveIds = new Set(folders.map(folder => folder.id));
        for (const id of entries.keys()) if (!liveIds.has(id)) entries.delete(id);
        const query = frame?.search?.query.trim().toLowerCase() ?? '';
        for (const row of list.children) row.hidden = Boolean(query) && !row.querySelector('.sb-folder-manager__name')?.value.toLowerCase().includes(query);
        visibleIds = [...list.children].filter(row => !row.hidden).map(row => row.dataset.folderId);
        const shown = visibleIds.length;
        list.hidden = !shown;
        if (!shown) {
            status.hidden = false;
            status.replaceChildren(markCopyPlaceholder(createStatusPage({
                state: query ? 'no-results' : 'empty',
                icon: 'folder-open',
                title: query ? t`No Results Found` : t`No Folders`,
                description: query ? t`Try a different search` : scopeCopy(scope).empty,
                compact: true,
                actions: query ? [] : [{ label: t`New Folder`, primary: true, onActivate: () => openCreatePopover(addButton) }],
            }).element));
        } else status.hidden = true;
        frame?.search?.report(shown, folders.length);
        selection?.decorate({ prune: true });
        syncSelectionState();
    }

    /** Rows take no edit while they are being selected: the name field and the manage button leave the tab order. */
    function syncSelectionState() {
        const active = Boolean(selection?.isActive);
        for (const entry of entries.values()) {
            entry.input.inert = active;
            for (const suffix of entry.row.querySelectorAll('.ds-entity-row__suffix')) suffix.inert = active;
        }
        sortable?.setDisabled(active);
    }

    async function deleteSelected(keys) {
        const live = new Set(store.getFolders(scope).map(folder => folder.id));
        const ids = keys.filter(id => live.has(id));
        if (!ids.length || bulkBusy) return;
        bulkBusy = true;
        selectionBar.inert = true;
        try {
            // HUMAN: replace — bulk delete confirmation; the selected count remains explicit.
            const text = `${PLACEHOLDER_COPY} (${ids.length}) ${scopeCopy(scope).deleteBody}`;
            if (!await confirmDestructiveAction({ text, confirmLabel: t`Delete`, copyPlaceholder: true }) || disposed) return;
            // The same removal as one folder's Delete: its members stay and leave the folder.
            for (const id of ids) store.deleteFolder(scope, id);
            selection.exit();
            refresh();
        } finally {
            bulkBusy = false;
            selectionBar.inert = false;
        }
    }

    function renderMemberList(folder) {
        const itemMap = new Map(currentItems().map(item => [String(adapter.getKey(item)), item]));
        const rows = store.getFolderMembers(scope, folder.id).map(key => itemMap.get(key)).filter(Boolean).map(itemRow);
        if (!rows.length) rows.push(markCopyPlaceholder(createStatusPage({
            state: 'empty',
            icon: 'users',
            title: t`No Members`,
            description: scopeCopy(scope).noMembers,
            compact: true,
            actions: [{ label: t`Add`, primary: true, onActivate: () => addMember(folder) }],
        }).element));
        members.list.replaceChildren(...rows);
    }

    /** The members view is a page in the frame, so its header returns to the folder list. */
    function openMembers(folderId) {
        const folder = store.getFolders(scope).find(candidate => candidate.id === folderId);
        if (!folder || !frame || members) return;
        const add = createIconButton(t`Add`, 'plus', 'sb-folder-manager__add-member');
        add.addEventListener('click', () => addMember(folder));
        const memberList = element('div', 'ds-entity-list sb-folder-manager__members');
        memberList.setAttribute('role', 'list');
        const pageContent = document.createDocumentFragment();
        pageContent.append(memberList);
        const page = frame.push({ title: folder.name, content: pageContent, initialFocus: () => add });
        page.header.querySelector('.sb-dialog__header-end').append(add);
        members = { folderId: folder.id, page, add, list: memberList };
        bindListFocus(memberList, { rowSelector: '.sb-folder-manager__member-row' });
        renderMemberList(folder);
        page.closed.then(() => {
            members = null;
            refresh();
        });
    }

    function addMember(folder) {
        const assigned = new Set(store.getFolderMembers(scope, folder.id));
        const items = currentItems().map(item => {
            const key = String(adapter.getKey(item));
            return { value: key, label: String(adapter.getName(item) ?? key), subtitle: assigned.has(key) ? t`In this folder` : undefined };
        });
        openPicker({
            trigger: members?.add,
            title: t`Add to Folder`,
            items,
            selected: null,
            searchLabel: t`Search`,
            emptyText: t`No Results`,
            bounds: frame?.surface ?? null,
            onSelect: key => { store.setFolder(scope, [key], folder.id); refresh(); },
        });
    }

    async function confirmDelete(folder) {
        const body = scopeCopy(scope).deleteBody;
        const bodyNode = element('span', '', body);
        if (body === PLACEHOLDER_COPY) bodyNode.setAttribute('data-sb-copy-placeholder', 'true');
        const response = await openAlert({
            heading: t`Delete Folder?`,
            bodyNode,
            responses: [{ id: 'cancel', label: t`Cancel` }, { id: 'delete', label: t`Delete`, appearance: 'destructive' }],
            closeResponse: 'cancel',
        });
        if (response !== 'delete' || disposed) return;
        const showing = members?.folderId === folder.id ? members : null;
        store.deleteFolder(scope, folder.id);
        if (showing) showing.page.forceClose();
        else refresh();
    }

    /** Makes the folder that the popover asked for, and answers what the popover does once it has closed. */
    function createFromName(name) {
        const make = (options) => {
            if (disposed) return false;
            const folder = store.createFolder(scope, name, options);
            refresh();
            return { focus: () => entries.get(folder.id)?.input.focus({ preventScroll: true }) };
        };
        // A scope whose folders live on the server gets the folder's id from the server before anything refers to the folder.
        if (adapter?.createFolder) return Promise.resolve(adapter.createFolder(name)).then(created => make({ id: created?.id }));
        return make({});
    }

    function refresh() {
        if (disposed) return;
        renderFolders();
        if (!members) return;
        const folder = store.getFolders(scope).find(candidate => candidate.id === members.folderId);
        if (!folder) {
            members.page.forceClose();
            return;
        }
        members.page.setTitle(folder.name);
        renderMemberList(folder);
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
        unbindKeyboard?.();
        unsubscribe?.();
        finish();
    }

    function openCreatePopover(trigger) {
        openFolderNamePopover({ trigger, bounds: frame?.surface ?? null, title: t`New Folder`, submitLabel: t`Create`, onSubmit: createFromName });
    }
    unbindKeyboard = bindListKeyboard(list, {
        rowSelector: '.sb-folder-manager__folder-row',
        keySourceSelector: '.drag-handle',
        onRename: row => { if (!selection?.isActive) row.querySelector('input')?.focus(); return true; },
        onMove: (row, direction) => {
            if (selection?.isActive || frame?.search?.query.trim()) return false;
            const id = row.dataset.folderId;
            const folders = store.getFolders(scope);
            const index = folders.findIndex(folder => folder.id === id);
            // An infinite direction (Alt+Home, Alt+End) goes to the first or last place.
            const to = Math.max(0, Math.min(folders.length - 1, index + direction));
            if (index < 0 || to === index || !store.moveFolder(scope, id, to - index)) return;
            refresh();
            announceReorder({ name: folders[index].name, position: to + 1, count: folders.length });
            entries.get(id)?.row.focus({ preventScroll: true });
        },
    });
    sortable = bindSortable(list, {
        handle: '.drag-handle',
        items: '.sb-folder-manager__folder-row',
        touch: () => layout.matches,
        start: () => { dragging = true; },
        update: () => {
            const desired = [...list.children].map(row => row.dataset.folderId);
            for (let index = 0; index < desired.length; index++) {
                const current = store.getFolders(scope).findIndex(folder => folder.id === desired[index]);
                if (current >= 0 && current !== index) store.moveFolder(scope, desired[index], index - current);
            }
        },
        stop: () => { dragging = false; refresh(); },
    });
    unsubscribe = store.subscribe(({ scope: changedScope }) => { if (!changedScope || changedScope === scope) refresh(); });
    refresh();

    return {
        /** The dialog surface, available after show(). */
        get root() { return frame?.surface ?? null; },
        get host() { return frame?.root ?? null; },
        closed,
        refresh,
        close,
        focus: () => (members ? members.add : frame?.search?.isOpen ? frame.searchInput : frame?.searchToggle)?.focus({ preventScroll: true }),
        show() {
            if (frame) return;
            frame = openDialog({
                tier: 'window',
                title: t`Folders`,
                className: 'sb-folder-manager',
                content,
                search: { placeholder: t`Search…`, label: t`Search`, collapsed: true, escapeClearsFirst: true, typeToSearchSelector: '.sb-folder-manager__folder-row', debounce: 300, onChange: () => refresh() },
                menu: trigger => [{ items: [{
                    label: t`Select`, icon: 'fa-solid fa-check-double', disabled: bulkBusy || !store.getFolders(scope).length,
                    onSelect: () => selection.enter(null, trigger),
                }] }],
                menuLabel: t`Folders`,
            });
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
                root: frame.surface, list, rowSelector: '.sb-folder-manager__folder-row', getKey: row => row.dataset.folderId,
                keySourceSelector: '.drag-handle', range: true, iconOnlyAtNarrow: true, headerSlots: slots, actionBar: selectionBar,
                getAllKeys: () => visibleIds,
                canEnter: () => !bulkBusy && store.getFolders(scope).length > 0,
                actions: [
                    { id: 'delete', label: t`Delete`, icon: 'fa-solid fa-trash', danger: true, onActivate: keys => deleteSelected(keys) },
                ],
                onChange: () => syncSelectionState(), onExit: () => syncSelectionState(),
            });
            const add = createIconButton(t`New Folder`, 'plus', 'sb-folder-manager__add');
            add.addEventListener('click', () => openCreatePopover(add));
            addButton = add;
            add.addEventListener('keydown', event => {
                if (event.key === 'Enter') event.stopPropagation();
            });
            frame.header.querySelector('.sb-dialog__header-end').prepend(add);
            frame.closed.then(dispose);
        },
    };
}

export async function openFolderManager(scope, adapter = null) {
    if (activeManager) {
        activeManager.focus();
        return activeManager.closed;
    }
    if (opening) return opening;
    opening = (async () => {
        await loadStyles();
        const resolved = adapter ?? await loadDefaultAdapter(scope);
        activeManager = createFolderManager(scope, resolved);
        activeManager.show();
        await activeManager.closed;
        activeManager = null;
    })();
    try {
        return await opening;
    } finally {
        opening = null;
    }
}

export function refreshFolderManager() {
    activeManager?.refresh();
}

globalThis.SillyBunnyFolderManager ??= { open: openFolderManager, refresh: refreshFolderManager };
