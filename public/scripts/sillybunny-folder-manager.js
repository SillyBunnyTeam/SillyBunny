import { t } from './i18n.js';
import { folderCountLabel } from './sillybunny-editor/folder-row.js';
import { Popup, POPUP_RESULT } from './popup.js';
import { createEntityRow, entityKey } from './sillybunny-editor/entity-row.js';
import { createRow } from './sillybunny-editor/rows.js';
import { reconcileRows, bindListKeyboard, bindSortable } from './sillybunny-editor/list-rows.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { closePicker, openPicker } from './sillybunny-editor/picker.js';
import { createListHeader } from './sillybunny-editor/list-header.js';
import { openActionMenu, closeActionMenu, MOBILE_QUERY } from './sillybunny-action-menu.js';
import { createSheetController, blockUpstreamDrawerClose } from './sillybunny-sheet.js';
import { animateIn, stopMotion, SPRING_SHEET } from './sillybunny-motion.js';
import {
    createFolder,
    deleteFolder,
    getFolderMembers,
    getFolders,
    moveFolder,
    renameFolder,
    setFolder,
    setFolderColor,
    setFolderExpanded,
    subscribe,
} from './sillybunny-folders.js';

const STYLESHEETS = [
    { href: 'css/sillybunny-editor-shell.css?v=20261018b', id: 'deferred-editor-shell-css' },
    { href: 'css/sillybunny-entity-list.css?v=20261018a', id: 'deferred-entity-list-css' },
    { href: 'css/sillybunny-folder-manager.css?v=20261020a', id: 'deferred-folder-manager-css' },
];

let activeManager = null;
let opening = null;

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

function button(label, glyph, action, className = '') {
    const node = element('button', `menu_button sb-folder-manager__button ${className}`);
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

function folderName(value) {
    const name = String(value ?? '').trim();
    return name ? { ok: true, name } : { ok: false, error: t`Enter a folder name.` };
}

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

function colorPicker(entry, folder, refresh) {
    if (!entry.picker) {
        const wrapper = element('div', 'sb-folder-manager__colors');
        const picker = element('toolcool-color-picker');
        picker.setAttribute('aria-label', t`Folder colour`);
        picker.setAttribute('color', folder.color || 'rgba(128, 128, 128, 1)');
        picker.addEventListener('change', event => {
            const color = event.detail?.rgba ?? event.detail?.color ?? picker.color ?? picker.getAttribute('color') ?? '';
            setFolderColor(entry.scope, folder.id, String(color));
            refresh();
        });
        const close = button(t`Close`, 'xmark', () => wrapper.hidden = true);
        wrapper.append(picker, close);
        entry.row.append(wrapper);
        entry.picker = picker;
        entry.colors = wrapper;
    }
    const value = folder.color || 'rgba(128, 128, 128, 1)';
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
 */
export function createFolderManager(scope, adapter) {
    if (!['characters', 'groups'].includes(scope)) throw new TypeError(`Invalid folder manager scope: ${scope}`);
    const mobile = window.matchMedia?.(MOBILE_QUERY) ?? { matches: false, addEventListener() {}, removeEventListener() {} };
    const returnFocus = document.activeElement;
    const cache = new Map();
    const entries = new Map();
    let currentPage = 'folders';
    let currentFolderId = null;
    let disposed = false;
    let reconciling = false;
    let dragging = false;
    let finish;
    const closed = new Promise(resolve => finish = resolve);
    const host = element('dialog', 'sb-folder-manager-host');
    host.setAttribute('aria-labelledby', 'sb-folder-manager-title');
    const backdrop = element('div', 'sb-folder-manager__backdrop');
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.hidden = true;
    const root = element('section', 'sb-folder-manager');
    root.hidden = true;
    const headerControl = createListHeader({
        title: t`Folders`,
        className: 'sb-folder-manager__header',
        actions: [{ id: 'close', label: t`Close`, icon: 'xmark', onActivate: () => close() }],
    });
    const header = headerControl.element;
    const title = header.querySelector('.sb-list-header__title');
    title.id = 'sb-folder-manager-title';
    title.classList.add('sb-folder-manager__title');
    headerControl.button('close').classList.add('sb-folder-manager__button', 'sb-folder-manager__close');
    const handle = element('div', 'sb-folder-manager__handle');
    handle.setAttribute('aria-hidden', 'true');
    header.prepend(handle);
    const body = element('div', 'sb-folder-manager__body');
    const status = element('div', 'sb-folder-manager__status');
    status.setAttribute('aria-live', 'polite');
    root.append(header, body);
    host.append(backdrop, root);

    const list = element('div', 'ds-pref-group ds-entity-list sb-folder-manager__list');
    list.setAttribute('role', 'list');
    const createInput = element('input', 'text_pole sb-folder-manager__new');
    createInput.type = 'text';
    createInput.placeholder = t`New Folder`;
    createInput.setAttribute('aria-label', t`New Folder`);
    const createError = element('small', 'sb-folder-manager__error');
    createError.hidden = true;
    const createButton = button(t`New Folder`, 'plus', createPending, 'sb-folder-manager__add');
    const createEntry = createRow({ label: '', field: 'new-folder', suffix: [createInput, createButton] });
    createEntry.row.querySelector('.ds-row-text')?.remove();
    const createGroup = element('div', 'ds-pref-group sb-folder-manager__create');
    createGroup.append(createEntry.row, createError);
    body.append(createGroup, list, status);

    const sheet = createSheetController({
        sheet: root,
        backdrop,
        getInitialFocus: () => currentPage === 'members' ? body.querySelector('.sb-folder-manager__back') : createInput,
        getReturnFocus: () => returnFocus,
        canAnimateClose: () => mobile.matches,
        onClose: () => dispose(),
    });
    let sortable;
    let unbindKeyboard;
    let unsubscribe;

    function setCreateError(message = '') {
        createError.textContent = message;
        createError.hidden = !message;
        createInput.setAttribute('aria-invalid', String(Boolean(message)));
    }

    function refreshOptions() {
        const folders = getFolders(scope);
        const folderIds = new Set(folders.map(folder => folder.id));
        for (const [id] of entries) if (!folderIds.has(id)) entries.delete(id);
    }

    function currentItems() {
        const source = adapter?.getItems?.() ?? [];
        return [...source].filter(item => item && typeof adapter?.getKey?.(item) === 'string');
    }

    function itemRow(item, folderId) {
        const key = String(adapter.getKey(item));
        const name = String(adapter.getName(item) ?? key);
        const avatar = adapter.getAvatar?.(item) ?? null;
        const remove = button(t`Remove`, 'minus', () => {
            setFolder(scope, [key], null);
            refresh();
        }, 'sb-folder-manager__remove');
        const entity = createEntityRow({
            key: entityKey(scope === 'groups' ? 'group' : 'character', key),
            label: name,
            title: name,
            avatar,
            suffix: [remove],
        });
        entity.row.classList.add('sb-folder-manager__member-row');
        return entity.row;
    }

    function folderMenu(trigger, folder) {
        const folders = getFolders(scope);
        const index = folders.findIndex(candidate => candidate.id === folder.id);
        const sections = [{ items: [
            { label: t`Rename`, icon: 'fa-solid fa-pen', onSelect: () => entries.get(folder.id)?.input?.focus() },
            { label: t`Colour`, icon: 'fa-solid fa-palette', onSelect: () => colorPicker(entries.get(folder.id), folder, refresh) },
        ] }, { items: [
            { label: t`Expanded by Default`, icon: 'fa-solid fa-arrows-up-down', kind: 'check', checked: folder.expanded,
                onSelect: () => { setFolderExpanded(scope, folder.id, !folder.expanded); refresh(); } },
        ] }, { items: [
            { label: t`Move Up`, icon: 'fa-solid fa-arrow-up', disabled: index <= 0, onSelect: () => { moveFolder(scope, folder.id, -1); refresh(); } },
            { label: t`Move Down`, icon: 'fa-solid fa-arrow-down', disabled: index < 0 || index >= folders.length - 1, onSelect: () => { moveFolder(scope, folder.id, 1); refresh(); } },
        ] }, { items: [{ label: t`Delete`, icon: 'fa-solid fa-trash-can', danger: true, onSelect: () => confirmDelete(folder) }] }];
        openActionMenu({ trigger, title: folder.name, sections, bounds: root, forcePopover: mobile.matches });
        for (const layer of document.querySelectorAll('.sb-action-popover')) host.append(layer);
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
        const name = element('div', 'sb-folder-manager__name-field');
        name.append(input, error);
        const count = element('span', 'sb-folder-manager__count', countLabel(getFolderMembers(scope, folder.id).length, scope));
        const more = button(t`Manage folder`, 'ellipsis-vertical', trigger => folderMenu(trigger, folder), 'sb-folder-manager__row-menu');
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
        entity.slots.grip?.classList.add('drag-handle');
        entity.row.dataset.folderId = folder.id;
        const state = { row: entity.row, input, error, dot, scope };
        entries.set(folder.id, state);
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
            if (parsed.name !== getFolders(scope).find(candidate => candidate.id === folder.id)?.name) renameFolder(scope, folder.id, parsed.name);
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
            if (event.key === 'Escape') { event.preventDefault(); input.value = getFolders(scope).find(candidate => candidate.id === folder.id)?.name ?? ''; error.hidden = true; input.removeAttribute('aria-invalid'); }
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
        if (count) count.textContent = countLabel(getFolderMembers(scope, folder.id).length, scope);
    }

    function renderFolders() {
        if (disposed || currentPage !== 'folders' || dragging) return;
        const folders = getFolders(scope);
        const query = '';
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
        list.hidden = !folders.length;
        if (!folders.length) {
            status.hidden = false;
            status.replaceChildren(createStatusPage({
                icon: 'folder-open',
                title: t`No Folders`,
                description: scope === 'groups' ? t`Create a folder to sort groups in the list.` : t`Create a folder to sort characters in the list.`,
                compact: true,
            }).element);
        } else status.hidden = true;
        sortable?.setDisabled(Boolean(query));
    }

    function renderMembers(folderId) {
        const folder = getFolders(scope).find(candidate => candidate.id === folderId);
        if (!folder) return goBack();
        currentFolderId = folder.id;
        currentPage = 'members';
        title.textContent = folder.name;
        const back = button(t`Back`, 'arrow-left', goBack, 'sb-folder-manager__back');
        const add = button(t`Add`, 'plus', () => addMember(folder), 'sb-folder-manager__add-member');
        const toolbar = element('div', 'sb-folder-manager__members-toolbar');
        toolbar.append(back, add);
        const memberList = element('div', 'ds-pref-group ds-entity-list sb-folder-manager__members');
        memberList.setAttribute('role', 'list');
        const itemMap = new Map(currentItems().map(item => [String(adapter.getKey(item)), item]));
        const members = getFolderMembers(scope, folder.id).map(key => itemMap.get(key)).filter(Boolean);
        memberList.append(...members.map(item => itemRow(item, folder.id)));
        if (!members.length) memberList.append(createStatusPage({
            icon: 'users',
            title: t`No Members`,
            description: scope === 'groups' ? t`Add groups to this folder to list them under it.` : t`Add characters to this folder to list them under it.`,
            compact: true,
        }).element);
        body.replaceChildren(toolbar, memberList);
    }

    function addMember(folder) {
        const assigned = new Set(getFolderMembers(scope, folder.id));
        const items = currentItems().map(item => {
            const key = String(adapter.getKey(item));
            return { value: key, label: String(adapter.getName(item) ?? key), subtitle: assigned.has(key) ? t`In this folder` : undefined };
        });
        const trigger = body.querySelector('.sb-folder-manager__add-member');
        openPicker({
            trigger,
            title: t`Add to Folder`,
            items,
            selected: null,
            searchLabel: t`Search`,
            emptyText: t`No results`,
            bounds: root,
            renderAsPopover: mobile.matches,
            onSelect: key => { setFolder(scope, [key], folder.id); renderMembers(folder.id); },
        });
        for (const layer of document.querySelectorAll('.sb-picker')) host.append(layer);
        for (const layer of document.querySelectorAll('.sb-picker, .sb-picker-sheet, .sb-action-sheet-backdrop')) host.append(layer);
    }

    async function confirmDelete(folder) {
        const bodyText = scope === 'groups'
            ? t`The groups in this folder stay in your library. They are no longer in a folder.`
            : t`The characters in this folder stay in your library. They are no longer in a folder.`;
        const result = await Popup.show.confirm(t`Delete Folder?`, bodyText, {
            okButton: t`Delete`,
            cancelButton: t`Cancel`,
            defaultResult: POPUP_RESULT.NEGATIVE,
            onOpen: popup => {
                popup.dlg.classList.add('sb-folder-delete-confirm');
                popup.buttonControls.insertBefore(popup.cancelButton, popup.okButton);
                popup.cancelButton.focus({ preventScroll: true });
                popup.okButton.classList.add('is-destructive');
            },
        });
        if (result !== POPUP_RESULT.AFFIRMATIVE || disposed) return;
        deleteFolder(scope, folder.id);
        if (currentFolderId === folder.id) goBack();
        else refresh();
    }

    function createPending() {
        const parsed = folderName(createInput.value);
        if (!parsed.ok) {
            setCreateError(parsed.error);
            createInput.focus({ preventScroll: true });
            return;
        }
        setCreateError();
        const folder = createFolder(scope, parsed.name);
        createInput.value = '';
        refresh();
        entries.get(folder.id)?.input.focus({ preventScroll: true });
    }

    function goBack() {
        currentPage = 'folders';
        currentFolderId = null;
        title.textContent = t`Folders`;
        body.replaceChildren(createGroup, list);
        refresh();
    }

    function refresh() {
        if (disposed) return;
        if (currentPage === 'members') renderMembers(currentFolderId);
        else renderFolders();
    }

    function close() {
        if (disposed) return false;
        return mobile.matches ? sheet.close() : dispose();
    }

    function dispose() {
        if (disposed) return false;
        disposed = true;
        closeActionMenu({ animate: false });
        closePicker({ animate: false, restoreFocus: false });
        sortable?.destroy();
        unbindKeyboard?.();
        unsubscribe?.();
        headerControl.destroy();
        host.close();
        host.remove();
        if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
        finish();
        return true;
    }

    createInput.addEventListener('input', () => { if (folderName(createInput.value).ok) setCreateError(); });
    createInput.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); createPending(); }
        if (event.key === 'Escape') { event.preventDefault(); createInput.value = ''; setCreateError(); }
    });
    list.addEventListener('click', event => {
        if (event.target.closest('button, input')) return;
        const row = event.target.closest('.sb-folder-manager__folder-row');
        if (row) renderMembers(row.dataset.folderId);
    });
    unbindKeyboard = bindListKeyboard(list, {
        rowSelector: '.sb-folder-manager__folder-row',
        onOpen: row => { renderMembers(row.dataset.folderId); return true; },
        onRename: row => { row.querySelector('input')?.focus(); return true; },
    });
    sortable = bindSortable(list, {
        handle: '.drag-handle',
        items: '.sb-folder-manager__folder-row',
        touch: () => mobile.matches,
        start: () => { dragging = true; },
        update: () => {
            const desired = [...list.children].map(row => row.dataset.folderId);
            for (let index = 0; index < desired.length; index++) {
                const current = getFolders(scope).findIndex(folder => folder.id === desired[index]);
                if (current >= 0 && current !== index) moveFolder(scope, desired[index], index - current);
            }
        },
        stop: () => { dragging = false; refresh(); },
    });
    unsubscribe = subscribe(({ scope: changedScope }) => { if (!changedScope || changedScope === scope) refresh(); });
    backdrop.addEventListener('click', () => { if (!mobile.matches) close(); });
    host.addEventListener('cancel', event => { event.preventDefault(); close(); });
    host.addEventListener('close', () => { if (!disposed) dispose(); });
    blockUpstreamDrawerClose(host);
    mobile.addEventListener('change', () => {
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
    });
    refreshOptions();
    refresh();

    return {
        host,
        root,
        body,
        closed,
        refresh,
        close,
        focus: () => (currentPage === 'folders' ? createInput : body.querySelector('.sb-folder-manager__add-member'))?.focus({ preventScroll: true }),
        show() {
            document.body.append(host);
            host.showModal();
            host.dataset.mobile = String(mobile.matches);
            if (mobile.matches) sheet.open();
            else {
                root.hidden = false;
                backdrop.hidden = false;
                animateIn(root, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], SPRING_SHEET);
                createInput.focus({ preventScroll: true });
            }
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
