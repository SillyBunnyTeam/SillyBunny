import { LAYOUT_MOBILE_QUERY } from '../../../../sillybunny-editor/breakpoints.js';
import { createListEditor, isListEditorCollapsed } from '../../../../sillybunny-editor/list-shell.js';
import { stopBusyTask, syncBusyControls } from './busy.js';
import { COLLAPSE_WIDTH } from './constants.js';
import { button, el, tr } from './dom.js';
import { addViewControls, archiveMenuSections } from './menus.js';
import { bindListKeys, deriveView, renderList } from './list.js';
import { buildOrganizationContent } from './organization-manager.js';
import { setOrganizationControlsEnabled, updateOrganizationStatus } from './organization-save.js';
import { nextRenderId } from './render-id.js';
import { commitModel } from './saved-views.js';
import { bindSearchField } from './search.js';
import { createArchiveSelection, updateSelectionControls } from './selection.js';
import { bindLocationKeys, renderSidebar } from './sidebar.js';
import { focusSelection, pushPage, syncLocationPane } from './panes.js';
import { withLocation } from './view-model.js';

function buildListPane(ctx, ui) {
    const pane = el('div', 'sbca-list-pane');
    ui.listHeading = el('h3', 'sbca-list-heading');
    ui.listHeading.id = `sbca_list_heading_${nextRenderId()}`;
    ui.listHeading.tabIndex = -1;

    ui.banner = el('div', 'sb-banner sbca-banner');
    ui.banner.hidden = true;
    ui.bannerText = el('span');
    ui.status = el('span', 'sbca-status');
    ui.status.setAttribute('role', 'status');
    ui.status.setAttribute('aria-live', 'polite');
    ui.status.setAttribute('aria-atomic', 'true');
    ui.bannerAction = button('menu_button');
    ui.bannerAction.hidden = true;
    ui.banner.append(ui.bannerText, ui.bannerAction);

    ui.list = el('div', 'sbca-list');
    ui.list.setAttribute('role', 'list');
    ui.list.setAttribute('aria-labelledby', ui.listHeading.id);
    ui.listScroll = el('div', 'sbca-list-scroll');
    pane.append(ui.listHeading, ui.status, ui.banner, ui.listScroll);
    ui.listPane = pane;
}

function buildViewerContent(ui) {
    ui.viewerContent = el('div', 'sbca-viewer-content');
    ui.viewerContent.tabIndex = -1;
}

/**
 * Builds the archive inside an open dialog frame: the locations sidebar, the chat list, and the header
 * controls. Returns the cleanup that releases listeners and the list editor.
 */
export function mountArchive(ctx, state, ui, dialog) {
    ui.dialog = dialog;
    ui.root = dialog.root;
    ui.searchControl = dialog.search;
    ui.tagOptions = document.createElement('datalist');
    ui.tagOptions.id = `sbca_tag_options_${nextRenderId()}`;
    ui.filtersDescription = el('span', 'sbca-filters-description', tr(ctx, 'Filters are active'));
    ui.filtersDescription.id = `sbca_filters_description_${nextRenderId()}`;
    ui.filtersDescription.hidden = true;
    dialog.surface.append(ui.filtersDescription);

    buildListPane(ctx, ui);
    buildOrganizationContent(ctx, state, ui);
    buildViewerContent(ui);
    ui.selectionBar = el('div', 'sbca-selection-bar');
    ui.organizationHosts = [dialog.root, ui.organizationContent];
    ui.bannerAction.addEventListener('click', () => stopBusyTask(ctx, state, ui));
    const unbindSearch = bindSearchField(ctx, state, ui);

    const openListPage = () => {
        if (ui.listPage) {
            return;
        }
        ui.splitFocusPending = false;
        const page = pushPage(ui, {
            title: ui.data.locations.current.label,
            content: ui.listPane,
            className: 'sbca-list-page',
            subtitle: ui.countText ?? '',
            menu: trigger => archiveMenuSections(ctx, state, ui, trigger),
        });
        ui.listPage = page;
        addViewControls(ctx, state, ui, page);
    };
    const chooseLocation = entry => {
        commitModel(ctx, state, ui, withLocation(state.model, entry));
        if (ui.listEditor.collapsed) {
            openListPage();
        }
    };
    // A covered root has no width, so the list editor cannot notice a resize; watch the page area and the phone query here.
    const pagesNode = dialog.page.parentElement;
    const phone = matchMedia(LAYOUT_MOBILE_QUERY);
    const isWide = () => !isListEditorCollapsed({ viewportMobile: phone.matches, width: pagesNode.clientWidth, collapseAt: COLLAPSE_WIDTH });
    ui.splitFocusPending = false;
    // The flag belongs to the list page that reconcileLayout closes. A list page closed any other way must not leave it set.
    let forcedListPage = null;
    const reconcileLayout = () => {
        if (!isWide() || !ui.listPage || ui.pages.at(-1) !== ui.listPage) {
            return;
        }
        const active = document.activeElement;
        ui.splitFocusPending ||= active === document.body || ui.listPage.page.contains(active);
        forcedListPage = ui.listPage;
        ui.listPage.forceClose();
    };
    const settleSplitFocus = () => {
        if (!ui.splitFocusPending || state.closed) {
            return;
        }
        ui.splitFocusPending = false;
        focusSelection(ui, state.selectedKey);
    };
    ui.onPageClosed = page => {
        if (dialog.isOpen === false) {
            return;
        }
        if (page === ui.listPage) {
            ui.listPage = null;
            if (page !== forcedListPage) {
                ui.splitFocusPending = false;
            }
            forcedListPage = null;
            syncLocationPane(ui);
        } else {
            reconcileLayout();
        }
    };

    const layoutWatcher = new ResizeObserver(reconcileLayout);
    layoutWatcher.observe(pagesNode);
    phone.addEventListener('change', reconcileLayout);
    const cleanup = () => {
        layoutWatcher.disconnect();
        phone.removeEventListener('change', reconcileLayout);
        unbindSearch();
        ui.selection?.destroy();
        ui.listEditor?.destroy();
    };

    try {
        dialog.body.classList.add('sbca-body');
        ui.data = deriveView(ctx, state, ui);
        ui.listEditor = createListEditor({
            container: dialog.body,
            storageKey: 'sbca-locations-width',
            defaultWidth: 0.29,
            minWidth: 220,
            maxWidth: 360,
            collapseAt: COLLAPSE_WIDTH,
            escapeCloses: false,
            transitionItemSwitch: false,
            label: tr(ctx, 'Locations'),
            classNames: { root: 'sbca-shell', sidebar: 'sbca-sidebar', detail: 'sbca-detail' },
            renderList: sidebar => renderSidebar(ctx, ui, sidebar, chooseLocation),
            renderDetail: detail => detail.append(ui.listPane),
            getKey: location => location.key,
            focusTarget: () => null,
            isDirty: () => false,
            onSave: () => true,
            onDiscard: () => {},
            // layout() runs this before it records the change, so deselecting here would re-enter it.
            onCollapseChange: collapsed => queueMicrotask(() => {
                if (state.closed) {
                    return;
                }
                // The selection header belongs to the page that showed the list, and a layout change moves the list to another page.
                ui.selection.exit();
                if (collapsed) {
                    ui.listEditor.deselectNow();
                } else {
                    reconcileLayout();
                    void Promise.resolve(syncLocationPane(ui)).then(settleSplitFocus);
                }
            }),
        });
        ui.sidebar = ui.listEditor.sidebar;
        bindLocationKeys(ui.sidebar);
        bindListKeys(ui);
        ui.selection = createArchiveSelection(ctx, state, ui);
        addViewControls(ctx, state, ui, dialog);

        ui.listEditor.layout();
        renderList(ctx, state, ui);
        syncBusyControls(ctx, state, ui);
        updateOrganizationStatus(ctx, state, ui);
        updateSelectionControls(ctx, state, ui);
        setOrganizationControlsEnabled(ui, false);
    } catch (error) {
        // The caller gets the cleanup only on success, so a failed mount must release the watchers itself.
        cleanup();
        throw error;
    }
    return cleanup;
}
