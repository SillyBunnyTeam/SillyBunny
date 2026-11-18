/*
 * The Backgrounds gallery's folders: the Global tab as folder sections over thumbnail grids, the search bar with Sort,
 * the tab row's trailing buttons, a menu for each thumbnail, and selection mode with Move to Folder and Delete.
 *
 * Folders and the file-to-folder map stay in upstream's image-metadata index and are read and written only through its
 * routes. The folder store's Backgrounds scope (sillybunny-folders.js) holds the order, colour and expanded state.
 * This module loads with the Appearance page, so the startup resource count does not grow.
 */
import { t } from './i18n.js';
import { createSearchEntry } from './sillybunny-editor/search-entry.js';
import { animateFolderBody, createFolderRow, folderCountLabel } from './sillybunny-editor/folder-row.js';
import { createSelectionMode } from './sillybunny-editor/selection-mode.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { openActionMenu } from './sillybunny-action-menu.js';
import { confirmDestructiveAction } from './sillybunny-delete-confirm.js';
import { attachBackgroundGallery } from './backgrounds.js';
import { buildBackgroundSections } from './sillybunny-background-sections.js';
import {
    attachBackgroundBridge,
    getFolderMembers,
    getFolders,
    hydrateBackgroundIndex,
    removeEntityKey,
    setFolder,
    setFolderExpanded,
    subscribe,
} from './sillybunny-folders.js';

const SCOPE = 'backgrounds';
const PLACEHOLDER_COPY = 'TODO(copy)';
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;
// A touch long press ends with a `contextmenu` event on some browsers, a moment after the finger lifts.
const TOUCH_GRACE_MS = 800;

const STYLESHEETS = [
    { href: 'css/sillybunny-editor-shell.css?v=20261118zp', id: 'deferred-editor-shell-css' },
    { href: 'css/sillybunny-character-editor.css?v=20261118t', id: 'deferred-editor-chrome-css' },
    { href: 'css/sillybunny-entity-list.css?v=20261117s', id: 'deferred-entity-list-css' },
    { href: 'css/sillybunny-background-gallery.css?v=20261118s', id: 'deferred-background-gallery-css' },
];

/** @type {ReturnType<typeof attachBackgroundGallery>|null} */
let hooks = null;
let initialized = null;
let container = null;
let drawer = null;
let selection = null;
let query = '';
let stylesReady = Promise.resolve();
let rendering = false;
let pendingRender = false;
let touchPress = false;
let touchGraceTimer = 0;
let swallowContextMenuUntil = 0;
let suppressClickUntil = 0;
let bulkBusy = false;
let selectionShown = false;
let requestQueue = Promise.resolve();

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function icon(glyph) {
    const node = el('i', `fa-solid fa-${glyph}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

function item(label, glyph, onSelect, extra = {}) {
    return { label, icon: `fa-solid fa-${glyph}`, onSelect, ...extra };
}

function friendlyName(file) {
    const dot = file.lastIndexOf('.');
    return dot > 0 ? file.slice(0, dot) : file;
}

function loadStyles() {
    const loader = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    if (!loader) return Promise.resolve();
    return Promise.all(STYLESHEETS.map(({ href, id }) => loader(href, { id }))).then(() => {});
}

function isGlobalTab() {
    return hooks.getActiveTab() === hooks.getTabs().GLOBAL;
}

/** Posts to one of upstream's image-metadata routes. */
function post(path, body) {
    return fetch(path, { method: 'POST', headers: hooks.getRequestHeaders(), body: JSON.stringify(body) }).then(response => {
        if (!response.ok) throw new Error(`${path} ${response.status}`);
        return response.json().catch(() => ({}));
    });
}

/** Requests run one after another, so a move and a rename sent in quick succession reach the index in the order the user made them. */
function enqueue(task) {
    const run = requestQueue.then(task);
    requestQueue = run.catch(() => {});
    return run;
}

function reportFailure(error) {
    console.error('[Backgrounds] A folder change failed:', error);
    globalThis.toastr?.error(String(error?.message ?? error));
    // The server's index is the truth: show it again.
    return hooks.reload();
}

const bridge = {
    move: (previous, target) => enqueue(async () => {
        const byFolder = new Map();
        for (const [file, ids] of Object.entries(previous)) {
            for (const id of ids) {
                if (id === target) continue;
                byFolder.set(id, [...(byFolder.get(id) ?? []), `backgrounds/${file}`]);
            }
        }
        for (const [id, paths] of byFolder) await post('/api/image-metadata/folders/unassign', { id, paths });
        if (target) await post('/api/image-metadata/folders/assign', { id: target, paths: Object.keys(previous).map(file => `backgrounds/${file}`) });
    }).catch(reportFailure),
    unassign: (previous, id) => enqueue(
        () => post('/api/image-metadata/folders/unassign', { id, paths: Object.keys(previous).map(file => `backgrounds/${file}`) }),
    ).catch(reportFailure),
    rename: (id, name) => enqueue(() => post('/api/image-metadata/folders/update', { id, name })).catch(reportFailure),
    remove: id => enqueue(() => post('/api/image-metadata/folders/delete', { id })).catch(reportFailure),
};

// ---------------------------------------------------------------------------------------------------------------------
// Menus

function moveTo(trigger, keys, after = () => {}) {
    const folders = getFolders(SCOPE);
    const inFolder = folderId => keys.every(key => {
        const ids = folders.filter(folder => getFolderMembers(SCOPE, folder.id).includes(key)).map(folder => folder.id);
        return folderId === null ? ids.length === 0 : ids.length === 1 && ids[0] === folderId;
    });
    const place = folderId => () => {
        setFolder(SCOPE, keys, folderId);
        after();
    };
    openActionMenu({
        trigger,
        title: t`Move to Folder`,
        sections: [{ items: [
            item(t`No Folder`, 'folder', place(null), { kind: 'radio', checked: inFolder(null) }),
            ...folders.map(folder => item(folder.name, 'folder', place(folder.id), { kind: 'radio', checked: inFolder(folder.id) })),
        ] }],
    });
}

function openBackgroundMenu(trigger, file, { keyboard = false } = {}) {
    const locked = hooks.isLocked(file);
    openActionMenu({
        trigger,
        title: friendlyName(file),
        keyboard,
        sections: [
            { items: [
                item(t`Set as Background`, 'image', () => hooks.selectBackground(file)),
                locked ? item(t`Unlock`, 'lock-open', () => hooks.unlockBackground()) : item(t`Lock`, 'lock', () => hooks.lockBackground(file)),
            ] },
            { items: [
                item(t`Rename`, 'pen', () => hooks.renameBackground(file)),
                item(t`Move to Folder`, 'folder', () => setTimeout(() => moveTo(trigger, [file]), 0)),
            ] },
            { items: [item(t`Delete`, 'trash-can', () => hooks.deleteBackgroundWithConfirmation(file), { danger: true })] },
        ],
    });
}

function openGalleryMenu(trigger) {
    openActionMenu({
        trigger,
        title: t`Background`,
        sections: [
            { items: [item(t`Select`, 'check-double', () => selection.enter(null, trigger), { disabled: bulkBusy || !hooks.getImages().length })] },
            { items: [
                item(t`Manage Folders`, 'folder', openManager),
                item(t`Auto-Select`, 'wand-magic', () => document.getElementById('auto_background')?.click()),
            ] },
        ],
    });
}

function openSortMenu(trigger) {
    const select = document.getElementById('bg-sort');
    const options = [...select.options].map(option => ({ value: option.value, label: option.textContent.trim() }));
    openActionMenu({
        trigger,
        title: t`Sort`,
        sections: [{ title: t`Sort By`, items: options.map(option => item(option.label, 'arrow-down-wide-short', () => {
            $(select).val(option.value).trigger('change');
            syncSortState();
        }, { kind: 'radio', checked: select.value === option.value })) }],
    });
}

function syncSortState() {
    const select = document.getElementById('bg-sort');
    document.querySelector('#Backgrounds .sb-bg-sort-button')?.setAttribute('aria-pressed', String(select.value !== 'az'));
}

async function openManager() {
    const { openFolderManager } = await import('./sillybunny-folder-manager.js');
    await openFolderManager(SCOPE, createBackgroundFolderAdapter());
}

/** The Folder Manager's view of the gallery: the files are the members, and a folder gets its id from upstream's create route first. */
export function createBackgroundFolderAdapter() {
    return {
        getItems: () => hooks.getImages().map(image => image.filename),
        getKey: file => String(file),
        getName: file => friendlyName(String(file)),
        getAvatar: file => {
            const image = document.createElement('img');
            image.src = hooks.getThumbnailUrl(file);
            image.alt = '';
            return image;
        },
        createFolder: name => enqueue(() => post('/api/image-metadata/folders/create', { name })),
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// Sections

function makeCell(file) {
    const image = hooks.getImages().find(candidate => candidate.filename === file) ?? { filename: file };
    const cell = hooks.createThumbnail({
        filename: file,
        isAnimated: image.isAnimated ?? false,
        mediaType: image.mediaType ?? (hooks.isVideo(file) ? 'video' : 'image'),
    });
    const more = el('button', 'sb-bg-cell-menu');
    more.type = 'button';
    const name = friendlyName(file);
    // The thumbnail carries the bare name, so the button says what it opens; the menu itself is titled with the name.
    more.title = t`Actions for ${name}`;
    more.setAttribute('aria-label', more.title);
    more.setAttribute('aria-haspopup', 'menu');
    more.append(icon('ellipsis-vertical'));
    more.addEventListener('click', event => {
        event.stopPropagation();
        openBackgroundMenu(more, file);
    });
    cell.append(more);
    return cell;
}

function buildGrid(files) {
    const grid = el('div', 'bg_list sb-bg-grid');
    for (const file of files) grid.append(makeCell(file));
    return grid;
}

function createEmptyNote() {
    return el('p', 'sb-bg-section__empty', t`No backgrounds`);
}

function setSectionExpanded(section, expanded, { persist, files, emptyFolder }) {
    const row = section.querySelector('.sb-folder-row');
    const body = section.querySelector('.sb-bg-section__body');
    row.setAttribute('aria-expanded', String(expanded));
    if (expanded && !body.firstElementChild) {
        if (files.length) {
            body.append(buildGrid(files));
            hooks.activateLazyLoader();
            hooks.refreshHighlights();
        } else if (emptyFolder) {
            body.append(createEmptyNote());
        }
    }
    if (persist) setFolderExpanded(SCOPE, section.dataset.folderId, expanded);
    // A closed folder holds no thumbnails: they are dropped when the close ends and built again on the next open.
    const close = () => {
        if (row.getAttribute('aria-expanded') === 'true') return;
        body.hidden = true;
        body.replaceChildren();
    };
    if (expanded) body.hidden = false;
    if (!body.firstElementChild) {
        if (!expanded) close();
        return;
    }
    animateFolderBody(body, expanded, { onEnd: expanded ? null : close });
}

function buildSection({ folder, files, total, expanded }, searching) {
    const section = el('section', 'sb-bg-section');
    section.dataset.folderId = folder.id;
    const { row } = createFolderRow({
        key: `folder:${SCOPE}:${folder.id}`,
        folder: { ...folder, scope: SCOPE },
        count: total,
        countLabel: folderCountLabel(total, SCOPE),
        expanded,
    });
    row.tabIndex = 0;
    const head = el('div', 'sb-bg-section__head ds-entity-list');
    const rows = el('div', 'ds-entity-list__rows');
    rows.append(row);
    head.append(rows);
    const body = el('div', 'sb-bg-section__body');
    // A closed folder builds no thumbnails: they appear on the first open.
    if (expanded && files.length) body.append(buildGrid(files));
    const emptyFolder = !total && !searching;
    if (expanded && emptyFolder) body.append(createEmptyNote());
    body.hidden = !expanded;
    section.append(head, body);
    const toggle = () => {
        if (selection?.isActive) return;
        const next = row.getAttribute('aria-expanded') !== 'true';
        // A search opens folders for its own sake and leaves the stored state alone, so a click during one changes only what is on screen.
        setSectionExpanded(section, next, { persist: !searching, files, emptyFolder });
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', event => {
        if (event.target !== row || event.isComposing || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        toggle();
    });
    return section;
}

function render() {
    if (!container || !hooks) return Promise.resolve();
    if (rendering) {
        pendingRender = true;
        return Promise.resolve();
    }
    rendering = true;
    return stylesReady.then(() => {
        try {
            do {
                pendingRender = false;
                draw();
            } while (pendingRender);
        } finally {
            rendering = false;
        }
    });
}

/** A folder row does nothing while backgrounds are being selected, so it says so instead of only fading. */
function syncFolderRows() {
    const selecting = Boolean(selection?.isActive);
    for (const row of container.querySelectorAll('.sb-folder-row')) {
        if (selecting) row.setAttribute('aria-disabled', 'true');
        else row.removeAttribute('aria-disabled');
        row.tabIndex = selecting ? -1 : 0;
    }
}

function draw() {
    const folders = getFolders(SCOPE);
    const model = buildBackgroundSections({
        images: hooks.getImages(),
        folders,
        getMembers: id => getFolderMembers(SCOPE, id),
        query,
        sortFiles: hooks.sortFiles,
    });
    const searching = Boolean(query.trim());
    container.replaceChildren();
    container.classList.toggle('sb-bg-sections', folders.length > 0);
    // The shared accessibility pass makes every `.bg_list` a list of items. With sections the children are sections, not items, so the
    // container leaves that class (the pass watches it) and only groups them.
    container.classList.toggle('bg_list', folders.length === 0);
    container.setAttribute('role', folders.length ? 'group' : 'list');
    if (folders.length) container.setAttribute('aria-label', t`Background`);
    else container.removeAttribute('aria-label');
    if (!folders.length) {
        // Without folders the gallery is the flat grid it always was.
        for (const file of model.unfiled) container.append(makeCell(file));
    } else {
        for (const section of model.sections) container.append(buildSection(section, searching));
        if (model.unfiled.length) {
            const group = el('div', 'sb-bg-unfiled');
            if (model.showUnfiledHeading) {
                const heading = el('h3', 'sb-bg-unfiled__heading', t`No Folder`);
                group.append(heading);
            }
            group.append(buildGrid(model.unfiled));
            container.append(group);
        }
    }
    if (searching && !model.hasMatches) {
        container.append(createStatusPage({ state: 'no-results', icon: 'magnifying-glass', title: t`No Results Found`, description: t`Try a different search`, compact: true }).element);
    }
    hooks.activateLazyLoader();
    hooks.refreshHighlights();
    selection?.decorate({ prune: true });
    syncFolderRows();
}

// ---------------------------------------------------------------------------------------------------------------------
// Header

function iconButton(label, glyph, onClick, className = '') {
    const node = el('button', `menu_button menu_button_icon sb-bg-header-button ${className}`.trim());
    node.type = 'button';
    node.title = label;
    node.setAttribute('aria-label', label);
    node.append(icon(glyph));
    node.addEventListener('click', event => {
        event.stopPropagation();
        onClick(node);
    });
    return node;
}

function buildHeader() {
    drawer = document.getElementById('Backgrounds');
    const header = document.getElementById('bg-header-fixed');
    const row2 = header.querySelector('.bg-header-row-2');

    // The Auto-select button stays in the document, hidden, because its id and handler are upstream's; the menu presses it.
    const auto = document.getElementById('auto_background');
    if (auto) {
        auto.hidden = true;
        drawer.append(auto);
    }

    const entry = createSearchEntry({
        input: document.getElementById('bg-filter'), variant: 'bar', className: 'sb-bg-search-entry',
        clearLabel: t`Clear Entry`, placeholder: t`Search…`, clearOnEscape: true,
    });
    const sortButton = iconButton(t`Sort`, 'arrow-down-wide-short', openSortMenu, 'sb-bg-sort-button');
    sortButton.setAttribute('aria-haspopup', 'menu');
    sortButton.setAttribute('aria-pressed', 'false');
    const searchField = el('div', 'sb-bg-search-field sb-list-search-bar');
    searchField.append(entry.element, sortButton);
    const sortSelect = document.getElementById('bg-sort');
    sortSelect.hidden = true;
    row2.classList.add('sb-bg-bar');
    row2.replaceChildren(searchField, sortSelect);

    // The tab row's trailing buttons: Add Background, the two zoom buttons and the menu. The scroll button leads them.
    const controls = document.querySelector('#bg_tabs .heading-controls');
    const add = document.getElementById('add_background_button_top');
    if (add) {
        const label = add.getAttribute('title') ?? '';
        add.querySelector('span')?.remove();
        add.setAttribute('aria-label', t`Add Background`);
        add.title = label;
        // The label no longer has text, so the file input it opens takes its name from here.
        document.getElementById('add_bg_button')?.setAttribute('aria-label', t`Add Background`);
        controls.prepend(add);
    }
    const scrollTop = document.getElementById('bg-scroll-top');
    if (scrollTop) controls.prepend(scrollTop);
    const menu = iconButton(t`Background`, 'ellipsis-vertical', openGalleryMenu, 'sb-bg-list-menu');
    menu.setAttribute('aria-haspopup', 'menu');
    controls.append(menu);

    const selectionHeader = el('div', 'sb-bg-selection-header');
    header.append(selectionHeader);
    const selectionBar = el('div', 'sb-bg-selection-bar');
    drawer.append(selectionBar);
    return { selectionHeader, selectionBar, menu };
}

// ---------------------------------------------------------------------------------------------------------------------
// Selection, long press and keyboard

async function deleteSelected(keys) {
    if (!keys.length || bulkBusy) return;
    bulkBusy = true;
    try {
        // HUMAN: replace, the bulk delete confirmation; the count stays explicit.
        const text = `${PLACEHOLDER_COPY} ${folderCountLabel(keys.length, SCOPE)}`;
        if (!await confirmDestructiveAction({ text, confirmLabel: t`Delete`, copyPlaceholder: true })) return;
        const { failed } = await hooks.deleteBackgrounds(keys);
        selection.exit();
        if (failed.length) globalThis.toastr?.error(failed.join(', '), t`Delete failed`);
    } finally {
        bulkBusy = false;
    }
}

function cellFrom(target) {
    const cell = target instanceof Element ? target.closest('.bg_example') : null;
    return cell && container.contains(cell) ? cell : null;
}

function bindTouchAndKeyboard() {
    let press = null;
    const endPress = () => {
        clearTimeout(press?.timer);
        press = null;
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', endPress, true);
        window.removeEventListener('pointercancel', endPress, true);
        clearTimeout(touchGraceTimer);
        touchGraceTimer = setTimeout(() => { touchPress = false; }, TOUCH_GRACE_MS);
    };
    function onMove(event) {
        if (!press || event.pointerId !== press.pointerId) return;
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP) endPress();
    }
    // Capture phase: this runs before selection mode's own touch handler, so it can keep that handler from starting a selection.
    container.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'touch') {
            touchPress = false;
            return;
        }
        touchPress = true;
        clearTimeout(touchGraceTimer);
        const cell = cellFrom(event.target);
        if (!cell || selection?.isActive) return;
        press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, cell };
        press.timer = setTimeout(() => {
            const pending = press;
            endPress();
            touchPress = true;
            clearTimeout(touchGraceTimer);
            touchGraceTimer = setTimeout(() => { touchPress = false; }, TOUCH_GRACE_MS);
            if (!pending?.cell.isConnected) return;
            suppressClickUntil = performance.now() + TOUCH_GRACE_MS;
            const trigger = pending.cell.querySelector('.sb-bg-cell-menu') ?? pending.cell;
            openBackgroundMenu(trigger, pending.cell.getAttribute('bgfile'));
            if (typeof navigator.vibrate === 'function') navigator.vibrate(10);
        }, LONG_PRESS_MS);
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', endPress, true);
        window.addEventListener('pointercancel', endPress, true);
    }, true);
    container.addEventListener('click', event => {
        if (performance.now() >= suppressClickUntil) return;
        suppressClickUntil = 0;
        event.preventDefault();
        event.stopPropagation();
    }, true);
    container.addEventListener('contextmenu', event => {
        if (!touchPress && performance.now() >= swallowContextMenuUntil) return;
        event.preventDefault();
        event.stopPropagation();
    }, true);
    container.addEventListener('keydown', event => {
        const menuKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
        if (!menuKey || event.isComposing || selection?.isActive) return;
        const cell = cellFrom(event.target);
        if (!cell || !(event.target === cell || event.target.classList?.contains('sb-bg-cell-menu'))) return;
        event.preventDefault();
        event.stopPropagation();
        // The browser also sends a `contextmenu` event for these keys; it must not start a selection.
        swallowContextMenuUntil = performance.now() + 400;
        openBackgroundMenu(cell.querySelector('.sb-bg-cell-menu') ?? cell, cell.getAttribute('bgfile'), { keyboard: true });
    }, true);
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry

/**
 * Starts the gallery. Safe to call again.
 * @returns {Promise<void>}
 */
export function initBackgroundGallery() {
    initialized ??= start().catch(error => {
        initialized = null;
        throw error;
    });
    return initialized;
}

async function start() {
    container = document.getElementById('bg_menu_content');
    if (!container || !document.getElementById('bg-header-fixed')) return;
    stylesReady = loadStyles();
    const host = {
        render,
        setQuery: value => {
            const next = String(value ?? '').trim().toLowerCase();
            if (next === query) return;
            query = next;
            render();
        },
        setIndex: index => hydrateBackgroundIndex({ folders: index.folders, imageFolderMap: index.imageFolderMap }),
        filesRemoved: files => { for (const file of files) removeEntityKey(SCOPE, file); },
    };
    hooks = attachBackgroundGallery(host);
    hydrateBackgroundIndex({ folders: hooks.getFolderIndex().folders, imageFolderMap: hooks.getFolderIndex().imageFolderMap });
    attachBackgroundBridge(bridge);

    const { selectionHeader, selectionBar, menu } = buildHeader();
    selection = createSelectionMode({
        root: drawer, list: container, header: selectionHeader, actionBar: selectionBar,
        rowSelector: '.bg_example', getKey: row => row.getAttribute('bgfile'),
        rowLabel: row => friendlyName(row.getAttribute('bgfile') ?? ''),
        range: true, iconOnlyAtNarrow: true,
        // The gallery sits in a scrolling page, so the header that appears at its top is brought into view with the selection.
        onChange: () => {
            if (!selection?.isActive || selectionShown) return;
            selectionShown = true;
            syncFolderRows();
            selectionHeader.scrollIntoView?.({ block: 'nearest' });
        },
        onExit: () => {
            selectionShown = false;
            syncFolderRows();
        },
        // A touch press belongs to the thumbnail's own menu, so selection mode does not start from it.
        canEnter: () => !touchPress && !bulkBusy && hooks.getImages().length > 0 && isGlobalTab(),
        actions: [
            { id: 'folder', label: t`Move to Folder`, icon: 'fa-solid fa-folder', onActivate: keys => moveTo(selectionBar.querySelector('[data-action-id="folder"]'), keys, () => selection.exit()) },
            { id: 'delete', label: t`Delete`, icon: 'fa-solid fa-trash', danger: true, onActivate: keys => deleteSelected(keys) },
        ],
    });
    bindTouchAndKeyboard();

    subscribe(({ scope, reason }) => {
        if (scope && scope !== SCOPE) return;
        // The renders that follow a load, an open or a close, and a deleted file draw themselves; a colour only changes a dot.
        if (['hydrate', 'set-folder-expanded', 'delete-member'].includes(reason)) return;
        if (reason === 'set-folder-color') {
            for (const folder of getFolders(SCOPE)) {
                const dot = container.querySelector(`.sb-folder-row[data-folder-id="${CSS.escape(folder.id)}"] .sb-folder-row__dot`);
                if (!dot) continue;
                if (folder.color) dot.style.setProperty('--sb-folder-color', folder.color);
                else dot.style.removeProperty('--sb-folder-color');
            }
            return;
        }
        render();
    });

    // The panel has its own border and may show a classic scrollbar, so its grid ends short of the tab row's end. The row keeps that
    // distance clear, which puts its last button above the grid's last column.
    const tabs = document.getElementById('bg_tabs');
    const panels = [...tabs.querySelectorAll(':scope > .bg_tab_panel')];
    const syncScrollbar = () => {
        const panel = panels.find(candidate => candidate.getClientRects().length);
        const grid = panel?.querySelector('#bg_menu_content, #bg_custom_content');
        let gap = 0;
        if (panel && grid) {
            const panelBox = panel.getBoundingClientRect();
            const gridBox = grid.getBoundingClientRect();
            gap = getComputedStyle(tabs).direction === 'rtl' ? gridBox.left - panelBox.left : panelBox.right - gridBox.right;
        }
        tabs.style.setProperty('--sb-bg-grid-inset', `${Math.max(0, Math.round(gap * 100) / 100)}px`);
    };
    const scrollbarObserver = new ResizeObserver(syncScrollbar);
    for (const panel of panels) scrollbarObserver.observe(panel);
    scrollbarObserver.observe(container);
    const syncTab = () => {
        if (selection.isActive) selection.exit();
        menu.hidden = !isGlobalTab();
        syncScrollbar();
    };
    $('#bg_tabs').on('tabsactivate', syncTab);
    syncTab();
    syncSortState();
    await stylesReady;
    await render();
}
