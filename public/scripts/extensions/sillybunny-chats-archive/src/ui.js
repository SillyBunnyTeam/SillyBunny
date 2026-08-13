import {
    buildSearchScopes,
    createDefaultOrganization,
    deepResultToRecentRow,
    filterRows,
    findMatchingMessageIndex,
    findMatchingSnippetInJsonlAsync,
    groupRows,
    normalizeRow,
    normalizeOrganization,
    normalizeSavedView,
    ownerFilterKey,
    parseChatJsonl,
    parseOrganization,
    parseJsonl,
    parseOwnerFilter,
    physicalChatKey,
    recordsToText,
    sortRows,
} from './core.js';
import {
    fetchOrganization,
    exportChat,
    fetchArchiveFile,
    fetchArchiveInventory,
    ORGANIZATION_FILE_NAME,
    releaseArchiveSession,
    saveOrganization,
    searchScope,
} from './api.js';

const KINDS = [
    ['solo', 'Characters'],
    ['group', 'Groups'],
    ['orphan', 'Orphaned'],
];

const SORT_OPTIONS = [
    ['recent', 'Recent'],
    ['oldest', 'Oldest'],
    ['size', 'Largest'],
    ['smallest', 'Smallest'],
    ['count', 'Most messages'],
    ['fewest', 'Fewest messages'],
    ['name', 'Name A-Z'],
    ['name-reverse', 'Name Z-A'],
    ['owner', 'Owner'],
];

const GROUP_OPTIONS = [
    ['flat', 'Flat'],
    ['owner', 'Owner'],
    ['type', 'Type'],
    ['folder', 'Folder'],
];

const DENSITY_OPTIONS = [
    ['comfortable', 'Comfortable'],
    ['compact', 'Compact'],
    ['minimal', 'Minimal'],
];

const SORT_PILLS = [
    ['recent', 'Recent'],
    ['oldest', 'Oldest'],
    ['name', 'A-Z'],
    ['size', 'Largest'],
    ['count', 'Most messages'],
];

const LIST_PAGE_SIZE = 100;
const MESSAGE_PAGE_SIZE = 100;
const NAVIGATION_TIMEOUT_MS = 15_000;
const LAST_VIEW_SAVE_DELAY_MS = 500;
const SEARCH_DEBOUNCE_MS = 150;
const MAX_ORGANIZATION_IMPORT_BYTES = 5 * 1024 * 1024;
const RAW_PREVIEW_CHARS = 200_000;
const UNFILED_VALUE = '__sbca_unfiled__';

let popup = null;
let renderId = 0;
let hostNavigationPending = null;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

function button(className, text) {
    const node = el('button', className, text);
    node.type = 'button';
    return node;
}

function appendOption(select, value, text) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
    return option;
}

function selectControl(ctx, label, options, className = 'sbca-filter') {
    const wrap = el('label', className);
    wrap.append(el('span', 'sbca-label', tr(ctx, label)));
    const select = document.createElement('select');
    select.className = 'text_pole';
    for (const [value, text] of options) {
        appendOption(select, value, tr(ctx, text));
    }
    wrap.append(select);
    return { wrap, select };
}

function inputControl(ctx, label, type = 'text', className = 'sbca-filter') {
    const wrap = el('label', className);
    wrap.append(el('span', 'sbca-label', tr(ctx, label)));
    const input = document.createElement('input');
    input.type = type;
    input.className = 'text_pole';
    wrap.append(input);
    return { wrap, input };
}

function ownerControl(ctx) {
    const id = `sbca_owner_${++renderId}`;
    const wrap = el('div', 'sbca-owner-selector');
    const label = el('span', 'sbca-label', tr(ctx, 'Character or group'));
    label.id = `${id}_label`;
    const details = el('details', 'sbca-owner-details');
    const summary = el('summary', 'text_pole sbca-owner-summary');
    const summaryTextId = `${id}_value`;
    summary.setAttribute('aria-labelledby', `${label.id} ${summaryTextId}`);
    const menu = el('div', 'sbca-owner-menu');
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'text_pole sbca-owner-search';
    search.placeholder = tr(ctx, 'Search characters and groups');
    search.setAttribute('aria-label', tr(ctx, 'Search characters and groups'));
    search.autocomplete = 'off';
    const list = el('div', 'sbca-owner-options');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-labelledby', label.id);
    const empty = el('p', 'sbca-owner-empty', tr(ctx, 'No characters or groups match.'));
    empty.hidden = true;
    const input = document.createElement('input');
    input.type = 'hidden';
    menu.append(search, list, empty);
    details.append(summary, menu);
    wrap.append(label, details, input);
    return { wrap, details, summary, summaryTextId, search, list, empty, input, choices: new Map() };
}

function ownerChoiceVisual(ctx, choice) {
    if (choice.avatar) {
        const image = document.createElement('img');
        image.className = 'sbca-owner-mini-avatar';
        image.src = ctx.getThumbnailUrl('avatar', choice.avatar);
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        return image;
    }
    const iconName = choice.kind === 'group'
        ? 'fa-users'
        : choice.kind === 'character'
            ? 'fa-user-slash'
            : 'fa-layer-group';
    const icon = el('i', `sbca-owner-mini-icon fa-solid ${iconName}`);
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

function fallbackOwnerChoice(ctx, value) {
    const parsed = parseOwnerFilter(value);
    if (parsed) {
        return {
            value,
            label: parsed.id,
            meta: tr(ctx, parsed.kind === 'character' ? 'Character unavailable' : 'Group unavailable'),
            kind: parsed.kind,
            id: parsed.id,
            avatar: null,
        };
    }
    return {
        value,
        label: value || tr(ctx, 'All characters and groups'),
        meta: value ? tr(ctx, 'Saved filter') : '',
        kind: '',
        id: '',
        avatar: null,
    };
}

function setOwnerValue(ctx, ui, value) {
    const selected = value ?? '';
    ui.owner.value = selected;
    const choice = ui.ownerField.choices.get(selected) ?? fallbackOwnerChoice(ctx, selected);
    const copy = el('span', 'sbca-owner-choice-copy');
    copy.id = ui.ownerField.summaryTextId;
    const name = el('span', 'sbca-owner-choice-name', choice.label);
    copy.append(name);
    if (choice.meta) {
        copy.append(el('span', 'sbca-owner-choice-meta', choice.meta));
    }
    ui.ownerField.summary.replaceChildren(ownerChoiceVisual(ctx, choice), copy);
    for (const option of ui.ownerField.list.querySelectorAll('.sbca-owner-option')) {
        option.setAttribute('aria-pressed', String(option.dataset.sbcaOwner === selected));
    }
}

function renderOwnerOptions(ctx, ui, choices, selected) {
    ui.ownerField.choices = new Map(choices.map(choice => [choice.value, choice]));
    ui.ownerField.list.replaceChildren();
    for (const choice of choices) {
        const option = button('sbca-owner-option');
        option.dataset.sbcaOwner = choice.value;
        option.dataset.sbcaSearch = `${choice.label} ${choice.meta} ${choice.id}`.toLocaleLowerCase();
        option.setAttribute('aria-label', choice.meta ? `${choice.label}, ${choice.meta}` : choice.label);
        option.append(ownerChoiceVisual(ctx, choice));
        const copy = el('span', 'sbca-owner-choice-copy');
        copy.append(el('span', 'sbca-owner-choice-name', choice.label));
        if (choice.meta) {
            copy.append(el('span', 'sbca-owner-choice-meta', choice.meta));
        }
        option.append(copy);
        const select = () => {
            const changed = ui.owner.value !== choice.value;
            setOwnerValue(ctx, ui, choice.value);
            ui.ownerField.details.open = false;
            ui.ownerField.summary.focus({ preventScroll: true });
            if (changed) {
                ui.owner.dispatchEvent(new Event('change', { bubbles: true }));
            }
        };
        // Mouse/pen commit on pointerdown: platforms that do not focus buttons
        // on press can lose the click when the focusout auto-close hides the
        // option first. Touch waits for click so scroll gestures that start on
        // an option are not mistaken for selection.
        option.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.pointerType === 'touch') {
                return;
            }
            select();
        });
        option.addEventListener('click', select);
        ui.ownerField.list.append(option);
    }
    setOwnerValue(ctx, ui, selected);
    filterOwnerOptions(ui);
}

function filterOwnerOptions(ui) {
    const query = ui.ownerField.search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const option of ui.ownerField.list.querySelectorAll('.sbca-owner-option')) {
        option.hidden = !!query && !option.dataset.sbcaSearch.includes(query);
        visible += option.hidden ? 0 : 1;
    }
    ui.ownerField.empty.hidden = visible > 0;
}

function organizationFocusKey(...parts) {
    return JSON.stringify(parts);
}

function markOrganizationControl(node, focusKey = '', fallbackKey = '') {
    node.dataset.sbcaOrganizationControl = '';
    if (focusKey) {
        node.dataset.sbcaFocusKey = focusKey;
    }
    if (fallbackKey) {
        node.dataset.sbcaFocusFallback = fallbackKey;
    }
    return node;
}

function preserveArchiveFocus(ui, update) {
    const active = document.activeElement;
    const snapshot = active && ui.root.contains(active) ? {
        key: active.dataset.sbcaFocusKey,
        fallback: active.dataset.sbcaFocusFallback,
        list: ui.list.contains(active),
        viewer: ui.viewerContent.contains(active),
    } : null;
    update();
    if (!snapshot || active.isConnected) {
        return;
    }
    const controls = [...ui.root.querySelectorAll('[data-sbca-focus-key]')];
    const target = controls.find(control => control.dataset.sbcaFocusKey === snapshot.key)
        ?? controls.find(control => control.dataset.sbcaFocusKey === snapshot.fallback)
        ?? (snapshot.viewer ? ui.viewerTitle : snapshot.list ? ui.listHeading : null);
    target?.focus({ preventScroll: true });
}

function actionButton(ctx, label, icon) {
    const node = button('sbca-control sbca-action');
    const glyph = el('i', `fa-solid ${icon}`);
    glyph.setAttribute('aria-hidden', 'true');
    node.append(glyph, el('span', 'sbca-button-copy', tr(ctx, label)));
    return node;
}

function tr(ctx, text, replacements = {}) {
    let translated = ctx.translate?.(text) ?? text;
    for (const [key, value] of Object.entries(replacements)) {
        translated = translated.replaceAll(`{${key}}`, () => String(value));
    }
    return translated;
}

function setStatus(ui, text) {
    ui.status.textContent = text;
}

function allRows(state) {
    return [...state.rows, ...state.orphanRows];
}

export async function closeArchive() {
    await popup?.completeCancelled();
}

export async function openArchive(ctx, opener = null) {
    if (popup) {
        popup.dlg?.focus();
        return;
    }

    const state = {
        rows: [],
        orphanRows: [],
        deepRows: null,
        deepQuery: '',
        listState: 'loading',
        listAbort: null,
        viewerAbort: null,
        searchAbort: null,
        scanAbort: null,
        orphanScanComplete: false,
        inventoryFailures: 0,
        archiveReadToken: null,
        navigationPending: false,
        navigationAbort: null,
        navigationControl: null,
        restoreFocus: true,
        selectedKey: null,
        selectedRow: null,
        selectedButton: null,
        selectedBatchKeys: new Set(),
        selectionMode: false,
        collapsedGroups: new Set(),
        visibleLimit: LIST_PAGE_SIZE,
        matchingRows: [],
        charactersByAvatar: new Map((ctx.characters ?? []).filter(character => character?.avatar).map(character => [character.avatar, character])),
        groupsById: new Map((ctx.groups ?? []).filter(group => group?.id !== undefined && group?.id !== null).map(group => [String(group.id), group])),
        organization: null,
        organizationLoadState: 'loading',
        organizationLoadAbort: null,
        organizationLoadError: null,
        organizationWritable: false,
        organizationRevision: 0,
        organizationRequestedRevision: 0,
        organizationSavedRevision: 0,
        organizationSaveError: null,
        organizationSaveRunning: false,
        organizationSavePromise: Promise.resolve(),
        lastViewSaveTimer: null,
        viewTouched: false,
        selectedViewId: null,
        closed: false,
    };
    const ui = buildRoot(ctx, state);
    const instance = new ctx.Popup(ui.root, ctx.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: false,
        okButton: tr(ctx, 'Close'),
    });
    popup = instance;
    state.popup = instance;
    instance.dlg?.classList.add('sbca-dialog');
    instance.dlg?.setAttribute('aria-labelledby', 'sbca_heading');
    instance.okButton?.addEventListener('keydown', event => {
        if (event.key === ' ') {
            event.preventDefault();
            instance.okButton.click();
        }
    });

    try {
        const shown = instance.show();
        void loadRows(ctx, state, ui);
        void loadOrganization(ctx, state, ui);
        await shown;
    } finally {
        state.closed = true;
        state.listAbort?.abort();
        state.viewerAbort?.abort();
        state.searchAbort?.abort();
        state.navigationAbort?.abort();
        state.scanAbort?.abort();
        state.organizationLoadAbort?.abort();
        state.cleanup?.();
        await flushOrganization(ctx, state, ui);
        const releasing = releaseArchiveReadSession(ctx, state);
        if (popup === instance) {
            popup = null;
        }
        if (state.restoreFocus) {
            const returnTarget = opener?.isConnected ? opener : document.getElementById('sbca_drawer_button');
            returnTarget?.focus({ preventScroll: true });
        }
        void releasing;
    }
}

function buildRoot(ctx, state) {
    const root = el('div', 'sbca-root');
    root.dataset.sbcaView = 'list';
    root.dataset.sbcaDensity = 'comfortable';
    const mobileQuery = globalThis.matchMedia('(max-width: 1000px)');
    const avoidSoftwareKeyboard = globalThis.matchMedia('(max-width: 1000px), (any-pointer: coarse)');

    const heading = el('h3', 'sbca-heading', tr(ctx, 'Chat Archive'));
    heading.id = 'sbca_heading';
    heading.tabIndex = -1;

    const toolbar = el('div', 'sbca-toolbar');
    const searchLabel = el('label', 'sbca-search');
    searchLabel.append(el('span', 'sbca-label', tr(ctx, 'Filter indexed chats')));
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'text_pole';
    search.placeholder = tr(ctx, 'File, owner, or latest message');
    search.autocomplete = 'off';
    search.enterKeyHint = 'search';
    (avoidSoftwareKeyboard.matches ? heading : search).setAttribute('autofocus', '');
    searchLabel.append(search);

    const deepButton = button('sbca-control sbca-deep', tr(ctx, 'Search message content'));
    deepButton.title = tr(ctx, 'Search every message in linked chats and orphaned files already shown in the archive.');
    deepButton.disabled = true;

    const searchMode = el('div', 'sbca-search-mode');
    searchMode.hidden = true;
    const searchModeText = el('span', 'sbca-search-mode-text');
    const searchModeClear = button('sbca-control sbca-search-mode-clear', tr(ctx, 'Exit message results'));
    searchMode.append(searchModeText, searchModeClear);

    const browseStrip = el('div', 'sbca-browse-strip');
    const savedViewField = selectControl(ctx, 'Saved view', [['', 'Current view']], 'sbca-sort sbca-browse-field');
    const groupField = selectControl(ctx, 'Group', GROUP_OPTIONS, 'sbca-sort sbca-browse-field');
    const densityField = selectControl(ctx, 'Density', DENSITY_OPTIONS, 'sbca-sort sbca-browse-field');
    const sortField = selectControl(ctx, 'Sort', SORT_OPTIONS, 'sbca-sort sbca-browse-field');
    markOrganizationControl(savedViewField.select);
    browseStrip.append(savedViewField.wrap, groupField.wrap, densityField.wrap, sortField.wrap);
    const browseOptions = el('details', 'sbca-browse-options');
    const browseSummary = el('summary', undefined, tr(ctx, 'Browse options'));
    browseOptions.open = !mobileQuery.matches;
    browseOptions.append(browseSummary, browseStrip);

    const organizationState = el('div', 'sbca-organization-state');
    const organizationStatus = el('span', 'sbca-organization-status', tr(ctx, 'Loading organization...'));
    organizationStatus.setAttribute('role', 'status');
    organizationStatus.setAttribute('aria-live', 'polite');
    const organizationRetry = button('sbca-control sbca-organization-retry', tr(ctx, 'Retry'));
    organizationRetry.hidden = true;
    organizationState.append(organizationStatus, organizationRetry);

    const options = el('details', 'sbca-options');
    options.append(el('summary', undefined, tr(ctx, 'Filters and organization')));
    const optionsPanel = el('div', 'sbca-options-panel');
    const filterTools = el('div', 'sbca-filter-tools');
    const clearFilters = button('sbca-control sbca-clear-filters', tr(ctx, 'Clear filters'));

    const kinds = el('fieldset', 'sbca-kinds');
    kinds.append(el('legend', undefined, tr(ctx, 'Chat types')));
    for (const [kind, label] of KINDS) {
        const wrap = el('label', 'checkbox_label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = true;
        box.dataset.sbcaKind = kind;
        wrap.append(box, document.createTextNode(tr(ctx, label)));
        kinds.append(wrap);
    }

    const ownerField = ownerControl(ctx);
    const orphanField = selectControl(ctx, 'Orphan reason', [
        ['', 'Any reason'],
        ['missing-character', 'Missing character'],
        ['missing-group', 'Missing group'],
        ['unlinked-group', 'Unlinked group'],
        ['root', 'Root file'],
    ]);
    const favoriteField = selectControl(ctx, 'Favorite', [
        ['', 'Any'],
        ['true', 'Favorite'],
        ['false', 'Not favorite'],
    ]);
    const folderField = selectControl(ctx, 'Folder', [
        ['', 'Any folder'],
        [UNFILED_VALUE, 'Unfiled'],
    ]);
    const collectionField = selectControl(ctx, 'Collection', [['', 'Any collection']]);
    const tagField = inputControl(ctx, 'Tag');
    const tagOptions = document.createElement('datalist');
    tagOptions.id = `sbca_tag_options_${++renderId}`;
    tagField.input.setAttribute('list', tagOptions.id);
    const minDateField = inputControl(ctx, 'From date', 'date');
    const maxDateField = inputControl(ctx, 'To date', 'date');
    const minSizeField = inputControl(ctx, 'Minimum size (MB)', 'number');
    const maxSizeField = inputControl(ctx, 'Maximum size (MB)', 'number');
    const minMessagesField = inputControl(ctx, 'Minimum messages', 'number');
    const maxMessagesField = inputControl(ctx, 'Maximum messages', 'number');
    for (const input of [minSizeField.input, maxSizeField.input]) {
        input.min = '0';
        input.step = 'any';
    }
    for (const input of [minMessagesField.input, maxMessagesField.input]) {
        input.min = '0';
        input.step = '1';
    }
    for (const control of [favoriteField.select, folderField.select, collectionField.select, tagField.input]) {
        markOrganizationControl(control);
    }

    const refreshButton = button('sbca-control', tr(ctx, 'Refresh'));
    const scanButton = button('sbca-control', tr(ctx, 'Find orphaned files'));
    scanButton.title = tr(ctx, 'Scan for chats belonging to deleted characters or unlinked groups. This can take a while.');
    const management = el('div', 'sbca-management');
    const managers = {
        folders: buildNamedManager(ctx, 'folders', 'Folders', 'Folder name'),
        collections: buildNamedManager(ctx, 'collections', 'Collections', 'Collection name'),
        views: buildNamedManager(ctx, 'views', 'Saved views', 'View name'),
    };
    management.append(managers.folders.root, managers.collections.root, managers.views.root);
    const backup = buildBackupControls(ctx);
    optionsPanel.append(
        kinds,
        orphanField.wrap,
        favoriteField.wrap,
        folderField.wrap,
        collectionField.wrap,
        tagField.wrap,
        tagOptions,
        minDateField.wrap,
        maxDateField.wrap,
        minSizeField.wrap,
        maxSizeField.wrap,
        minMessagesField.wrap,
        maxMessagesField.wrap,
        refreshButton,
        scanButton,
        management,
        backup.root,
    );
    options.append(optionsPanel);
    filterTools.append(options, clearFilters);

    const status = el('div', 'sbca-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    toolbar.append(searchLabel, deepButton, searchMode, browseOptions, organizationState, filterTools, status);

    const body = el('div', 'sbca-body');
    const listPanel = el('section', 'sbca-list-panel');
    const listTop = el('div', 'sbca-list-top');
    const listHeading = el('h4', 'sbca-section-heading', tr(ctx, 'Chats'));
    listHeading.id = 'sbca_list_heading';
    listHeading.tabIndex = -1;
    const selectionBar = el('div', 'sbca-selection-bar');
    const selectionToggle = button('sbca-control sbca-selection-toggle', tr(ctx, 'Select chats'));
    selectionToggle.setAttribute('aria-pressed', 'false');
    const selectionTools = el('div', 'sbca-selection-tools');
    selectionTools.hidden = true;
    const selectionCount = el('span', 'sbca-selection-count', tr(ctx, '0 selected'));
    selectionCount.setAttribute('role', 'status');
    selectionCount.setAttribute('aria-live', 'polite');
    const selectionClear = button('sbca-control', tr(ctx, 'Clear'));
    const selectionAll = button('sbca-control', tr(ctx, 'Select all matching (0)'));
    const batch = buildBatchControls(ctx);
    selectionTools.append(selectionCount, selectionClear, selectionAll, batch.root);
    selectionBar.append(selectionToggle, selectionTools);
    const sortPills = el('div', 'sbca-sortpills');
    sortPills.setAttribute('role', 'group');
    sortPills.setAttribute('aria-label', tr(ctx, 'Quick sort'));
    for (const [value, label] of SORT_PILLS) {
        const pill = button('sbca-sortpill', tr(ctx, label));
        pill.dataset.sbcaSort = value;
        pill.setAttribute('aria-pressed', 'false');
        sortPills.append(pill);
    }
    const list = el('ul', 'sbca-list');
    list.setAttribute('aria-labelledby', listHeading.id);
    const listTools = el('details', 'sbca-list-tools');
    const listToolsSummary = el('summary', undefined, tr(ctx, 'List tools'));
    const listToolsPanel = el('div', 'sbca-list-tools-panel');
    listToolsPanel.append(ownerField.wrap, sortPills, selectionBar);
    listTools.append(listToolsSummary, listToolsPanel);
    listTop.append(listHeading, listTools);
    listPanel.append(listTop, list);

    const viewer = el('section', 'sbca-viewer');
    const backButton = actionButton(ctx, 'Back to chats', 'fa-arrow-left');
    backButton.classList.add('sbca-back');
    const viewerTitle = el('h4', 'sbca-section-heading', tr(ctx, 'Chat details'));
    viewerTitle.id = 'sbca_viewer_heading';
    viewerTitle.tabIndex = -1;
    const viewerContent = el('div', 'sbca-viewer-content');
    viewerContent.append(el('p', 'sbca-placeholder', tr(ctx, 'Select a chat to inspect it.')));
    viewer.setAttribute('aria-labelledby', viewerTitle.id);
    viewer.append(backButton, viewerTitle, viewerContent);
    body.append(listPanel, viewer);
    root.append(heading, toolbar, body);

    const ui = {
        root,
        heading,
        search,
        kinds,
        savedView: savedViewField.select,
        group: groupField.select,
        density: densityField.select,
        sort: sortField.select,
        owner: ownerField.input,
        ownerField,
        orphan: orphanField.select,
        favorite: favoriteField.select,
        folder: folderField.select,
        collection: collectionField.select,
        tag: tagField.input,
        tagOptions,
        minDate: minDateField.input,
        maxDate: maxDateField.input,
        minSize: minSizeField.input,
        maxSize: maxSizeField.input,
        minMessages: minMessagesField.input,
        maxMessages: maxMessagesField.input,
        deepButton,
        searchMode,
        searchModeText,
        searchModeClear,
        browseOptions,
        options,
        clearFilters,
        refreshButton,
        scanButton,
        status,
        organizationStatus,
        organizationRetry,
        managers,
        backup,
        list,
        listHeading,
        listPanel,
        sortPills,
        selectionToggle,
        selectionTools,
        selectionCount,
        selectionClear,
        selectionAll,
        batch,
        viewer,
        viewerTitle,
        viewerContent,
        backButton,
        mobileQuery,
    };

    renderOwnerOptions(ctx, ui, [fallbackOwnerChoice(ctx, '')], '');
    ownerField.search.addEventListener('input', () => filterOwnerOptions(ui));
    ownerField.search.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            ownerField.list.querySelector('.sbca-owner-option:not([hidden])')?.focus();
        }
    });
    ownerField.list.addEventListener('keydown', event => {
        const option = event.target.closest('.sbca-owner-option');
        if (!option || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            return;
        }
        event.preventDefault();
        const options = [...ownerField.list.querySelectorAll('.sbca-owner-option:not([hidden])')];
        const index = options.indexOf(option);
        const next = event.key === 'Home'
            ? options[0]
            : event.key === 'End'
                ? options.at(-1)
                : options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length];
        next?.focus();
    });
    ownerField.details.addEventListener('keydown', event => {
        if (event.key === 'Escape' && ownerField.details.open) {
            event.preventDefault();
            ownerField.details.open = false;
            ownerField.summary.focus({ preventScroll: true });
        }
    });
    ownerField.details.addEventListener('toggle', () => {
        if (ownerField.details.open) {
            ownerField.search.value = '';
            filterOwnerOptions(ui);
        }
    });
    ownerField.details.addEventListener('focusout', () => {
        // A macrotask, not a microtask: a tap's down/up/click sequence must
        // finish before the close check or the option hides under the click.
        setTimeout(() => {
            if (!ownerField.details.contains(document.activeElement)) {
                ownerField.details.open = false;
            }
        });
    });
    const closeOwnerOnOutside = event => {
        if (ownerField.details.open && !ownerField.details.contains(event.target)) {
            ownerField.details.open = false;
        }
    };
    document.addEventListener('pointerdown', closeOwnerOnOutside);

    for (const [type, manager] of Object.entries(managers)) {
        wireNamedManager(ctx, state, ui, type, manager);
    }
    backup.exportButton.addEventListener('click', () => exportOrganization(ctx, state));
    backup.importButton.addEventListener('click', () => backup.fileInput.click());
    backup.fileInput.addEventListener('change', () => void importOrganization(ctx, state, ui));
    organizationRetry.addEventListener('click', () => {
        if (state.organizationLoadState === 'error') {
            void loadOrganization(ctx, state, ui);
        } else {
            requestOrganizationSave(ctx, state, ui);
        }
    });

    let queryTimer = null;
    const handleBreakpoint = event => {
        const active = document.activeElement;
        const focusInBrowse = browseStrip.contains(active);
        browseOptions.open = !event.matches;
        if (state.closed) {
            return;
        }
        if (!event.matches) {
            if (active === browseSummary) {
                groupField.select.focus({ preventScroll: true });
            }
            return;
        }
        if (root.dataset.sbcaView === 'detail' && (active === document.body || toolbar.contains(active) || listPanel.contains(active))) {
            viewerTitle.focus({ preventScroll: true });
        } else if (root.dataset.sbcaView === 'list' && focusInBrowse) {
            browseSummary.focus({ preventScroll: true });
        } else if (root.dataset.sbcaView === 'list' && (active === document.body || viewer.contains(active))) {
            search.focus({ preventScroll: true });
        }
    };
    mobileQuery.addEventListener('change', handleBreakpoint);
    state.cleanup = () => {
        clearTimeout(queryTimer);
        mobileQuery.removeEventListener('change', handleBreakpoint);
        document.removeEventListener('pointerdown', closeOwnerOnOutside);
    };

    const applyQuery = () => {
        exitDeepSearch(ctx, state, ui);
        state.visibleLimit = LIST_PAGE_SIZE;
        renderList(ctx, state, ui);
        updateBrowseStatus(ctx, state, ui);
        updateDeepButton(state, ui);
        updateSelectionControls(ctx, state, ui);
    };
    const applyViewOptions = () => {
        ui.root.dataset.sbcaDensity = ui.density.value;
        state.visibleLimit = LIST_PAGE_SIZE;
        renderList(ctx, state, ui);
        syncSortPills();
        if (!state.searchAbort) {
            if (state.deepRows === null) {
                updateBrowseStatus(ctx, state, ui);
            } else {
                setStatus(ui, tr(ctx, '{matching} of {total} matching chats', {
                    matching: state.matchingRows.length,
                    total: state.deepRows.length,
                }));
            }
        }
        updateSelectionControls(ctx, state, ui);
    };
    const noteViewEdit = () => {
        state.viewTouched = true;
        state.selectedViewId = null;
        ui.savedView.value = '';
        rememberCurrentView(ctx, state, ui);
    };
    const flushQuery = () => {
        if (queryTimer === null) {
            return;
        }
        clearTimeout(queryTimer);
        queryTimer = null;
        applyQuery();
    };
    const syncSortPills = () => {
        for (const pill of ui.sortPills.querySelectorAll('.sbca-sortpill')) {
            const active = pill.dataset.sbcaSort === ui.sort.value;
            pill.setAttribute('aria-pressed', String(active));
        }
    };
    for (const pill of ui.sortPills.querySelectorAll('.sbca-sortpill')) {
        pill.addEventListener('click', () => {
            ui.sort.value = pill.dataset.sbcaSort;
            applyViewOptions();
            noteViewEdit();
        });
    }
    search.addEventListener('input', () => {
        exitDeepSearch(ctx, state, ui);
        noteViewEdit();
        updateSearchMode(ctx, state, ui);
        updateDeepButton(state, ui);
        clearTimeout(queryTimer);
        queryTimer = setTimeout(() => {
            queryTimer = null;
            applyQuery();
        }, SEARCH_DEBOUNCE_MS);
    });
    search.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing) {
            return;
        }
        event.preventDefault();
        flushQuery();
    });
    kinds.addEventListener('change', () => {
        applyViewOptions();
        noteViewEdit();
    });
    for (const control of [
        ui.group,
        ui.density,
        ui.sort,
        ui.owner,
        ui.orphan,
        ui.favorite,
        ui.folder,
        ui.collection,
        ui.minDate,
        ui.maxDate,
        ui.minSize,
        ui.maxSize,
        ui.minMessages,
        ui.maxMessages,
    ]) {
        control.addEventListener('change', () => {
            if (control === ui.density) {
                ui.root.dataset.sbcaDensity = ui.density.value;
                noteViewEdit();
                return;
            }
            if (control === ui.owner) {
                exitDeepSearch(ctx, state, ui);
            }
            applyViewOptions();
            noteViewEdit();
        });
    }
    ui.tag.addEventListener('input', () => {
        noteViewEdit();
        clearTimeout(queryTimer);
        queryTimer = setTimeout(() => {
            queryTimer = null;
            applyViewOptions();
        }, SEARCH_DEBOUNCE_MS);
    });
    ui.savedView.addEventListener('change', () => {
        const selected = state.organization?.views.find(view => view.id === ui.savedView.value);
        if (selected) {
            applySavedView(ctx, state, ui, selected.view, selected.id);
        } else {
            state.selectedViewId = null;
        }
    });
    refreshButton.addEventListener('click', () => void loadRows(ctx, state, ui));
    scanButton.addEventListener('click', () => {
        if (state.scanAbort) {
            state.scanAbort.abort();
            scanButton.disabled = true;
            scanButton.textContent = tr(ctx, 'Stopping...');
            setStatus(ui, tr(ctx, 'Stopping after the current server scan...'));
        } else {
            void scanOrphans(ctx, state, ui);
        }
    });
    deepButton.addEventListener('click', () => {
        if (state.searchAbort) {
            state.searchAbort.abort();
        } else {
            flushQuery();
            void runDeepSearch(ctx, state, ui);
        }
    });
    searchModeClear.addEventListener('click', () => {
        applyQuery();
        search.focus({ preventScroll: true });
    });
    clearFilters.addEventListener('click', () => {
        clearTimeout(queryTimer);
        queryTimer = null;
        applySavedView(ctx, state, ui, {
            sort: ui.sort.value,
            group: ui.group.value,
            density: ui.density.value,
        });
        search.focus({ preventScroll: true });
    });
    selectionToggle.addEventListener('click', () => {
        state.selectionMode = !state.selectionMode;
        if (!state.selectionMode) {
            state.selectedBatchKeys.clear();
        } else {
            listTools.open = true;
        }
        renderList(ctx, state, ui);
        updateSelectionControls(ctx, state, ui);
    });
    selectionClear.addEventListener('click', () => {
        state.selectedBatchKeys.clear();
        renderList(ctx, state, ui);
        updateSelectionControls(ctx, state, ui);
    });
    selectionAll.addEventListener('click', () => {
        for (const row of state.matchingRows) {
            state.selectedBatchKeys.add(physicalChatKey(row));
        }
        renderList(ctx, state, ui);
        updateSelectionControls(ctx, state, ui);
    });
    batch.favorite.addEventListener('click', () => mutateSelectedChats(ctx, state, ui, metadata => {
        metadata.favorite = true;
    }));
    batch.unfavorite.addEventListener('click', () => mutateSelectedChats(ctx, state, ui, metadata => {
        delete metadata.favorite;
    }));
    batch.folderApply.addEventListener('click', () => {
        if (!batch.folder.value) {
            return;
        }
        mutateSelectedChats(ctx, state, ui, metadata => {
            if (batch.folder.value === UNFILED_VALUE) {
                delete metadata.folder;
            } else {
                metadata.folder = batch.folder.value;
            }
        });
    });
    batch.collectionAdd.addEventListener('click', () => {
        if (batch.collection.value) {
            mutateSelectedChats(ctx, state, ui, metadata => {
                metadata.collections = [...new Set([...(metadata.collections ?? []), batch.collection.value])];
            });
        }
    });
    batch.collectionRemove.addEventListener('click', () => {
        if (batch.collection.value) {
            mutateSelectedChats(ctx, state, ui, metadata => {
                metadata.collections = (metadata.collections ?? []).filter(id => id !== batch.collection.value);
            });
        }
    });
    batch.tagsAdd.addEventListener('click', () => {
        const tags = commaValues(batch.tags.value);
        if (tags.length > 0) {
            mutateSelectedChats(ctx, state, ui, metadata => {
                metadata.tags = [...(metadata.tags ?? []), ...tags];
            });
        }
    });
    batch.tagsRemove.addEventListener('click', () => {
        const tags = new Set(commaValues(batch.tags.value).map(tag => tag.toLocaleLowerCase()));
        if (tags.size > 0) {
            mutateSelectedChats(ctx, state, ui, metadata => {
                metadata.tags = (metadata.tags ?? []).filter(tag => !tags.has(tag.toLocaleLowerCase()));
            });
        }
    });
    backButton.addEventListener('click', () => showList(state, ui));
    list.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
            return;
        }
        const rows = [...list.querySelectorAll('.sbca-row-button')];
        const current = rows.indexOf(event.target.closest('.sbca-row-button'));
        if (rows.length === 0 || current < 0) {
            return;
        }
        event.preventDefault();
        if (event.key === 'ArrowDown' && current === rows.length - 1) {
            const more = list.querySelector('.sbca-list-more .sbca-control');
            if (more) {
                more.click();
                return;
            }
        }
        rows[Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
    });

    updateOrganizationStatus(ctx, state, ui);
    updateSelectionControls(ctx, state, ui);
    setOrganizationControlsEnabled(ui, false);
    syncSortPills();
    return ui;
}

function buildNamedManager(ctx, type, title, inputLabel) {
    const root = el('section', 'sbca-named-manager');
    root.append(el('h5', 'sbca-manager-heading', tr(ctx, title)));
    const create = el('div', 'sbca-manager-create');
    const field = inputControl(ctx, inputLabel);
    const add = button('sbca-control', tr(ctx, 'Create'));
    const createKey = organizationFocusKey('manager', type, 'create');
    markOrganizationControl(field.input, createKey);
    markOrganizationControl(add, organizationFocusKey('manager', type, 'add'), createKey);
    create.append(field.wrap, add);
    const status = el('div', 'sbca-manager-status');
    status.setAttribute('role', 'alert');
    const list = el('div', 'sbca-manager-list');
    root.append(create, status, list);
    return { root, input: field.input, add, status, list, createKey };
}

function buildBatchControls(ctx) {
    const root = el('div', 'sbca-batch-actions');
    const favorite = button('sbca-control', tr(ctx, 'Favorite'));
    const unfavorite = button('sbca-control', tr(ctx, 'Unfavorite'));
    const folderField = selectControl(ctx, 'Folder', [
        ['', 'Choose folder'],
        [UNFILED_VALUE, 'Clear folder'],
    ]);
    const folderApply = button('sbca-control', tr(ctx, 'Set folder'));
    const collectionField = selectControl(ctx, 'Collection', [['', 'Choose collection']]);
    const collectionAdd = button('sbca-control', tr(ctx, 'Add collection'));
    const collectionRemove = button('sbca-control', tr(ctx, 'Remove collection'));
    const tagsField = inputControl(ctx, 'Tags (comma-separated)');
    const tagsAdd = button('sbca-control', tr(ctx, 'Add tags'));
    const tagsRemove = button('sbca-control', tr(ctx, 'Remove tags'));
    for (const control of [
        favorite,
        unfavorite,
        folderField.select,
        folderApply,
        collectionField.select,
        collectionAdd,
        collectionRemove,
        tagsField.input,
        tagsAdd,
        tagsRemove,
    ]) {
        markOrganizationControl(control);
    }
    root.append(
        favorite,
        unfavorite,
        folderField.wrap,
        folderApply,
        collectionField.wrap,
        collectionAdd,
        collectionRemove,
        tagsField.wrap,
        tagsAdd,
        tagsRemove,
    );
    return {
        root,
        favorite,
        unfavorite,
        folder: folderField.select,
        folderApply,
        collection: collectionField.select,
        collectionAdd,
        collectionRemove,
        tags: tagsField.input,
        tagsAdd,
        tagsRemove,
    };
}

function buildBackupControls(ctx) {
    const root = el('section', 'sbca-organization-backup');
    root.append(el('h5', 'sbca-manager-heading', tr(ctx, 'Organization backup')));
    const exportButton = button('sbca-control', tr(ctx, 'Export organization'));
    const importButton = button('sbca-control', tr(ctx, 'Import organization'));
    markOrganizationControl(exportButton);
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.hidden = true;
    const status = el('div', 'sbca-import-status');
    status.setAttribute('role', 'alert');
    const warning = el('p', 'sbca-organization-warning', tr(ctx,
        'Do not delete {name} through host Data Maid; it stores Chat Archive organization.',
        { name: ORGANIZATION_FILE_NAME },
    ));
    root.append(exportButton, importButton, fileInput, status, warning);
    return { root, exportButton, importButton, fileInput, status };
}

function commaValues(value) {
    return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

function inputNumber(input, multiplier = 1, integer = false) {
    if (!input.value.trim()) {
        return undefined;
    }
    const value = Number(input.value) * multiplier;
    return Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : undefined;
}

function inputDate(input, endOfDay = false) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.value);
    if (!match) {
        return undefined;
    }
    const value = new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        endOfDay ? 23 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 999 : 0,
    ).valueOf();
    return Number.isFinite(value) ? value : undefined;
}

function currentSavedView(state, ui) {
    const view = {
        query: ui.search.value,
        kinds: [...ui.kinds.querySelectorAll('input:checked')].map(box => box.dataset.sbcaKind),
        sort: ui.sort.value,
        group: ui.group.value,
        density: ui.density.value,
        owner: ui.owner.value,
        orphan: ui.orphan.value,
        tag: ui.tag.value,
        minDate: inputDate(ui.minDate),
        maxDate: inputDate(ui.maxDate, true),
        minSize: inputNumber(ui.minSize, 1024 ** 2),
        maxSize: inputNumber(ui.maxSize, 1024 ** 2),
        minMessages: inputNumber(ui.minMessages, 1, true),
        maxMessages: inputNumber(ui.maxMessages, 1, true),
    };
    if (ui.favorite.value) {
        view.favorite = ui.favorite.value === 'true';
    }
    if (ui.folder.value) {
        view.folder = ui.folder.value === UNFILED_VALUE ? null : ui.folder.value;
    }
    if (ui.collection.value) {
        view.collection = ui.collection.value;
    }
    return normalizeSavedView(view, state.organization);
}

function rememberCurrentView(ctx, state, ui) {
    if (!state.organizationWritable || !state.organization) {
        return;
    }
    state.organization = { ...state.organization, lastView: currentSavedView(state, ui) };
    markOrganizationDirty(ctx, state, ui, true);
}

function dateInputValue(value) {
    if (value === undefined) {
        return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) {
        return '';
    }
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

function applySavedView(ctx, state, ui, value, selectedViewId = null, persist = true) {
    const view = normalizeSavedView(value, state.organization);
    exitDeepSearch(ctx, state, ui);
    ui.search.value = view.query ?? '';
    const kinds = new Set(view.kinds ?? KINDS.map(([kind]) => kind));
    for (const box of ui.kinds.querySelectorAll('input')) {
        box.checked = kinds.has(box.dataset.sbcaKind);
    }
    ui.sort.value = view.sort ?? 'recent';
    ui.group.value = view.group ?? 'flat';
    ui.density.value = view.density ?? 'comfortable';
    const owner = view.owner ?? '';
    setOwnerValue(ctx, ui, owner);
    if (owner && !ui.ownerField.choices.has(owner)) {
        refreshOwnerOptions(ctx, state, ui);
    }
    ui.orphan.value = view.orphan ?? '';
    ui.favorite.value = typeof view.favorite === 'boolean' ? String(view.favorite) : '';
    ui.folder.value = view.folder === null ? UNFILED_VALUE : view.folder ?? '';
    ui.collection.value = view.collection ?? '';
    ui.tag.value = view.tag ?? '';
    ui.minDate.value = dateInputValue(view.minDate);
    ui.maxDate.value = dateInputValue(view.maxDate);
    ui.minSize.value = view.minSize === undefined ? '' : String(view.minSize / 1024 ** 2);
    ui.maxSize.value = view.maxSize === undefined ? '' : String(view.maxSize / 1024 ** 2);
    ui.minMessages.value = view.minMessages ?? '';
    ui.maxMessages.value = view.maxMessages ?? '';
    ui.root.dataset.sbcaDensity = ui.density.value;
    state.selectedViewId = selectedViewId;
    ui.savedView.value = selectedViewId ?? '';
    state.visibleLimit = LIST_PAGE_SIZE;
    renderList(ctx, state, ui);
    updateBrowseStatus(ctx, state, ui);
    updateDeepButton(state, ui);
    updateSelectionControls(ctx, state, ui);
    if (persist) {
        state.viewTouched = true;
        if (state.organizationWritable) {
            state.organization = { ...state.organization, lastView: view };
            markOrganizationDirty(ctx, state, ui, true);
        }
    }
}

function setOrganizationControlsEnabled(ui, enabled) {
    for (const control of ui.root.querySelectorAll('[data-sbca-organization-control]')) {
        control.disabled = !enabled;
    }
}

function updateOrganizationStatus(ctx, state, ui) {
    let text = 'Saved';
    if (state.organizationLoadState === 'loading') {
        text = 'Loading organization...';
    } else if (state.organizationSaveRunning) {
        text = 'Saving...';
    } else if (state.organizationLoadError) {
        text = 'Unsaved - organization could not be loaded. Retry or import a backup.';
    } else if (state.organizationSaveError) {
        text = 'Unsaved - save failed. Retry to keep these changes.';
    } else if (state.organizationRevision > state.organizationSavedRevision) {
        text = 'Unsaved';
    }
    ui.organizationStatus.textContent = tr(ctx, text);
    ui.organizationRetry.hidden = !state.organizationLoadError && !state.organizationSaveError;
    setOrganizationControlsEnabled(ui, state.organizationWritable);
    updateSelectionControls(ctx, state, ui);
}

async function loadOrganization(ctx, state, ui) {
    state.organizationLoadAbort?.abort();
    const controller = new AbortController();
    state.organizationLoadAbort = controller;
    state.organizationLoadState = 'loading';
    state.organizationLoadError = null;
    state.organizationWritable = false;
    ui.backup.status.textContent = '';
    updateOrganizationStatus(ctx, state, ui);
    try {
        const value = await fetchOrganization(ctx, controller.signal);
        const organization = value === null ? createDefaultOrganization() : normalizeOrganization(value);
        if (state.organizationLoadAbort !== controller || state.closed) {
            return;
        }
        preserveArchiveFocus(ui, () => {
            state.organization = organization;
            state.organizationLoadState = 'ready';
            state.organizationWritable = true;
            state.organizationLoadError = null;
            state.organizationSaveError = null;
            refreshOrganizationUI(ctx, state, ui);
            if (state.viewTouched) {
                state.organization = { ...state.organization, lastView: currentSavedView(state, ui) };
                markOrganizationDirty(ctx, state, ui, true);
            } else {
                applySavedView(ctx, state, ui, state.organization.lastView, null, false);
            }
            refreshOpenOrganizer(ctx, state, ui);
            updateOrganizationStatus(ctx, state, ui);
        });
    } catch (error) {
        if (error?.name === 'AbortError' || state.organizationLoadAbort !== controller || state.closed) {
            return;
        }
        console.error('[Chat Archive] failed to load organization:', error);
        preserveArchiveFocus(ui, () => {
            state.organizationLoadState = 'error';
            state.organizationLoadError = error;
            state.organizationWritable = false;
            ui.backup.status.textContent = tr(ctx, 'Organization could not be loaded. Retry or import a backup.');
            updateOrganizationStatus(ctx, state, ui);
            refreshOpenOrganizer(ctx, state, ui);
        });
    } finally {
        if (state.organizationLoadAbort === controller) {
            state.organizationLoadAbort = null;
        }
    }
}

function markOrganizationDirty(ctx, state, ui, debounce = false) {
    if (!state.organizationWritable || !state.organization) {
        return;
    }
    state.organizationRevision++;
    state.organizationSaveError = null;
    clearTimeout(state.lastViewSaveTimer);
    state.lastViewSaveTimer = null;
    updateOrganizationStatus(ctx, state, ui);
    if (debounce) {
        state.lastViewSaveTimer = setTimeout(() => {
            state.lastViewSaveTimer = null;
            requestOrganizationSave(ctx, state, ui);
        }, LAST_VIEW_SAVE_DELAY_MS);
    } else {
        requestOrganizationSave(ctx, state, ui);
    }
}

function requestOrganizationSave(ctx, state, ui) {
    if (!state.organizationWritable || !state.organization || state.organizationRevision === 0) {
        return;
    }
    state.organizationRequestedRevision = state.organizationRevision;
    if (!state.organizationSaveRunning) {
        runOrganizationSave(ctx, state, ui);
    }
}

function runOrganizationSave(ctx, state, ui) {
    const revision = state.organizationRequestedRevision;
    if (!state.organizationWritable || !state.organization || revision <= state.organizationSavedRevision) {
        return state.organizationSavePromise;
    }
    state.organizationSaveRunning = true;
    state.organizationSaveError = null;
    const snapshot = state.organization;
    updateOrganizationStatus(ctx, state, ui);
    // ponytail: host upload has no compare-and-swap/etag; simultaneous tabs are last-writer-wins.
    const operation = saveOrganization(ctx, snapshot)
        .then(() => {
            state.organizationSavedRevision = Math.max(state.organizationSavedRevision, revision);
        })
        .catch(error => {
            state.organizationSaveError = error;
            console.error('[Chat Archive] failed to save organization:', error);
        })
        .finally(() => {
            state.organizationSaveRunning = false;
            updateOrganizationStatus(ctx, state, ui);
            if (state.organizationRequestedRevision > revision) {
                runOrganizationSave(ctx, state, ui);
            }
        });
    state.organizationSavePromise = operation;
    return operation;
}

async function flushOrganization(ctx, state, ui) {
    if (state.lastViewSaveTimer) {
        clearTimeout(state.lastViewSaveTimer);
        state.lastViewSaveTimer = null;
    }
    if (state.organizationWritable && state.organizationRevision > state.organizationSavedRevision) {
        requestOrganizationSave(ctx, state, ui);
    }
    while (state.organizationSaveRunning) {
        await state.organizationSavePromise;
    }
    if (state.organizationWritable && state.organizationRevision > state.organizationSavedRevision) {
        requestOrganizationSave(ctx, state, ui);
        await state.organizationSavePromise;
    }
    if (state.organizationSaveError && state.organizationRevision > state.organizationSavedRevision) {
        globalThis.toastr?.error?.(tr(ctx, 'Organization changes could not be saved.'));
    }
}

function replaceSelectOptions(select, options, selected = select.value) {
    select.replaceChildren();
    for (const [value, label] of options) {
        appendOption(select, value, label);
    }
    select.value = options.some(([value]) => value === selected) ? selected : '';
}

function refreshOwnerOptions(ctx, state, ui) {
    const current = ui.owner.value;
    const owners = new Map();
    for (const row of allRows(state)) {
        const value = ownerFilterKey(row);
        const identity = parseOwnerFilter(value);
        if (!identity) {
            continue;
        }
        const choice = {
            value,
            label: ownerLabel(ctx, row),
            meta: '',
            kind: identity.kind,
            id: identity.id,
            avatar: identity.kind === 'character' && row.kind === 'solo' ? row.avatar : null,
        };
        if (!owners.has(value) || (!owners.get(value).avatar && choice.avatar)) {
            owners.set(value, choice);
        }
    }
    const counts = new Map();
    for (const choice of owners.values()) {
        const name = choice.label.toLocaleLowerCase();
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const choice of owners.values()) {
        if (counts.get(choice.label.toLocaleLowerCase()) > 1) {
            choice.meta = tr(ctx, choice.kind === 'character' ? 'Character: {name}' : 'Group: {name}', { name: choice.id });
        }
    }
    const choices = [...owners.values()].sort((a, b) => (
        a.label.localeCompare(b.label)
        || a.kind.localeCompare(b.kind)
        || a.id.localeCompare(b.id)
    ));
    choices.unshift(fallbackOwnerChoice(ctx, ''));
    if (current && !owners.has(current)) {
        choices.push(fallbackOwnerChoice(ctx, current));
    }
    renderOwnerOptions(ctx, ui, choices, current);
}

function refreshOrganizationUI(ctx, state, ui) {
    const organization = state.organization;
    if (!organization) {
        return;
    }
    const folders = organization.folders.map(item => [item.id, item.name]);
    const collections = organization.collections.map(item => [item.id, item.name]);
    replaceSelectOptions(ui.savedView, [
        ['', tr(ctx, 'Current view')],
        ...organization.views.map(view => [view.id, view.name]),
    ], state.selectedViewId ?? '');
    if (state.selectedViewId && !organization.views.some(view => view.id === state.selectedViewId)) {
        state.selectedViewId = null;
    }
    replaceSelectOptions(ui.folder, [
        ['', tr(ctx, 'Any folder')],
        [UNFILED_VALUE, tr(ctx, 'Unfiled')],
        ...folders,
    ]);
    replaceSelectOptions(ui.collection, [['', tr(ctx, 'Any collection')], ...collections]);
    replaceSelectOptions(ui.batch.folder, [
        ['', tr(ctx, 'Choose folder')],
        [UNFILED_VALUE, tr(ctx, 'Clear folder')],
        ...folders,
    ]);
    replaceSelectOptions(ui.batch.collection, [['', tr(ctx, 'Choose collection')], ...collections]);
    refreshTagOptions(state, ui);
    for (const [type, manager] of Object.entries(ui.managers)) {
        renderNamedManager(ctx, state, ui, type, manager);
    }
    setOrganizationControlsEnabled(ui, state.organizationWritable);
    updateSelectionControls(ctx, state, ui);
}

function refreshTagOptions(state, ui) {
    const tags = new Set();
    for (const metadata of Object.values(state.organization?.chats ?? {})) {
        for (const tag of metadata.tags ?? []) {
            tags.add(tag);
        }
    }
    ui.tagOptions.replaceChildren(...[...tags].sort().map(tag => {
        const option = document.createElement('option');
        option.value = tag;
        return option;
    }));
}

function wireNamedManager(ctx, state, ui, type, manager) {
    const create = () => {
        const name = manager.input.value.trim();
        if (!name) {
            manager.status.textContent = tr(ctx, 'Enter a name.');
            return;
        }
        if (hasDuplicateName(state.organization?.[type], name)) {
            manager.status.textContent = tr(ctx, 'That name is already in use.');
            return;
        }
        const item = { id: crypto.randomUUID(), name };
        if (type === 'views') {
            item.view = currentSavedView(state, ui);
        }
        state.organization = normalizeOrganization({
            ...state.organization,
            [type]: [...state.organization[type], item],
        });
        state.selectedViewId = type === 'views' ? item.id : state.selectedViewId;
        manager.input.value = '';
        manager.status.textContent = '';
        commitOrganizationChange(ctx, state, ui);
    };
    manager.add.addEventListener('click', create);
    manager.input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            create();
        }
    });
}

function hasDuplicateName(items, name, exceptId = null) {
    const folded = name.toLocaleLowerCase();
    return (items ?? []).some(item => item.id !== exceptId && item.name.toLocaleLowerCase() === folded);
}

function renderNamedManager(ctx, state, ui, type, manager) {
    manager.list.replaceChildren();
    const items = state.organization?.[type] ?? [];
    if (items.length === 0) {
        manager.list.append(el('p', 'sbca-placeholder', tr(ctx, 'None yet.')));
        return;
    }
    for (const item of items) {
        const row = el('div', 'sbca-manager-row');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'text_pole';
        input.value = item.name;
        input.setAttribute('aria-label', tr(ctx, 'Rename {name}', { name: item.name }));
        const rename = button('sbca-control', tr(ctx, 'Rename'));
        const remove = button('sbca-control', tr(ctx, 'Delete'));
        rename.setAttribute('aria-label', tr(ctx, 'Rename {name}', { name: item.name }));
        remove.setAttribute('aria-label', tr(ctx, 'Delete {name}', { name: item.name }));
        markOrganizationControl(input, organizationFocusKey('manager', type, item.id, 'name'), manager.createKey);
        markOrganizationControl(rename, organizationFocusKey('manager', type, item.id, 'rename'), manager.createKey);
        markOrganizationControl(remove, organizationFocusKey('manager', type, item.id, 'delete'), manager.createKey);
        rename.addEventListener('click', () => {
            const name = input.value.trim();
            if (!name) {
                manager.status.textContent = tr(ctx, 'Enter a name.');
                return;
            }
            if (hasDuplicateName(items, name, item.id)) {
                manager.status.textContent = tr(ctx, 'That name is already in use.');
                return;
            }
            state.organization = normalizeOrganization({
                ...state.organization,
                [type]: items.map(value => value.id === item.id ? { ...value, name } : value),
            });
            manager.status.textContent = '';
            commitOrganizationChange(ctx, state, ui);
        });
        remove.addEventListener('click', () => deleteNamedItem(ctx, state, ui, type, item));
        row.append(input, rename, remove);
        manager.list.append(row);
    }
}

function namedItemHasReferences(organization, type, id) {
    const field = type === 'folders' ? 'folder' : 'collection';
    if (organization.lastView?.[field] === id || organization.views.some(view => view.view[field] === id)) {
        return true;
    }
    return Object.values(organization.chats).some(metadata => (
        type === 'folders' ? metadata.folder === id : metadata.collections?.includes(id)
    ));
}

function deleteNamedItem(ctx, state, ui, type, item) {
    if (type === 'views' && !globalThis.confirm(tr(ctx, 'Delete saved view {name}?', { name: item.name }))) {
        return;
    }
    if ((type === 'folders' || type === 'collections')
        && namedItemHasReferences(state.organization, type, item.id)
        && !globalThis.confirm(tr(ctx, 'Delete {name} and remove it from chats and saved views?', { name: item.name }))) {
        return;
    }
    state.organization = normalizeOrganization({
        ...state.organization,
        [type]: state.organization[type].filter(value => value.id !== item.id),
    });
    if (type === 'views' && state.selectedViewId === item.id) {
        state.selectedViewId = null;
    }
    commitOrganizationChange(ctx, state, ui);
}

function commitOrganizationChange(ctx, state, ui) {
    preserveArchiveFocus(ui, () => {
        refreshOrganizationUI(ctx, state, ui);
        renderList(ctx, state, ui);
        updateBrowseStatus(ctx, state, ui);
        refreshOpenOrganizer(ctx, state, ui);
        markOrganizationDirty(ctx, state, ui);
    });
}

function commitChatMetadataChange(ctx, state, ui) {
    preserveArchiveFocus(ui, () => {
        refreshTagOptions(state, ui);
        renderList(ctx, state, ui);
        updateBrowseStatus(ctx, state, ui);
        refreshOpenOrganizer(ctx, state, ui);
        markOrganizationDirty(ctx, state, ui);
    });
}

function exportOrganization(ctx, state) {
    if (!state.organization) {
        return;
    }
    const text = `${JSON.stringify(normalizeOrganization(state.organization), null, 2)}\n`;
    downloadBlob(text, 'application/json;charset=utf-8', ORGANIZATION_FILE_NAME);
    globalThis.toastr?.success(tr(ctx, 'Organization export started.'));
}

async function importOrganization(ctx, state, ui) {
    const file = ui.backup.fileInput.files?.[0];
    ui.backup.fileInput.value = '';
    if (!file) {
        return;
    }
    if (file.size > MAX_ORGANIZATION_IMPORT_BYTES) {
        ui.backup.status.textContent = tr(ctx, 'Organization files must be 5 MiB or smaller.');
        return;
    }
    let organization;
    try {
        organization = parseOrganization(await file.text());
    } catch (error) {
        console.warn('[Chat Archive] invalid organization import:', error);
        ui.backup.status.textContent = tr(ctx, 'This organization backup is invalid or unsupported.');
        return;
    }
    if (!globalThis.confirm(tr(ctx, 'Replace all current folders, collections, saved views, tags, and favorites?'))) {
        return;
    }
    state.organizationLoadAbort?.abort();
    state.organizationLoadAbort = null;
    preserveArchiveFocus(ui, () => {
        state.organization = organization;
        state.organizationLoadState = 'ready';
        state.organizationLoadError = null;
        state.organizationSaveError = null;
        state.organizationWritable = true;
        state.selectedViewId = null;
        refreshOrganizationUI(ctx, state, ui);
        applySavedView(ctx, state, ui, organization.lastView, null, false);
        ui.backup.status.textContent = tr(ctx, 'Imported organization. Saving replacement...');
        refreshOpenOrganizer(ctx, state, ui);
        markOrganizationDirty(ctx, state, ui);
    });
}

function updateSelectionControls(ctx, state, ui) {
    const selected = state.selectedBatchKeys.size;
    ui.selectionToggle.setAttribute('aria-pressed', String(state.selectionMode));
    ui.selectionToggle.textContent = tr(ctx, state.selectionMode ? 'Stop selecting' : 'Select chats');
    ui.selectionTools.hidden = !state.selectionMode;
    ui.selectionClear.disabled = selected === 0;
    for (const control of ui.batch.root.querySelectorAll('[data-sbca-organization-control]')) {
        control.disabled = !state.organizationWritable || selected === 0;
    }
    if (!state.selectionMode) {
        return;
    }
    const matchingKeys = new Set(state.matchingRows.map(physicalChatKey));
    const hidden = [...state.selectedBatchKeys].filter(key => !matchingKeys.has(key)).length;
    ui.selectionCount.textContent = hidden > 0
        ? tr(ctx, '{count} selected ({hidden} hidden by filters)', { count: selected, hidden })
        : tr(ctx, '{count} selected', { count: selected });
    ui.selectionAll.textContent = tr(ctx, 'Select all matching ({count})', { count: matchingKeys.size });
}

function mutateSelectedChats(ctx, state, ui, mutation) {
    if (!state.organizationWritable || state.selectedBatchKeys.size === 0) {
        return;
    }
    const chats = { ...state.organization.chats };
    for (const key of state.selectedBatchKeys) {
        const metadata = {
            ...(chats[key] ?? {}),
            collections: [...(chats[key]?.collections ?? [])],
            tags: [...(chats[key]?.tags ?? [])],
        };
        mutation(metadata);
        setChatMetadata(chats, key, metadata);
    }
    state.organization = { ...state.organization, chats };
    commitChatMetadataChange(ctx, state, ui);
}

function updateDeepButton(state, ui) {
    if (!state.searchAbort) {
        ui.deepButton.disabled = state.listState !== 'ready' || !ui.search.value.trim() || !!state.scanAbort;
    }
}

function updateSearchMode(ctx, state, ui) {
    const searching = !!state.searchAbort;
    const active = searching || state.deepRows !== null;
    ui.searchMode.hidden = !active;
    if (!active) {
        return;
    }
    const query = state.deepQuery || ui.search.value.trim();
    ui.searchModeText.textContent = searching
        ? tr(ctx, 'Searching all message content for "{query}"...', { query })
        : tr(ctx, 'Message content results for "{query}": {count} chats', {
            query,
            count: state.deepRows.length,
        });
    ui.searchModeClear.hidden = searching;
}

function clearViewerMatch(ui) {
    for (const match of ui.viewerContent.querySelectorAll('.sbca-msg-match')) {
        match.classList.remove('sbca-msg-match');
    }
    for (const label of ui.viewerContent.querySelectorAll('.sbca-match-label')) {
        label.remove();
    }
}

function exitDeepSearch(ctx, state, ui) {
    cancelSearch(ctx, state, ui);
    state.deepRows = null;
    state.deepQuery = '';
    clearViewerMatch(ui);
}

function cancelSearch(ctx, state, ui) {
    const controller = state.searchAbort;
    state.searchAbort = null;
    controller?.abort();
    if (controller) {
        setStatus(ui, '');
    }
    ui.status.removeAttribute('aria-busy');
    ui.deepButton.textContent = tr(ctx, 'Search message content');
}

function cancelViewer(state) {
    state.viewerAbort?.abort();
}

function cancelNavigation(state) {
    state.navigationAbort?.abort();
}

async function loadRows(ctx, state, ui) {
    if (state.scanAbort) {
        return;
    }
    if (ui.list.contains(document.activeElement)) {
        ui.listHeading.focus({ preventScroll: true });
    } else if (ui.viewerContent.contains(document.activeElement)) {
        ui.viewerTitle.focus({ preventScroll: true });
    }
    exitDeepSearch(ctx, state, ui);
    cancelViewer(state);
    cancelNavigation(state);
    state.selectedBatchKeys.clear();
    updateSelectionControls(ctx, state, ui);
    state.listAbort?.abort();
    const controller = new AbortController();
    state.listAbort = controller;
    state.listState = 'loading';
    ui.refreshButton.disabled = true;
    ui.scanButton.disabled = true;
    state.visibleLimit = LIST_PAGE_SIZE;
    renderList(ctx, state, ui);
    setStatus(ui, tr(ctx, 'Loading chats...'));
    updateDeepButton(state, ui);

    try {
        const inventory = await fetchArchiveInventory(ctx, 'archive', controller.signal);
        if (state.listAbort !== controller || state.closed) {
            return;
        }
        const nextRows = [];
        const known = new Set();
        let inventoryFailures = inventory.errors;
        for (const raw of inventory.rows) {
            const row = normalizeRow(raw, state.charactersByAvatar, state.groupsById, ctx.timestampToMoment);
            if (!row?.file_id) {
                inventoryFailures++;
                continue;
            }
            const key = physicalChatKey(row);
            if (!known.has(key)) {
                known.add(key);
                nextRows.push(row);
            }
        }
        state.rows = nextRows;
        state.inventoryFailures = inventoryFailures;
        state.selectedKey = null;
        state.selectedRow = null;
        state.selectedButton = null;
        resetViewer(ctx, ui);
        state.listState = 'ready';
        refreshOwnerOptions(ctx, state, ui);
        renderList(ctx, state, ui);
        updateBrowseStatus(ctx, state, ui);
        updateSelectionControls(ctx, state, ui);
    } catch (error) {
        controller.abort();
        if (error?.archiveCursor) {
            void releaseArchiveToken(ctx, error.archiveReadToken, error.archiveCursor);
        }
        if (error?.name === 'AbortError') {
            return;
        }
        console.error('[Chat Archive] failed to list chats:', error);
        if (state.listAbort === controller) {
            state.listState = allRows(state).length > 0 ? 'ready' : 'error';
            renderList(ctx, state, ui);
            setStatus(ui, tr(ctx, state.listState === 'ready'
                ? 'Could not refresh chats. Showing the previous results.'
                : 'Could not load chats. Try again.'));
        }
    } finally {
        if (state.listAbort === controller) {
            state.listAbort = null;
            ui.list.removeAttribute('aria-busy');
            ui.refreshButton.disabled = false;
            ui.scanButton.disabled = false;
            updateDeepButton(state, ui);
        }
    }
}

function visibleRows(state, ui) {
    const source = state.deepRows ?? allRows(state);
    const text = state.deepRows === null ? ui.search.value : '';
    const options = { ...currentSavedView(state, ui), text };
    delete options.query;
    delete options.sort;
    delete options.group;
    delete options.density;
    return sortRows(filterRows(source, options, state.organization), ui.sort.value);
}

function updateBrowseStatus(ctx, state, ui) {
    if (state.listState !== 'ready' || state.deepRows !== null) {
        return;
    }
    const total = allRows(state).length;
    const matching = state.matchingRows.length;
    const filtered = matching !== total || ui.search.value.trim();
    let text = filtered
        ? tr(ctx, '{matching} of {total} indexed chat files', { matching, total })
        : tr(ctx, '{total} indexed chat files', { total });
    if (state.inventoryFailures > 0) {
        text += ` ${tr(ctx, 'Some indexed chats could not be loaded.')}`;
    }
    if (!state.orphanScanComplete) {
        text += ` ${tr(ctx, 'Use Find orphaned files to include chats with deleted owners.')}`;
    }
    setStatus(ui, text);
}

function renderList(ctx, state, ui) {
    updateSearchMode(ctx, state, ui);
    ui.list.replaceChildren();
    state.selectedButton = null;
    if (state.listState === 'loading') {
        state.matchingRows = [];
        ui.list.setAttribute('aria-busy', 'true');
        ui.list.append(listMessage(tr(ctx, 'Loading chats...')));
        return;
    }
    if (state.listState === 'error') {
        state.matchingRows = [];
        const item = listMessage(tr(ctx, 'The chat list could not be loaded.'));
        const retry = button('sbca-control', tr(ctx, 'Try again'));
        retry.addEventListener('click', () => void loadRows(ctx, state, ui));
        item.append(retry);
        ui.list.append(item);
        return;
    }

    const rows = visibleRows(state, ui);
    state.matchingRows = rows;
    if (rows.length === 0) {
        const message = state.deepRows !== null
            ? tr(ctx, 'No chats contain that message content.')
            : allRows(state).length === 0
                ? tr(ctx, 'No chat files were found.')
                : tr(ctx, 'No chats match these filters.');
        ui.list.append(listMessage(message));
        return;
    }

    const shownRows = new Set(rows.slice(0, state.visibleLimit));
    for (const group of groupRows(rows, ui.group.value, state.organization)) {
        const shownGroupRows = group.rows.filter(row => shownRows.has(row));
        if (shownGroupRows.length === 0) {
            continue;
        }
        const collapseKey = JSON.stringify([ui.group.value, group.key]);
        const collapsed = state.collapsedGroups.has(collapseKey);
        if (ui.group.value !== 'flat') {
            const item = el('li', 'sbca-group-header');
            const heading = button('sbca-group-button', `${groupDisplayLabel(ctx, ui.group.value, group.label)} (${group.rows.length})`);
            heading.dataset.sbcaGroupKey = collapseKey;
            heading.setAttribute('aria-expanded', String(!collapsed));
            heading.addEventListener('click', () => {
                if (state.collapsedGroups.has(collapseKey)) {
                    state.collapsedGroups.delete(collapseKey);
                } else {
                    state.collapsedGroups.add(collapseKey);
                }
                renderList(ctx, state, ui);
                [...ui.list.querySelectorAll('.sbca-group-button')]
                    .find(control => control.dataset.sbcaGroupKey === collapseKey)
                    ?.focus({ preventScroll: true });
            });
            item.append(heading);
            ui.list.append(item);
        }
        if (!collapsed) {
            for (const row of shownGroupRows) {
                ui.list.append(buildRow(ctx, state, ui, row));
            }
        }
    }
    appendListMore(ctx, state, ui, rows);
}

function appendListMore(ctx, state, ui, rows) {
    if (rows.length <= state.visibleLimit) {
        return;
    }
    const remaining = rows.length - state.visibleLimit;
    const item = el('li', 'sbca-list-more');
    const more = button('sbca-control', tr(ctx, 'Show {count} more', { count: Math.min(LIST_PAGE_SIZE, remaining) }));
    more.addEventListener('click', () => {
        const firstNewRow = state.visibleLimit;
        state.visibleLimit += LIST_PAGE_SIZE;
        if (ui.group.value !== 'flat') {
            const newKeys = new Set(rows.slice(firstNewRow, state.visibleLimit).map(physicalChatKey));
            renderList(ctx, state, ui);
            ([...ui.list.querySelectorAll('.sbca-row-button')]
                .find(control => newKeys.has(control.dataset.sbcaKey)) ?? ui.list.querySelector('.sbca-list-more .sbca-control'))
                ?.focus({ preventScroll: true });
            return;
        }
        item.remove();
        const fragment = document.createDocumentFragment();
        let firstButton = null;
        for (const row of rows.slice(firstNewRow, state.visibleLimit)) {
            const rowItem = buildRow(ctx, state, ui, row);
            firstButton ??= rowItem.querySelector('.sbca-row-button');
            fragment.append(rowItem);
        }
        ui.list.append(fragment);
        appendListMore(ctx, state, ui, rows);
        (firstButton ?? ui.list.querySelector('.sbca-list-more .sbca-control'))?.focus({ preventScroll: true });
    });
    item.append(more);
    ui.list.append(item);
}

function groupDisplayLabel(ctx, mode, label) {
    if (mode === 'type') {
        return tr(ctx, Object.fromEntries(KINDS)[label] ?? label);
    }
    if (mode === 'folder' && label === 'Unfiled') {
        return tr(ctx, 'Unfiled');
    }
    return label || tr(ctx, 'Unknown owner');
}

function listMessage(text) {
    const item = el('li', 'sbca-list-message');
    item.append(el('p', 'sbca-placeholder', text));
    return item;
}

function buildRow(ctx, state, ui, row) {
    const item = el('li', 'sbca-row');
    const block = button('sbca-row-button');
    const key = physicalChatKey(row);
    block.dataset.sbcaKind = row.kind;
    block.dataset.sbcaKey = key;
    if (state.selectedKey === key) {
        block.setAttribute('aria-current', 'true');
        state.selectedButton = block;
    }

    const head = el('span', 'sbca-row-head');
    if (row.kind === 'solo') {
        const img = document.createElement('img');
        img.className = 'sbca-avatar';
        img.src = ctx.getThumbnailUrl('avatar', row.avatar);
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        head.append(img);
    } else {
        const icon = el('i', `sbca-avatar-icon fa-solid ${row.kind === 'group' ? 'fa-users' : 'fa-triangle-exclamation'}`);
        icon.setAttribute('aria-hidden', 'true');
        head.append(icon);
    }

    const title = el('span', 'sbca-row-title');
    title.append(el('span', 'sbca-filename', row.file_id));
    const owner = el('span', 'sbca-owner', ownerLabel(ctx, row));
    if (row.kind === 'orphan') {
        owner.append(el('span', 'sbca-badge', orphanLabel(ctx, row.orphanType)));
    }
    title.append(owner);
    head.append(title);

    const info = el('span', 'sbca-row-info');
    if (row.mtime) {
        const date = new Date(row.mtime);
        if (!Number.isNaN(date.valueOf())) {
            const time = el('time', undefined, date.toLocaleDateString());
            time.dateTime = date.toISOString();
            info.append(time);
        }
    }
    if (row.sizeText) {
        info.append(el('span', undefined, row.sizeText));
    }
    if (row.count !== null) {
        info.append(el('span', undefined, messageCount(ctx, row.count)));
    }
    head.append(info);
    block.append(head);
    const metadata = state.organization?.chats?.[key];
    if (metadata) {
        const indicators = el('span', 'sbca-curation-indicators');
        if (metadata.favorite) {
            indicators.append(el('span', 'sbca-curation-favorite', tr(ctx, 'Favorite')));
        }
        const folder = state.organization.folders.find(item => item.id === metadata.folder);
        if (folder) {
            indicators.append(el('span', 'sbca-curation-folder', tr(ctx, 'Folder: {name}', { name: folder.name })));
        }
        for (const id of metadata.collections ?? []) {
            const collection = state.organization.collections.find(item => item.id === id);
            if (collection) {
                indicators.append(el('span', 'sbca-curation-collection', tr(ctx, 'Collection: {name}', { name: collection.name })));
            }
        }
        for (const tag of metadata.tags ?? []) {
            indicators.append(el('span', 'sbca-curation-tag', tr(ctx, 'Tag: {name}', { name: tag })));
        }
        if (indicators.childElementCount > 0) {
            block.append(indicators);
        }
    }
    if (row.snippet) {
        const snippet = row.snippet.length > 180 ? `${row.snippet.slice(0, 177)}...` : row.snippet;
        block.append(el('span', 'sbca-row-preview', snippet));
    }
    block.addEventListener('click', () => {
        cancelNavigation(state);
        selectRow(state, ui, block, key);
        state.selectedRow = row;
        void openViewer(ctx, state, row, ui);
    });
    if (state.selectionMode) {
        const selectLabel = el('label', 'sbca-row-selection');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = state.selectedBatchKeys.has(key);
        checkbox.setAttribute('aria-label', tr(ctx, 'Select {name} for {owner}', {
            name: row.file_id,
            owner: ownerLabel(ctx, row),
        }));
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                state.selectedBatchKeys.add(key);
            } else {
                state.selectedBatchKeys.delete(key);
            }
            updateSelectionControls(ctx, state, ui);
        });
        selectLabel.append(checkbox);
        item.append(selectLabel);
    }
    item.append(block);
    return item;
}

function orphanLabel(ctx, type) {
    const labels = {
        'missing-character': 'Missing character',
        'missing-group': 'Missing group',
        'unlinked-group': 'Unlinked group',
        root: 'Root file',
    };
    return tr(ctx, labels[type] ?? 'Orphaned');
}

function ownerLabel(ctx, row) {
    if (row.ownerName) {
        return row.ownerName;
    }
    return row.orphanType === 'unlinked-group' ? tr(ctx, 'Unlinked group') : tr(ctx, 'Unknown owner');
}

function messageCount(ctx, count) {
    return tr(ctx, count === 1 ? '{count} message' : '{count} messages', { count });
}

function selectRow(state, ui, block, key) {
    ui.list.querySelectorAll('.sbca-row-button[aria-current="true"]').forEach(row => row.removeAttribute('aria-current'));
    block.setAttribute('aria-current', 'true');
    state.selectedKey = key;
    state.selectedButton = block;
}

function showList(state, ui) {
    ui.root.dataset.sbcaView = 'list';
    const target = state.selectedButton?.isConnected ? state.selectedButton : ui.search;
    target.focus({ preventScroll: true });
}

function showDetail(ui) {
    ui.root.dataset.sbcaView = 'detail';
    if (ui.mobileQuery.matches) {
        ui.viewerTitle.focus({ preventScroll: true });
    }
}

function resetViewer(ctx, ui) {
    ui.root.dataset.sbcaView = 'list';
    ui.viewerTitle.textContent = tr(ctx, 'Chat details');
    ui.viewerContent.replaceChildren(el('p', 'sbca-placeholder', tr(ctx, 'Select a chat to inspect it.')));
    ui.viewer.removeAttribute('aria-busy');
}

async function openViewer(ctx, state, row, ui) {
    if (ui.viewerContent.contains(document.activeElement)) {
        ui.viewerTitle.focus({ preventScroll: true });
    }
    cancelViewer(state);
    const controller = new AbortController();
    state.viewerAbort = controller;
    state.selectedRow = row;
    ui.viewerTitle.textContent = row.file_id;
    ui.viewerContent.replaceChildren(
        buildChatOrganizer(ctx, state, row, ui),
        buildSummary(ctx, row),
        el('p', 'sbca-placeholder', tr(ctx, 'Loading chat...')),
    );
    ui.viewer.setAttribute('aria-busy', 'true');
    showDetail(ui);

    try {
        const raw = await loadRawChat(ctx, state, row, controller.signal);
        if (state.viewerAbort !== controller || state.closed) {
            return;
        }
        let shaped;
        try {
            shaped = await parseChatJsonl(raw, { signal: controller.signal });
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw error;
            }
            if (state.viewerAbort !== controller || state.closed) {
                return;
            }
            console.warn('[Chat Archive] chat is readable but contains invalid JSONL:', error);
            renderMalformedViewer(ctx, state, row, raw, ui);
            if (!state.searchAbort && state.deepRows === null) {
                setStatus(ui, tr(ctx, 'Opened raw file for {name}; message parsing failed.', { name: row.file_id }));
            }
            return;
        }
        if (state.viewerAbort !== controller || state.closed) {
            return;
        }
        renderViewer(ctx, state, row, raw, shaped, ui);
        if (!state.searchAbort && state.deepRows === null) {
            setStatus(ui, tr(ctx, 'Opened {name}', { name: row.file_id }));
        }
    } catch (error) {
        if (error?.name === 'AbortError') {
            return;
        }
        console.error('[Chat Archive] failed to load chat:', error);
        if (state.viewerAbort === controller) {
            const errorMessage = el('div', 'sbca-viewer-error', tr(ctx, 'Could not read this chat. Refresh the archive or scan for orphaned files again.'));
            errorMessage.setAttribute('role', 'alert');
            const retry = button('sbca-control', tr(ctx, 'Try again'));
            retry.addEventListener('click', () => void openViewer(ctx, state, row, ui));
            ui.viewerContent.replaceChildren(buildChatOrganizer(ctx, state, row, ui), buildSummary(ctx, row), errorMessage, retry);
            if (!state.searchAbort && state.deepRows === null) {
                setStatus(ui, tr(ctx, 'Could not open {name}', { name: row.file_id }));
            }
        }
    } finally {
        if (state.viewerAbort === controller) {
            state.viewerAbort = null;
            ui.viewer.removeAttribute('aria-busy');
        }
    }
}

function buildChatOrganizer(ctx, state, row, ui) {
    const organizer = el('section', 'sbca-organizer');
    organizer.append(el('h5', 'sbca-organizer-heading', tr(ctx, 'Organize chat')));
    const key = physicalChatKey(row);
    const tagInputKey = organizationFocusKey('organizer', key, 'tag-input');
    const metadata = state.organization?.chats?.[key] ?? {};
    const favorite = button('sbca-control sbca-favorite-toggle', tr(ctx, metadata.favorite ? 'Unfavorite' : 'Favorite'));
    favorite.setAttribute('aria-pressed', String(metadata.favorite === true));
    markOrganizationControl(favorite, organizationFocusKey('organizer', key, 'favorite'));
    favorite.addEventListener('click', () => mutateChatMetadata(ctx, state, ui, row, value => {
        if (value.favorite) {
            delete value.favorite;
        } else {
            value.favorite = true;
        }
    }));

    const folderField = selectControl(ctx, 'Folder', [['', 'Unfiled']]);
    for (const folder of state.organization?.folders ?? []) {
        appendOption(folderField.select, folder.id, folder.name);
    }
    folderField.select.value = metadata.folder ?? '';
    markOrganizationControl(folderField.select, organizationFocusKey('organizer', key, 'folder'));
    folderField.select.addEventListener('change', () => mutateChatMetadata(ctx, state, ui, row, value => {
        if (folderField.select.value) {
            value.folder = folderField.select.value;
        } else {
            delete value.folder;
        }
    }));

    const collections = el('fieldset', 'sbca-organizer-collections');
    collections.append(el('legend', undefined, tr(ctx, 'Collections')));
    const selectedCollections = new Set(metadata.collections ?? []);
    if ((state.organization?.collections.length ?? 0) === 0) {
        collections.append(el('p', 'sbca-placeholder', tr(ctx, 'No collections yet.')));
    }
    for (const collection of state.organization?.collections ?? []) {
        const label = el('label', 'checkbox_label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selectedCollections.has(collection.id);
        markOrganizationControl(checkbox, organizationFocusKey('organizer', key, 'collection', collection.id));
        checkbox.addEventListener('change', () => mutateChatMetadata(ctx, state, ui, row, value => {
            const ids = new Set(value.collections ?? []);
            if (checkbox.checked) {
                ids.add(collection.id);
            } else {
                ids.delete(collection.id);
            }
            value.collections = [...ids];
        }));
        label.append(checkbox, document.createTextNode(collection.name));
        collections.append(label);
    }

    const tags = el('div', 'sbca-organizer-tags');
    tags.append(el('span', 'sbca-label', tr(ctx, 'Tags')));
    const tagList = el('div', 'sbca-tag-list');
    for (const tag of metadata.tags ?? []) {
        const item = el('span', 'sbca-tag-item');
        const remove = button('sbca-control sbca-tag-remove', tr(ctx, 'Remove'));
        remove.setAttribute('aria-label', tr(ctx, 'Remove tag {name}', { name: tag }));
        markOrganizationControl(remove, organizationFocusKey('organizer', key, 'tag', tag), tagInputKey);
        remove.addEventListener('click', () => mutateChatMetadata(ctx, state, ui, row, value => {
            value.tags = (value.tags ?? []).filter(name => name.toLocaleLowerCase() !== tag.toLocaleLowerCase());
        }));
        item.append(el('span', undefined, tag), remove);
        tagList.append(item);
    }
    const tagCreate = el('div', 'sbca-tag-create');
    const tagField = inputControl(ctx, 'Add tags (comma-separated)');
    const tagAdd = button('sbca-control', tr(ctx, 'Add tags'));
    markOrganizationControl(tagField.input, tagInputKey);
    markOrganizationControl(tagAdd, organizationFocusKey('organizer', key, 'tag-add'), tagInputKey);
    const addTags = () => {
        const values = commaValues(tagField.input.value);
        if (values.length > 0) {
            mutateChatMetadata(ctx, state, ui, row, metadataValue => {
                metadataValue.tags = [...(metadataValue.tags ?? []), ...values];
            });
        }
    };
    tagAdd.addEventListener('click', addTags);
    tagField.input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            addTags();
        }
    });
    tagCreate.append(tagField.wrap, tagAdd);
    tags.append(tagList, tagCreate);
    organizer.append(favorite, folderField.wrap, collections, tags);
    for (const control of organizer.querySelectorAll('[data-sbca-organization-control]')) {
        control.disabled = !state.organizationWritable;
    }
    return organizer;
}

function mutateChatMetadata(ctx, state, ui, row, mutation) {
    if (!state.organizationWritable || !state.organization) {
        return;
    }
    const key = physicalChatKey(row);
    const chats = { ...state.organization.chats };
    const metadata = {
        ...(chats[key] ?? {}),
        collections: [...(chats[key]?.collections ?? [])],
        tags: [...(chats[key]?.tags ?? [])],
    };
    mutation(metadata);
    setChatMetadata(chats, key, metadata);
    state.organization = { ...state.organization, chats };
    commitChatMetadataChange(ctx, state, ui);
}

function setChatMetadata(chats, key, value) {
    const metadata = {};
    if (value.favorite === true) {
        metadata.favorite = true;
    }
    if (typeof value.folder === 'string' && value.folder) {
        metadata.folder = value.folder;
    }
    const collections = [...new Set(value.collections ?? [])].filter(Boolean);
    if (collections.length > 0) {
        metadata.collections = collections;
    }
    const tags = [];
    const seenTags = new Set();
    for (const raw of value.tags ?? []) {
        const tag = String(raw).trim();
        const folded = tag.toLocaleLowerCase();
        if (tag && !seenTags.has(folded)) {
            seenTags.add(folded);
            tags.push(tag);
        }
    }
    if (tags.length > 0) {
        metadata.tags = tags;
    }
    if (Object.keys(metadata).length > 0) {
        chats[key] = metadata;
    } else {
        delete chats[key];
    }
}

function refreshOpenOrganizer(ctx, state, ui) {
    if (!state.selectedRow) {
        return;
    }
    const current = ui.viewerContent.querySelector('.sbca-organizer');
    if (current) {
        current.replaceWith(buildChatOrganizer(ctx, state, state.selectedRow, ui));
    }
}

async function loadRawChat(ctx, state, row, signal) {
    if (row.source === 'archive-orphan') {
        if (!state.archiveReadToken || !row.archiveHash) {
            throw new Error('Orphan scan expired');
        }
        return fetchArchiveFile(ctx, state.archiveReadToken, row.archiveHash, signal);
    }

    const isGroup = row.kind === 'group' || row.orphanType === 'missing-group';
    // ponytail: the host maps ".png" to the chats root; use an explicit root API when one exists.
    const avatarUrl = row.orphanType === 'root' ? '.png' : row.avatar;
    const data = await exportChat(ctx, {
        is_group: isGroup,
        avatar_url: avatarUrl ?? undefined,
        file: row.file_name || `${row.file_id}.jsonl`,
        exportfilename: row.file_name || `${row.file_id}.jsonl`,
        format: 'jsonl',
    }, signal);
    if (typeof data?.result !== 'string') {
        throw new Error('Chat export did not return file data');
    }
    return data.result;
}

function buildSummary(ctx, row) {
    const summary = el('div', 'sbca-summary');
    summary.append(el('div', 'sbca-summary-line', ownerLabel(ctx, row)));
    const facts = [];
    if (row.count !== null) {
        facts.push(messageCount(ctx, row.count));
    }
    if (row.sizeText) {
        facts.push(row.sizeText);
    }
    if (facts.length > 0) {
        summary.append(el('div', 'sbca-summary-line', facts.join(' | ')));
    }
    if (row.mtime) {
        const label = row.source === 'archive-orphan' ? tr(ctx, 'Modified') : tr(ctx, 'Last message');
        summary.append(el('div', 'sbca-summary-line', `${label}: ${new Date(row.mtime).toLocaleString()}`));
    }
    return summary;
}

function renderViewer(ctx, state, row, raw, shaped, ui) {
    const matchIndex = state.deepRows === null ? -1 : findMatchingMessageIndex(shaped.messages, state.deepQuery);
    const matchQuery = state.deepQuery;
    const start = matchIndex < 0 ? 0 : Math.floor(matchIndex / MESSAGE_PAGE_SIZE) * MESSAGE_PAGE_SIZE;
    const messages = el('div', 'sbca-messages');
    messages.id = `sbca_messages_${++renderId}`;
    const messageList = el('div', 'sbca-message-list');
    messageList.setAttribute('role', 'list');
    messageList.setAttribute('aria-label', tr(ctx, 'Chat messages'));
    const showPage = pageStart => {
        messages.replaceChildren();
        messageList.replaceChildren();
        if (pageStart > 0) {
            const earlier = button('sbca-control sbca-more-messages', tr(ctx, 'Show {count} earlier messages', {
                count: Math.min(MESSAGE_PAGE_SIZE, pageStart),
            }));
            earlier.addEventListener('click', () => showPage(Math.max(0, pageStart - MESSAGE_PAGE_SIZE))?.focus({ preventScroll: true }));
            messages.append(earlier);
        }
        messages.append(messageList);
        const getMatchIndex = () => state.deepRows !== null && state.deepQuery === matchQuery ? matchIndex : -1;
        return appendMessagePage(ctx, shaped.messages, messageList, messages, pageStart, getMatchIndex, showPage);
    };
    const showLatest = shaped.messages.length > MESSAGE_PAGE_SIZE ? () => {
        const latest = showPage(shaped.messages.length - MESSAGE_PAGE_SIZE);
        latest?.focus({ preventScroll: true });
        latest?.scrollIntoView({ block: 'start' });
    } : null;
    const content = [
        buildChatOrganizer(ctx, state, row, ui),
        buildSummary(ctx, row),
        buildViewerActions(ctx, state, row, raw, true, showLatest),
    ];
    const metadata = shaped.header?.chat_metadata;
    if (metadata && Object.keys(metadata).length > 0) {
        content.push(jsonDetails(ctx, 'Chat metadata', metadata));
    }

    if (shaped.messages.length === 0) {
        messages.append(messageList, el('p', 'sbca-placeholder', tr(ctx, 'This chat is empty.')));
    } else {
        showPage(start);
    }

    const rawView = el('pre', 'sbca-raw');
    rawView.id = `sbca_raw_${renderId}`;
    rawView.hidden = true;
    const rawToggle = buildRawToggle(ctx, raw, rawView, messages);

    content.push(rawToggle, messages, rawView);
    ui.viewerContent.replaceChildren(...content);
    const match = messages.querySelector('.sbca-msg-match');
    match?.focus({ preventScroll: true });
    match?.scrollIntoView({ block: 'center' });
}

function buildViewerActions(ctx, state, row, raw, allowText, showLatest = null) {
    const actions = el('div', 'sbca-viewer-actions');
    if (showLatest) {
        const latestButton = actionButton(ctx, 'Latest messages', 'fa-angles-down');
        latestButton.addEventListener('click', showLatest);
        actions.append(latestButton);
    }
    const jsonlButton = actionButton(ctx, 'Download original (.jsonl)', 'fa-file-export');
    jsonlButton.addEventListener('click', () => downloadChat(ctx, row, raw, 'jsonl', jsonlButton));
    actions.append(jsonlButton);
    if (allowText) {
        const textButton = actionButton(ctx, 'Download readable text', 'fa-file-lines');
        textButton.addEventListener('click', () => downloadChat(ctx, row, raw, 'txt', textButton));
        actions.append(textButton);
    }
    if (row.kind !== 'orphan') {
        const jumpButton = actionButton(ctx, 'Open chat', 'fa-arrow-right-to-bracket');
        if (state.navigationPending) {
            jumpButton.setAttribute('aria-disabled', 'true');
            state.navigationControl = jumpButton;
        }
        jumpButton.addEventListener('click', () => void jumpToChat(ctx, state, row, jumpButton));
        actions.append(jumpButton);
    }
    return actions;
}

function renderMalformedViewer(ctx, state, row, raw, ui) {
    const warning = el('div', 'sbca-viewer-error', tr(ctx, 'This file contains invalid JSONL. You can still download or inspect the original file.'));
    warning.setAttribute('role', 'alert');
    const rawView = el('pre', 'sbca-raw');
    rawView.id = `sbca_raw_${++renderId}`;
    rawView.hidden = true;
    ui.viewerContent.replaceChildren(
        buildChatOrganizer(ctx, state, row, ui),
        buildSummary(ctx, row),
        buildViewerActions(ctx, state, row, raw, false),
        warning,
        buildRawToggle(ctx, raw, rawView),
        rawView,
    );
}

function buildRawToggle(ctx, raw, rawView, messages = null) {
    const control = button('sbca-control sbca-raw-toggle', tr(ctx, 'Show raw file'));
    control.setAttribute('aria-expanded', 'false');
    control.setAttribute('aria-controls', rawView.id);
    control.addEventListener('click', () => {
        const showRaw = rawView.hidden;
        if (showRaw && !rawView.dataset.loaded) {
            rawView.textContent = raw.length > RAW_PREVIEW_CHARS
                ? `${raw.slice(0, RAW_PREVIEW_CHARS)}\n\n${tr(ctx, 'Raw preview truncated. Download the original file to inspect the rest.')}`
                : raw;
            rawView.dataset.loaded = 'true';
        }
        rawView.hidden = !showRaw;
        if (messages) {
            messages.hidden = showRaw;
        }
        control.setAttribute('aria-expanded', String(showRaw));
        control.textContent = tr(ctx, showRaw && messages ? 'Show messages' : showRaw ? 'Hide raw file' : 'Show raw file');
    });
    return control;
}

function appendMessagePage(ctx, messages, list, controls, start, getMatchIndex, showPage) {
    const end = Math.min(start + MESSAGE_PAGE_SIZE, messages.length);
    const matchIndex = getMatchIndex();
    let firstCard = null;
    for (let index = start; index < end; index += 1) {
        const card = buildMessage(ctx, messages[index]);
        if (index === matchIndex) {
            card.classList.add('sbca-msg-match');
            card.querySelector('.sbca-msg-head')?.append(el('span', 'sbca-match-label', tr(ctx, 'First search match')));
        }
        firstCard ??= card;
        list.append(card);
    }
    if (end < messages.length) {
        const more = button('sbca-control sbca-more-messages', tr(ctx, 'Show {count} more messages', {
            count: Math.min(MESSAGE_PAGE_SIZE, messages.length - end),
        }));
        more.addEventListener('click', () => {
            showPage(end)?.focus({ preventScroll: true });
        });
        controls.append(more);
    }
    return firstCard;
}

function buildMessage(ctx, message) {
    const role = message.isSystem ? 'system' : message.isUser ? 'user' : 'assistant';
    const roleLabels = { system: 'System', user: 'You', assistant: 'Assistant' };
    const card = el('article', 'sbca-msg');
    card.dataset.sbcaRole = role;
    card.setAttribute('role', 'listitem');
    card.tabIndex = -1;
    const head = el('header', 'sbca-msg-head');
    const roleLabel = tr(ctx, roleLabels[role]);
    const displayName = message.name || roleLabel;
    head.append(el('strong', undefined, displayName));
    if (displayName.toLocaleLowerCase() !== roleLabel.toLocaleLowerCase()) {
        head.append(el('span', 'sbca-role', roleLabel));
    }
    if (message.send_date) {
        const time = el('time', undefined, formatSendDate(ctx, message.send_date));
        const parsed = new Date(message.send_date);
        if (!Number.isNaN(parsed.valueOf())) {
            time.dateTime = parsed.toISOString();
        }
        head.append(time);
    }
    if (message.swipeCount > 0) {
        head.append(el('span', 'sbca-chip', tr(ctx, message.swipeCount === 1
            ? '{count} response alternative'
            : '{count} response alternatives', { count: message.swipeCount })));
    }
    card.append(head, el('div', 'sbca-msg-text', message.mes));
    if (message.alternatives.length > 0) {
        card.append(jsonDetails(ctx, 'Response alternatives', message.alternatives));
    }
    if (message.extra && Object.keys(message.extra).length > 0) {
        card.append(jsonDetails(ctx, 'Extension data', message.extra));
    }
    return card;
}

function jsonDetails(ctx, label, value) {
    const details = el('details', 'sbca-json-details');
    details.append(el('summary', undefined, tr(ctx, label)));
    let rendered = false;
    details.addEventListener('toggle', () => {
        if (details.open && !rendered) {
            details.append(el('pre', undefined, JSON.stringify(value, null, 2)));
            rendered = true;
        }
    });
    return details;
}

function formatSendDate(ctx, sendDate) {
    if (!sendDate) {
        return '';
    }
    try {
        const moment = ctx.timestampToMoment(sendDate);
        if (moment?.isValid?.()) {
            return moment.format('lll');
        }
    } catch {
        // Fall through to the raw value.
    }
    return String(sendDate);
}

async function scanOrphans(ctx, state, ui) {
    if (state.scanAbort || state.listAbort) {
        return;
    }
    exitDeepSearch(ctx, state, ui);
    cancelViewer(state);
    cancelNavigation(state);
    const controller = new AbortController();
    state.scanAbort = controller;
    ui.refreshButton.disabled = true;
    ui.scanButton.disabled = false;
    ui.scanButton.removeAttribute('aria-disabled');
    ui.scanButton.textContent = tr(ctx, 'Stop scan');
    setStatus(ui, tr(ctx, 'Scanning for missing-character and unlinked-group chats...'));
    updateDeepButton(state, ui);

    try {
        const inventory = await fetchArchiveInventory(ctx, 'orphans', controller.signal);
        if (controller.signal.aborted || state.scanAbort !== controller || state.closed) {
            void releaseArchiveToken(ctx, inventory.readToken);
            if (!state.closed && state.scanAbort === controller) {
                setStatus(ui, tr(ctx, state.orphanScanComplete
                    ? 'Scan stopped. Previous results are still shown.'
                    : 'Scan stopped.'));
            }
            return;
        }
        const orphanRows = [];
        let invalidRecords = inventory.errors;
        for (const raw of inventory.rows) {
            const row = normalizeRow(raw, state.charactersByAvatar, state.groupsById, ctx.timestampToMoment);
            if (!row?.file_id || !row.archiveHash || row.kind !== 'orphan') {
                invalidRecords++;
                continue;
            }
            orphanRows.push(row);
        }
        const previousToken = state.archiveReadToken;
        state.archiveReadToken = inventory.readToken;
        state.orphanRows = orphanRows;
        state.orphanScanComplete = true;
        state.selectedKey = null;
        state.selectedRow = null;
        state.selectedButton = null;
        state.selectedBatchKeys.clear();
        state.visibleLimit = LIST_PAGE_SIZE;
        resetViewer(ctx, ui);
        refreshOwnerOptions(ctx, state, ui);
        renderList(ctx, state, ui);
        updateSelectionControls(ctx, state, ui);
        setStatus(ui, state.orphanRows.length > 0
            ? tr(ctx, 'Found {count} additional orphaned chat files.', { count: state.orphanRows.length })
            : tr(ctx, 'No additional orphaned chat files were found.'));
        if (invalidRecords > 0) {
            setStatus(ui, `${ui.status.textContent} ${tr(ctx, 'Some orphan records could not be read.')}`);
        }
        void releaseArchiveToken(ctx, previousToken);
    } catch (error) {
        if (error?.archiveReadToken || error?.archiveCursor) {
            void releaseArchiveToken(ctx, error.archiveReadToken, error.archiveCursor);
        }
        if (!state.closed && state.scanAbort === controller) {
            if (error?.name === 'AbortError') {
                setStatus(ui, tr(ctx, state.orphanScanComplete
                    ? 'Scan stopped. Previous results are still shown.'
                    : 'Scan stopped.'));
            } else {
                console.error('[Chat Archive] orphan scan failed:', error);
                setStatus(ui, tr(ctx, state.orphanScanComplete
                    ? 'Could not rescan orphaned files. Previous results are still shown.'
                    : 'Could not scan for additional orphaned files. Try again.'));
            }
        }
    } finally {
        if (state.scanAbort === controller) {
            state.scanAbort = null;
            if (!state.closed) {
                ui.refreshButton.disabled = false;
                ui.scanButton.disabled = false;
                ui.scanButton.removeAttribute('aria-disabled');
                ui.scanButton.textContent = tr(ctx, state.orphanScanComplete
                    ? 'Rescan orphaned files'
                    : 'Find orphaned files');
            }
            updateDeepButton(state, ui);
        }
    }
}

async function releaseArchiveToken(ctx, token, cursor = null) {
    if (!token && !cursor) {
        return;
    }
    try {
        await releaseArchiveSession(ctx, { token, cursor });
    } catch (error) {
        console.warn('[Chat Archive] orphan scan token already expired:', error);
    }
}

async function releaseArchiveReadSession(ctx, state) {
    const token = state.archiveReadToken;
    state.archiveReadToken = null;
    await releaseArchiveToken(ctx, token);
}

async function runDeepSearch(ctx, state, ui) {
    const query = ui.search.value.trim();
    if (!query) {
        globalThis.toastr?.warning(tr(ctx, 'Enter a filter before searching message content.'));
        return;
    }

    const controller = new AbortController();
    state.searchAbort = controller;
    state.deepRows = null;
    state.deepQuery = query;
    clearViewerMatch(ui);
    const { signal } = controller;
    ui.deepButton.disabled = false;
    ui.deepButton.textContent = tr(ctx, 'Stop search');
    ui.status.setAttribute('aria-busy', 'true');
    renderList(ctx, state, ui);

    const scopes = buildSearchScopes(ctx.characters, ctx.groups, ui.owner.value);
    const localFiles = filterRows(
        allRows(state).filter(row => row.kind === 'orphan'),
        { owner: ui.owner.value },
    );
    const total = scopes.length + localFiles.length;
    const found = new Map();
    let completed = 0;
    let errors = 0;

    try {
        for (const scope of scopes) {
            if (signal.aborted) {
                break;
            }
            setStatus(ui, tr(ctx, 'Searching source {current} of {total}...', { current: completed + 1, total }));
            try {
                const results = await searchScope(ctx, query, scope, signal);
                let malformed = false;
                for (const result of results) {
                    const recent = deepResultToRecentRow(result, scope);
                    const row = normalizeRow(recent, state.charactersByAvatar, state.groupsById, ctx.timestampToMoment);
                    if (!row?.file_id) {
                        malformed = true;
                        continue;
                    }
                    if (found.has(physicalChatKey(row))) {
                        continue;
                    }
                    try {
                        const raw = await loadRawChat(ctx, state, row, signal);
                        const { snippet, invalidLines } = await findMatchingSnippetInJsonlAsync(raw, query, { signal });
                        if (invalidLines > 0) {
                            errors++;
                        }
                        if (snippet !== null) {
                            found.set(physicalChatKey(row), { ...row, snippet, matchSnippet: true });
                        }
                    } catch (error) {
                        if (error?.name === 'AbortError') {
                            throw error;
                        }
                        errors++;
                        console.warn('[Chat Archive] search result verification failed:', error);
                    }
                }
                if (malformed) {
                    errors++;
                }
            } catch (error) {
                if (error?.name === 'AbortError') {
                    break;
                }
                errors++;
                console.warn('[Chat Archive] search scope failed:', error);
            }
            completed++;
        }

        for (const row of localFiles) {
            if (signal.aborted) {
                break;
            }
            if (found.has(physicalChatKey(row))) {
                completed++;
                continue;
            }
            setStatus(ui, tr(ctx, 'Searching source {current} of {total}...', { current: completed + 1, total }));
            try {
                const raw = await loadRawChat(ctx, state, row, signal);
                const { snippet, invalidLines } = await findMatchingSnippetInJsonlAsync(raw, query, { signal });
                if (invalidLines > 0) {
                    errors++;
                }
                if (snippet !== null) {
                    found.set(physicalChatKey(row), { ...row, snippet, matchSnippet: true });
                }
            } catch (error) {
                if (error?.name === 'AbortError') {
                    break;
                }
                errors++;
                console.warn('[Chat Archive] local file search failed:', error);
            }
            completed++;
        }

        if (state.searchAbort !== controller || state.closed) {
            return;
        }
        state.deepRows = [...found.values()];
        state.visibleLimit = LIST_PAGE_SIZE;
        renderList(ctx, state, ui);
        if (signal.aborted) {
            setStatus(ui, tr(ctx, 'Search stopped after {completed} of {total} sources. {count} matching chats shown.', {
                completed,
                total,
                count: found.size,
            }));
        } else if (errors > 0) {
            setStatus(ui, tr(ctx, '{count} matching chats. {errors} search items had errors.', { count: found.size, errors }));
        } else {
            setStatus(ui, tr(ctx, '{count} matching chats for "{query}".', { count: found.size, query }));
        }
    } finally {
        if (state.searchAbort === controller) {
            state.searchAbort = null;
            ui.status.removeAttribute('aria-busy');
            ui.deepButton.textContent = tr(ctx, 'Search message content');
            updateDeepButton(state, ui);
            updateSearchMode(ctx, state, ui);
        }
    }
}

export function navigateAndConfirm(ctx, fileId, action, { signal, timeout = NAVIGATION_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        let changed = false;
        let settled = false;
        let abortReason = null;
        let timer;
        const controller = new AbortController();
        const cleanup = () => {
            clearTimeout(timer);
            ctx.eventSource.removeListener(ctx.eventTypes.CHAT_CHANGED, onChanged);
            signal?.removeEventListener('abort', onExternalAbort);
            controller.signal.removeEventListener('abort', onAbort);
        };
        const finish = (failed, error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            if (failed) {
                reject(error);
            } else if (changed || String(ctx.getCurrentChatId?.() ?? '') === String(fileId)) {
                resolve();
            } else {
                reject(new Error('Host did not confirm the requested chat'));
            }
        };
        const onChanged = chatId => {
            if (String(chatId) === String(fileId)) {
                changed = true;
            }
        };
        const onAbort = () => {
            abortReason = controller.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
            finish(true, abortReason);
        };
        const onExternalAbort = () => controller.abort(signal.reason);
        ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, onChanged);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        signal?.addEventListener('abort', onExternalAbort, { once: true });
        if (signal?.aborted) {
            controller.abort(signal.reason);
            return;
        }
        timer = setTimeout(() => controller.abort(new DOMException('Host navigation timed out.', 'TimeoutError')), timeout);
        Promise.resolve()
            .then(() => abortReason ? undefined : action(controller.signal))
            .then(() => {
                finish(!!abortReason, abortReason);
            }, error => {
                finish(true, abortReason ?? error);
            });
    });
}

async function restorePreviousChat(ctx, host, groupChats, previous) {
    try {
        if (previous.groupId != null) {
            if (await groupChats.openGroupById(previous.groupId)) {
                if (previous.chatId) {
                    await ctx.openGroupChat(previous.groupId, previous.chatId);
                }
                host.setActiveGroup(previous.groupId);
            }
        } else {
            const characterIndex = Number(previous.characterIndex);
            if (Number.isInteger(characterIndex) && characterIndex >= 0) {
                if (await ctx.selectCharacterById(characterIndex)) {
                    if (previous.chatId) {
                        await ctx.openCharacterChat(previous.chatId);
                    }
                    host.setActiveCharacter(ctx.characters[characterIndex]?.avatar);
                }
            } else if (groupChats.selected_group != null || (Number.isInteger(Number(host.this_chid)) && Number(host.this_chid) >= 0)) {
                await ctx.closeCurrentChat();
            }
        }
        ctx.saveSettingsDebounced();
    } catch (error) {
        console.warn('[Chat Archive] could not restore the previous chat after navigation failed:', error);
    }
}

async function jumpToChat(ctx, state, row, control) {
    if (state.navigationPending || state.closed || hostNavigationPending) {
        return;
    }
    const controller = new AbortController();
    state.navigationPending = true;
    hostNavigationPending = controller;
    state.navigationAbort = controller;
    state.navigationControl = control;
    const copy = control.querySelector('.sbca-button-copy');
    const original = copy.textContent;
    control.setAttribute('aria-disabled', 'true');
    copy.textContent = tr(ctx, 'Opening...');
    let host;
    let groupChats;
    let previous;
    let navigationStarted = false;
    let navigationConfirmed = false;
    let navigationFinished = false;
    let hostActionRunning = false;
    const releaseHostNavigation = () => {
        if (navigationFinished && !hostActionRunning && hostNavigationPending === controller) {
            hostNavigationPending = null;
        }
    };
    const runHostAction = async action => {
        hostActionRunning = true;
        try {
            return await action();
        } finally {
            hostActionRunning = false;
            releaseHostNavigation();
        }
    };
    try {
        [host, groupChats] = await Promise.all([
            import('../../../../script.js'),
            import('../../../group-chats.js'),
        ]);
        controller.signal.throwIfAborted();
        previous = {
            groupId: groupChats.selected_group,
            characterIndex: host.this_chid,
            chatId: ctx.getCurrentChatId(),
        };
        if (row.kind === 'group') {
            const alreadyOpen = String(groupChats.selected_group) === String(row.groupId)
                && String(ctx.getCurrentChatId()) === String(row.file_id);
            if (!alreadyOpen) {
                navigationStarted = true;
                await navigateAndConfirm(ctx, row.file_id, signal => runHostAction(async () => {
                    const selected = await groupChats.openGroupById(row.groupId);
                    signal.throwIfAborted();
                    if (!selected) {
                        throw new Error('Failed to select group');
                    }
                    if (String(ctx.getCurrentChatId()) !== String(row.file_id)) {
                        await ctx.openGroupChat(row.groupId, row.file_id);
                        signal.throwIfAborted();
                    }
                }), { signal: controller.signal });
            }
            controller.signal.throwIfAborted();
            host.setActiveGroup(row.groupId);
        } else {
            const index = ctx.characters.findIndex(character => character.avatar === row.avatar);
            if (index === -1) {
                throw new Error(`Character not found for avatar: ${row.avatar}`);
            }
            const alreadyOpen = String(host.this_chid) === String(index) && String(ctx.getCurrentChatId()) === String(row.file_id);
            if (!alreadyOpen) {
                navigationStarted = true;
                await navigateAndConfirm(ctx, row.file_id, signal => runHostAction(async () => {
                    const selected = await ctx.selectCharacterById(index);
                    signal.throwIfAborted();
                    if (!selected) {
                        throw new Error('Failed to select character');
                    }
                    if (String(ctx.getCurrentChatId()) !== String(row.file_id)) {
                        await ctx.openCharacterChat(row.file_id);
                        signal.throwIfAborted();
                    }
                }), { signal: controller.signal });
            }
            controller.signal.throwIfAborted();
            host.setActiveCharacter(row.avatar);
        }
        if (String(ctx.getCurrentChatId()) !== String(row.file_id)) {
            throw new Error('Host did not open the requested chat');
        }
        navigationConfirmed = true;
        ctx.saveSettingsDebounced();
        if (!state.closed && popup === state.popup) {
            state.restoreFocus = false;
            await state.popup.completeCancelled();
            document.getElementById('send_textarea')?.focus();
        }
    } catch (error) {
        const cancelled = error?.name === 'AbortError' || error?.name === 'TimeoutError';
        // ponytail: host navigation cannot be canceled; do not race rollback against a timed-out call.
        if (!cancelled && navigationStarted && !navigationConfirmed && host && groupChats && previous) {
            await restorePreviousChat(ctx, host, groupChats, previous);
        }
        if (error?.name !== 'AbortError') {
            console.error('[Chat Archive] failed to open chat:', error);
            globalThis.toastr?.error(tr(ctx, 'Could not open this chat. The archive is still available.'));
        }
    } finally {
        // ponytail: keep the lock until uncancellable timed-out host work settles.
        navigationFinished = true;
        releaseHostNavigation();
        if (state.navigationAbort === controller) {
            state.navigationPending = false;
            state.navigationAbort = null;
            const currentControl = state.navigationControl;
            state.navigationControl = null;
            for (const target of new Set([control, currentControl])) {
                if (target?.isConnected) {
                    target.removeAttribute('aria-disabled');
                    target.querySelector('.sbca-button-copy').textContent = target === control ? original : tr(ctx, 'Open chat');
                }
            }
        }
    }
}

function downloadChat(ctx, row, raw, format, control) {
    if (control.getAttribute('aria-disabled') === 'true') {
        return;
    }
    const copy = control.querySelector('.sbca-button-copy');
    const original = copy.textContent;
    control.setAttribute('aria-disabled', 'true');
    copy.textContent = tr(ctx, 'Preparing...');
    try {
        const content = format === 'txt' ? recordsToText(parseJsonl(raw)) : raw;
        const mime = format === 'txt' ? 'text/plain;charset=utf-8' : 'application/x-ndjson;charset=utf-8';
        downloadBlob(content, mime, `${row.file_id}.${format}`);
        globalThis.toastr?.success(tr(ctx, 'Download started.'));
    } catch (error) {
        console.error('[Chat Archive] export failed:', error);
        globalThis.toastr?.error(tr(ctx, 'Could not prepare this download.'));
    } finally {
        control.removeAttribute('aria-disabled');
        copy.textContent = original;
    }
}

function downloadBlob(content, type, filename) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
