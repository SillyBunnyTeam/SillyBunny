import { physicalChatKey } from '../core.js';
import { exitDeepSearch } from './cancellation.js';
import { mutateSelectedChats } from './chat-organizer.js';
import {
    DENSITY_OPTIONS,
    GROUP_OPTIONS,
    KINDS,
    LIST_PAGE_SIZE,
    SEARCH_CONTENT_DEBOUNCE_MS,
    SEARCH_DEBOUNCE_MS,
    SORT_PILLS,
    UNFILED_VALUE,
} from './constants.js';
import { runDeepSearch } from './deep-search.js';
import {
    actionButton,
    button,
    el,
    inputControl,
    selectControl,
    setStatus,
    tr,
} from './dom.js';
import { commaValues } from './filter-values.js';
import { markOrganizationControl } from './focus.js';
import { loadRows, scanOrphans } from './inventory.js';
import { renderList, updateBrowseStatus } from './list.js';
import { fuzzyMentionChoices, mentionChoices, mentionSearchState } from './mentions.js';
import {
    buildBackupControls,
    buildNamedManager,
    exportOrganization,
    importOrganization,
    wireNamedManager,
} from './organization-manager.js';
import { requestOrganizationSave, setOrganizationControlsEnabled, updateOrganizationStatus } from './organization-save.js';
import { loadOrganization } from './organization.js';
import { fallbackOwnerChoice, filterOwnerOptions, ownerControl, renderOwnerOptions } from './owner-picker.js';
import { nextRenderId } from './render-id.js';
import { applySavedView, rememberCurrentView } from './saved-views.js';
import { buildBatchControls, updateSelectionControls } from './selection.js';
import { showList } from './viewer.js';

export function buildRoot(ctx, state) {
    const root = el('div', 'sbca-root');
    root.dataset.sbcaView = 'list';
    root.dataset.sbcaDensity = 'comfortable';
    // Match the archive's container queries, not the viewport around a narrower Window frame.
    const mobileQuery = Object.assign(new EventTarget(), { matches: globalThis.matchMedia('(max-width: 1000px)').matches });
    const layoutObserver = new ResizeObserver(([entry]) => {
        const width = entry.contentRect.width;
        const matches = width <= 1000;
        if (!width || mobileQuery.matches === matches) return;
        mobileQuery.matches = matches;
        mobileQuery.dispatchEvent(Object.assign(new Event('change'), { matches: mobileQuery.matches }));
    });
    const avoidSoftwareKeyboard = globalThis.matchMedia('(max-width: 1000px), (any-pointer: coarse)');

    const heading = el('h3', 'sbca-heading', tr(ctx, 'Chat Archive'));
    heading.id = 'sbca_heading';
    heading.tabIndex = -1;

    const toolbar = el('div', 'sbca-toolbar');
    const searchLabel = el('div', 'sbca-search');
    const searchLabelText = el('label', 'sbca-label', tr(ctx, 'Search indexed chats'));
    const search = document.createElement('input');
    search.id = `sbca_search_${nextRenderId()}`;
    search.type = 'search';
    search.className = 'text_pole';
    search.setAttribute('role', 'combobox');
    search.placeholder = tr(ctx, 'Type to search chats. Mention character names with @.');
    search.autocomplete = 'off';
    search.enterKeyHint = 'search';
    searchLabelText.htmlFor = search.id;
    const characterMentions = mentionChoices(ctx);
    const mentionMenu = el('div', 'sbca-mention-menu');
    mentionMenu.id = `sbca_mentions_${nextRenderId()}`;
    mentionMenu.setAttribute('role', 'listbox');
    mentionMenu.setAttribute('aria-label', tr(ctx, 'Character mentions'));
    mentionMenu.hidden = true;
    search.setAttribute('aria-controls', mentionMenu.id);
    search.setAttribute('aria-expanded', 'false');
    search.setAttribute('aria-autocomplete', 'list');
    (avoidSoftwareKeyboard.matches ? heading : search).setAttribute('autofocus', '');
    searchLabel.append(searchLabelText, search, mentionMenu);

    const browseStrip = el('div', 'sbca-browse-strip');
    browseStrip.setAttribute('role', 'group');
    browseStrip.setAttribute('aria-label', tr(ctx, 'Browse options'));
    const savedViewField = selectControl(ctx, 'Saved view', [['', 'Current view']], 'sbca-view-setting sbca-saved-view');
    const groupField = selectControl(ctx, 'Group', GROUP_OPTIONS, 'sbca-view-setting');
    const densityField = selectControl(ctx, 'Density', DENSITY_OPTIONS, 'sbca-view-setting');
    const sort = document.createElement('input');
    sort.type = 'hidden';
    sort.value = 'recent';
    markOrganizationControl(savedViewField.select);
    savedViewField.wrap.hidden = true;
    browseStrip.append(savedViewField.wrap, groupField.wrap, densityField.wrap);

    const optionsPanel = el('div', 'sbca-options-panel');
    optionsPanel.id = `sbca_filters_${nextRenderId()}`;
    const filterTools = el('div', 'sbca-filter-tools');
    const filterToggle = button('sbca-control sbca-filter-toggle', tr(ctx, 'Filters'));
    filterToggle.setAttribute('aria-controls', optionsPanel.id);
    filterToggle.setAttribute('aria-expanded', String(!mobileQuery.matches));
    const kinds = el('fieldset', 'sbca-kinds');
    kinds.append(el('legend', undefined, tr(ctx, 'Chat types')));
    for (const [kind, label] of KINDS) {
        const wrap = el('label', 'sbca-kind-pill');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = true;
        box.dataset.sbcaKind = kind;
        wrap.append(box, document.createTextNode(tr(ctx, label)));
        kinds.append(wrap);
    }
    const favoriteWrap = el('label', 'sbca-kind-pill sbca-favorite-filter');
    const favorite = document.createElement('input');
    favorite.type = 'checkbox';
    favorite.checked = true;
    const favoriteLabel = el('span', undefined, tr(ctx, 'Favorites'));
    favoriteWrap.append(favorite, favoriteLabel);
    kinds.append(favoriteWrap);

    const ownerField = ownerControl(ctx);
    const orphanField = selectControl(ctx, 'Orphan reason', [
        ['', 'Any reason'],
        ['missing-character', 'Missing character'],
        ['missing-group', 'Missing group'],
        ['unlinked-group', 'Unlinked group'],
        ['root', 'Root file'],
    ]);
    orphanField.wrap.classList.add('sbca-orphan-filter', 'sbca-view-setting');
    const folderField = selectControl(ctx, 'Folder', [
        ['', 'Any folder'],
        [UNFILED_VALUE, 'Unfiled'],
    ]);
    const collectionField = selectControl(ctx, 'Collection', [['', 'Any collection']]);
    const tagField = inputControl(ctx, 'Tag');
    const tagOptions = document.createElement('datalist');
    tagOptions.id = `sbca_tag_options_${nextRenderId()}`;
    tagField.input.setAttribute('list', tagOptions.id);
    const minDateField = inputControl(ctx, 'From date', 'date');
    const maxDateField = inputControl(ctx, 'To date', 'date');
    minDateField.wrap.classList.add('sbca-date-filter');
    maxDateField.wrap.classList.add('sbca-date-filter');
    // Keep legacy saved-view constraints applicable without keeping their low-value controls in the toolbar.
    const minSize = document.createElement('input');
    const maxSize = document.createElement('input');
    const minMessages = document.createElement('input');
    const maxMessages = document.createElement('input');
    for (const input of [minSize, maxSize, minMessages, maxMessages]) {
        input.type = 'hidden';
    }
    for (const control of [folderField.select, collectionField.select, tagField.input]) {
        markOrganizationControl(control);
    }

    const refreshButton = button('sbca-control', tr(ctx, 'Refresh'));
    const scanButton = button('sbca-control', tr(ctx, 'Find orphaned files'));
    scanButton.title = tr(ctx, 'Scan for chats belonging to deleted characters or unlinked groups. This can take a while.');
    const archiveActions = el('div', 'sbca-archive-actions');
    archiveActions.append(refreshButton, browseStrip);
    const orphanActions = el('div', 'sbca-orphan-actions');
    orphanActions.append(orphanField.wrap, scanButton);
    const organizationToggle = button('sbca-control sbca-organization-toggle', tr(ctx, 'Manage organization'));
    organizationToggle.setAttribute('aria-expanded', 'false');
    const management = el('div', 'sbca-management');
    const managers = {
        folders: buildNamedManager(ctx, 'folders', 'Folders', 'Folder name'),
        collections: buildNamedManager(ctx, 'collections', 'Collections', 'Collection name'),
        views: buildNamedManager(ctx, 'views', 'Saved views', 'View name'),
    };
    management.append(managers.folders.root, managers.collections.root, managers.views.root);
    const backup = buildBackupControls(ctx);
    const organizationPanel = el('div', 'sbca-organization-tools-panel');
    organizationPanel.id = `sbca_organization_${nextRenderId()}`;
    organizationPanel.hidden = true;
    organizationToggle.setAttribute('aria-controls', organizationPanel.id);
    organizationPanel.append(management, backup.root);
    optionsPanel.append(
        kinds,
        tagOptions,
        minDateField.wrap,
        maxDateField.wrap,
    );
    const secondaryActions = el('div', 'sbca-archive-secondary-actions');
    secondaryActions.append(orphanActions, organizationToggle);
    filterTools.append(archiveActions, filterToggle, optionsPanel, secondaryActions, organizationPanel);

    const status = el('div', 'sbca-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    toolbar.append(searchLabel, filterTools, status);

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
    const listTools = el('div', 'sbca-list-tools');
    listTools.append(ownerField.wrap, sortPills, selectionBar);
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
        observeLayout() {
            layoutObserver.observe(root.closest('.sbca-dialog.sb-dialog--window > .popup-body') ?? document.body);
        },
        heading,
        search,
        characterMentions,
        mentionMenu,
        kinds,
        savedView: savedViewField.select,
        savedViewWrap: savedViewField.wrap,
        group: groupField.select,
        density: densityField.select,
        sort,
        owner: ownerField.input,
        ownerField,
        orphan: orphanField.select,
        favorite,
        favoriteLabel,
        folder: folderField.select,
        collection: collectionField.select,
        tag: tagField.input,
        tagOptions,
        minDate: minDateField.input,
        maxDate: maxDateField.input,
        minSize,
        maxSize,
        minMessages,
        maxMessages,
        optionsPanel,
        filterToggle,
        organizationToggle,
        organizationPanel,
        refreshButton,
        scanButton,
        status,
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
    backup.retryButton.addEventListener('click', () => {
        if (state.organizationLoadState === 'error') {
            void loadOrganization(ctx, state, ui);
        } else {
            requestOrganizationSave(ctx, state, ui);
        }
    });

    let queryTimer = null;
    let tagTimer = null;
    let mentionActiveIndex = -1;
    let restoreFilterFocusOnDesktop = false;
    filterToggle.addEventListener('focus', () => {
        restoreFilterFocusOnDesktop = true;
    });
    filterToggle.addEventListener('blur', event => {
        if (event.relatedTarget) {
            restoreFilterFocusOnDesktop = false;
        }
    });
    const handleBreakpoint = event => {
        const active = document.activeElement;
        const focusInBrowse = browseStrip.contains(active);
        const focusInFilters = optionsPanel.contains(active);
        const organizationExpanded = organizationToggle.getAttribute('aria-expanded') === 'true';
        const showDesktopFilters = !event.matches && !organizationExpanded;
        optionsPanel.hidden = !showDesktopFilters;
        filterToggle.setAttribute('aria-expanded', String(showDesktopFilters));
        if (state.closed) {
            return;
        }
        if (!event.matches) {
            if (restoreFilterFocusOnDesktop && showDesktopFilters) {
                optionsPanel.querySelector('input, select, button')?.focus({ preventScroll: true });
                restoreFilterFocusOnDesktop = false;
            }
            return;
        }
        if (root.dataset.sbcaView === 'list' && focusInFilters) {
            restoreFilterFocusOnDesktop = true;
            filterToggle.focus({ preventScroll: true });
        } else if (root.dataset.sbcaView === 'detail' && (active === document.body || toolbar.contains(active) || listPanel.contains(active))) {
            viewerTitle.focus({ preventScroll: true });
        } else if (root.dataset.sbcaView === 'list' && focusInBrowse) {
            groupField.select.focus({ preventScroll: true });
        } else if (root.dataset.sbcaView === 'list' && (active === document.body || viewer.contains(active))) {
            search.focus({ preventScroll: true });
        }
    };
    mobileQuery.addEventListener('change', handleBreakpoint);
    optionsPanel.hidden = mobileQuery.matches;
    filterToggle.addEventListener('click', () => {
        const expanded = filterToggle.getAttribute('aria-expanded') !== 'true';
        filterToggle.setAttribute('aria-expanded', String(expanded));
        optionsPanel.hidden = !expanded;
        if (expanded) {
            organizationToggle.setAttribute('aria-expanded', 'false');
            organizationPanel.hidden = true;
        }
    });
    organizationToggle.addEventListener('click', () => {
        const expanded = organizationToggle.getAttribute('aria-expanded') !== 'true';
        organizationToggle.setAttribute('aria-expanded', String(expanded));
        organizationPanel.hidden = !expanded;
        if (expanded) {
            filterToggle.setAttribute('aria-expanded', 'false');
            optionsPanel.hidden = true;
        } else if (!mobileQuery.matches) {
            filterToggle.setAttribute('aria-expanded', 'true');
            optionsPanel.hidden = false;
        }
    });
    state.cleanup = () => {
        clearTimeout(queryTimer);
        clearTimeout(tagTimer);
        mobileQuery.removeEventListener('change', handleBreakpoint);
        layoutObserver.disconnect();
        document.removeEventListener('pointerdown', closeOwnerOnOutside);
    };

    const closeMentionMenu = () => {
        mentionMenu.hidden = true;
        mentionActiveIndex = -1;
        search.removeAttribute('aria-activedescendant');
        search.setAttribute('aria-expanded', 'false');
    };
    const chooseMention = choice => {
        const active = mentionSearchState(search.value, characterMentions).active;
        if (!active) {
            return;
        }
        const token = /[\s"\\]/.test(choice.name) ? `@${JSON.stringify(choice.name)}` : `@${choice.name}`;
        search.value = `${search.value.slice(0, active.start)}${token} `;
        closeMentionMenu();
        search.focus({ preventScroll: true });
        search.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const renderMentionMenu = () => {
        const active = mentionSearchState(search.value, characterMentions).active;
        mentionMenu.replaceChildren();
        if (!active) {
            closeMentionMenu();
            return;
        }
        const matches = fuzzyMentionChoices(characterMentions, active.fragment);
        for (const choice of matches) {
            const option = button('sbca-mention-option', choice.name);
            option.id = `sbca_mention_${nextRenderId()}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            option.tabIndex = -1;
            option.addEventListener('click', () => chooseMention(choice));
            mentionMenu.append(option);
        }
        mentionActiveIndex = -1;
        search.removeAttribute('aria-activedescendant');
        mentionMenu.hidden = matches.length === 0;
        search.setAttribute('aria-expanded', String(matches.length > 0));
    };
    const moveMentionSelection = direction => {
        const options = [...mentionMenu.querySelectorAll('.sbca-mention-option')];
        if (options.length === 0) {
            return;
        }
        mentionActiveIndex = mentionActiveIndex < 0
            ? (direction > 0 ? 0 : options.length - 1)
            : (mentionActiveIndex + direction + options.length) % options.length;
        options.forEach((option, index) => option.setAttribute('aria-selected', String(index === mentionActiveIndex)));
        const active = options[mentionActiveIndex];
        search.setAttribute('aria-activedescendant', active.id);
        active.scrollIntoView({ block: 'nearest' });
    };
    searchLabel.addEventListener('focusout', () => {
        setTimeout(() => {
            if (!searchLabel.contains(document.activeElement)) {
                closeMentionMenu();
            }
        });
    });

    const applyQuery = () => {
        exitDeepSearch(ctx, state, ui);
        state.visibleLimit = LIST_PAGE_SIZE;
        renderList(ctx, state, ui);
        updateBrowseStatus(ctx, state, ui);
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
        void runDeepSearch(ctx, state, ui);
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
        renderMentionMenu();
        noteViewEdit();
        clearTimeout(queryTimer);
        queryTimer = null;
        applyQuery();
        if (mentionSearchState(search.value, characterMentions).text && state.listState === 'ready' && !state.scanAbort) {
            queryTimer = setTimeout(() => {
                queryTimer = null;
                const query = mentionSearchState(search.value, characterMentions).text;
                if (!query || state.listState !== 'ready' || state.scanAbort || state.searchAbort
                    || (state.deepRows !== null && state.deepQuery === query)) {
                    return;
                }
                void runDeepSearch(ctx, state, ui);
            }, SEARCH_CONTENT_DEBOUNCE_MS);
        }
    });
    search.addEventListener('keydown', event => {
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !mentionMenu.hidden) {
            event.preventDefault();
            moveMentionSelection(event.key === 'ArrowDown' ? 1 : -1);
            return;
        }
        if (event.key === 'Escape' && !mentionMenu.hidden) {
            event.preventDefault();
            closeMentionMenu();
            return;
        }
        if (event.key === 'Enter' && !mentionMenu.hidden && mentionActiveIndex >= 0) {
            event.preventDefault();
            const option = mentionMenu.querySelectorAll('.sbca-mention-option')[mentionActiveIndex];
            option?.click();
            return;
        }
        if (event.key !== 'Enter' || event.isComposing) {
            return;
        }
        event.preventDefault();
        flushQuery();
    });
    kinds.addEventListener('change', event => {
        if (event.target === ui.favorite) {
            ui.favorite.indeterminate = false;
        }
        applyViewOptions();
        noteViewEdit();
    });
    for (const control of [
        ui.group,
        ui.density,
        ui.sort,
        ui.owner,
        ui.orphan,
        ui.folder,
        ui.collection,
        ui.minDate,
        ui.maxDate,
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
            if (control === ui.owner && mentionSearchState(ui.search.value, ui.characterMentions).text
                && state.listState === 'ready' && !state.scanAbort) {
                void runDeepSearch(ctx, state, ui);
            }
        });
    }
    ui.tag.addEventListener('input', () => {
        noteViewEdit();
        clearTimeout(tagTimer);
        tagTimer = setTimeout(() => {
            tagTimer = null;
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
    refreshButton.addEventListener('click', () => {
        if (state.listAbort) {
            state.listAbort.abort();
            refreshButton.disabled = true;
            refreshButton.textContent = tr(ctx, 'Stopping...');
            return;
        }
        void loadRows(ctx, state, ui);
    });
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
    selectionToggle.addEventListener('click', () => {
        state.selectionMode = !state.selectionMode;
        if (!state.selectionMode) {
            state.selectedBatchKeys.clear();
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
