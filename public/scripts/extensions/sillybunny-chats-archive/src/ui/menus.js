import { closeActionMenu, openActionMenu, openPopover } from '../../../../sillybunny-action-menu.js';
import { createIconButton } from '../../../../sillybunny-editor/dialog.js';
import { t } from '../../../../i18n.js';
import { stopBusyTask } from './busy.js';
import { SORT_KEYS } from './constants.js';
import { button, el, placeholderCopy, tr } from './dom.js';
import { createFilterButton, syncFilterButtons } from './filters.js';
import { loadRows, scanOrphans } from './inventory.js';
import { addNamedItem } from './organization-manager.js';
import { pushPage } from './panes.js';
import { applySavedView, commitModel } from './saved-views.js';

function sortLabel(ctx, key) {
    switch (key) {
        case 'recent': return tr(ctx, 'Recent');
        case 'oldest': return tr(ctx, 'Oldest');
        case 'size': return tr(ctx, 'Largest');
        case 'count': return tr(ctx, 'Most messages');
        case 'name': return tr(ctx, 'A-Z');
        case 'name-reverse': return t`Z-A`;
        case 'owner': return tr(ctx, 'Owner');
        default: return placeholderCopy();
    }
}

function createViewButton(ctx, state, ui) {
    const control = createIconButton(t`View`, 'arrow-down-wide-short', 'sbca-view-button');
    control.setAttribute('aria-haspopup', 'menu');
    control.addEventListener('click', () => openActionMenu({
        trigger: control,
        title: t`View`,
        bounds: ui.dialog.surface,
        sections: [{
            title: t`Sort`,
            items: SORT_KEYS.map(key => ({
                label: sortLabel(ctx, key),
                kind: 'radio',
                checked: state.model.sort === key,
                onSelect: () => commitModel(ctx, state, ui, { ...state.model, sort: key }),
            })),
        }],
    }));
    return control;
}

export function addViewControls(ctx, state, ui, handle) {
    handle.headerEnd.prepend(createViewButton(ctx, state, ui), createFilterButton(ctx, state, ui));
    syncFilterButtons(state, ui);
}

function openSaveView(ctx, state, ui, trigger) {
    const content = el('div', 'sbca-save-view');
    const input = document.createElement('input');
    input.className = 'text_pole';
    input.setAttribute('aria-label', tr(ctx, 'View name'));
    input.placeholder = tr(ctx, 'View name');
    const status = el('div', 'sbca-form-status');
    status.setAttribute('role', 'alert');
    const create = button('menu_button menu_button_primary', tr(ctx, 'Create'));
    const submit = () => {
        const error = addNamedItem(ctx, state, ui, 'views', input.value);
        status.textContent = error;
        if (!error) {
            closeActionMenu({ restoreFocus: true });
        }
    };
    create.addEventListener('click', submit);
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            submit();
        }
    });
    content.append(input, status, create);
    openPopover({
        trigger,
        title: placeholderCopy(),
        content,
        bounds: ui.dialog.surface,
        initialFocus: () => input,
    });
}

function openOrganizationPage(ctx, state, ui) {
    if (ui.organizationPage) {
        return;
    }
    const page = pushPage(ui, {
        title: tr(ctx, 'Manage organization'),
        content: ui.organizationContent,
        className: 'sbca-organization-page',
    });
    ui.organizationPage = page;
    void page.closed.then(() => {
        ui.organizationPage = null;
    });
}

/** Sections for the frame's menu button; rebuilt on each open so Refresh and Find orphaned files show their current state. */
export function archiveMenuSections(ctx, state, ui, trigger) {
    const loading = Boolean(state.listAbort);
    const scanning = Boolean(state.scanAbort);
    const scanLabel = scanning
        ? 'Stop scan'
        : state.orphanScanComplete ? 'Rescan orphaned files' : 'Find orphaned files';
    return [
        {
            title: tr(ctx, 'Saved views'),
            items: [
                {
                    label: tr(ctx, 'Current view'),
                    kind: 'radio',
                    checked: !state.selectedViewId,
                    onSelect: () => {
                        state.selectedViewId = null;
                    },
                },
                ...(state.organization?.views ?? []).map(view => ({
                    label: view.name,
                    kind: 'radio',
                    checked: state.selectedViewId === view.id,
                    onSelect: () => applySavedView(ctx, state, ui, view.view, view.id),
                })),
            ],
        },
        {
            items: [{
                label: placeholderCopy(),
                icon: 'fa-solid fa-bookmark',
                disabled: !state.organizationWritable,
                onSelect: () => openSaveView(ctx, state, ui, trigger),
            }],
        },
        {
            items: [{
                label: tr(ctx, 'Select chats'),
                icon: 'fa-solid fa-check-double',
                onSelect: () => ui.selection.enter(null, trigger),
            }],
        },
        {
            items: [
                {
                    label: tr(ctx, loading ? 'Cancel' : 'Refresh'),
                    icon: 'fa-solid fa-arrows-rotate',
                    disabled: scanning,
                    onSelect: () => (loading ? stopBusyTask(ctx, state, ui) : void loadRows(ctx, state, ui)),
                },
                {
                    label: tr(ctx, scanLabel),
                    title: tr(ctx, 'Scan for chats belonging to deleted characters or unlinked groups. This can take a while.'),
                    icon: 'fa-solid fa-file-circle-question',
                    disabled: loading,
                    onSelect: () => (scanning ? stopBusyTask(ctx, state, ui) : void scanOrphans(ctx, state, ui)),
                },
            ],
        },
        {
            items: [{
                label: tr(ctx, 'Manage organization'),
                icon: 'fa-solid fa-folder-tree',
                onSelect: () => openOrganizationPage(ctx, state, ui),
            }],
        },
    ];
}
