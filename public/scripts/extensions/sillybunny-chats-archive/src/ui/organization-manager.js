import { normalizeOrganization, parseOrganization } from '../core.js';
import { ORGANIZATION_FILE_NAME } from '../api.js';
import { openAlert } from '../../../../sillybunny-editor/dialog.js';
import { createButtonRow, createEntryRow, createPrefGroup, createRow, releaseRowIds } from '../../../../sillybunny-editor/rows.js';
import { refreshOpenOrganizer } from './chat-organizer.js';
import { MAX_ORGANIZATION_IMPORT_BYTES } from './constants.js';
import { button, el, rowActionButton, tr } from './dom.js';
import { downloadBlob } from './downloads.js';
import { focusByKey, markOrganizationControl, organizationFocusKey, preserveArchiveFocus } from './focus.js';
import { markOrganizationDirty, requestOrganizationSave, setOrganizationControlsEnabled } from './organization-save.js';
import { commitOrganizationChange, loadOrganization, refreshOrganizationUI } from './organization.js';
import { applySavedView, currentSavedView } from './saved-views.js';

const NAMED_GROUPS = [
    ['folders', 'Folders', 'Folder name'],
    ['collections', 'Collections', 'Collection name'],
    ['views', 'Saved views', 'View name'],
];

function createOrganizationId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
        const random = Math.random() * 16 | 0;
        const value = character === 'x' ? random : (random & 0x3 | 0x8);
        return value.toString(16);
    });
}

function formStatus() {
    const status = el('div', 'sbca-form-status');
    status.setAttribute('role', 'alert');
    return status;
}

function buildNamedManager(ctx, state, ui, type, title, inputLabel) {
    const input = document.createElement('input');
    const add = button('menu_button', tr(ctx, 'Create'));
    const createKey = organizationFocusKey('manager', type, 'create');
    markOrganizationControl(input, createKey);
    markOrganizationControl(add, organizationFocusKey('manager', type, 'add'), createKey);
    const createRowControl = createEntryRow({
        label: tr(ctx, inputLabel),
        field: `${type}-create`,
        floating: true,
        suffix: add,
        input,
    });
    const group = createPrefGroup({ title: tr(ctx, title), field: `${type}-group`, rows: [createRowControl] });
    const status = formStatus();
    group.section.append(status);
    const manager = { type, inputLabel, group, input, add, status, createKey, createRow: createRowControl.row, itemRows: [] };

    const create = () => {
        const error = addNamedItem(ctx, state, ui, type, input.value);
        status.textContent = error;
        if (!error) {
            input.value = '';
        }
    };
    add.addEventListener('click', create);
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            create();
        }
    });
    return manager;
}

function buildBackupGroup(ctx) {
    const exportRow = createButtonRow({ label: tr(ctx, 'Export organization'), icon: 'file-export', field: 'backup-export' });
    const importRow = createButtonRow({ label: tr(ctx, 'Import organization'), icon: 'file-import', field: 'backup-import' });
    const retryRow = createButtonRow({ label: tr(ctx, 'Retry'), icon: 'rotate-right', field: 'backup-retry' });
    retryRow.row.hidden = true;
    markOrganizationControl(exportRow.row);
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.hidden = true;
    const status = formStatus();
    const group = createPrefGroup({ title: tr(ctx, 'Organization backup'), field: 'backup', rows: [exportRow, importRow, retryRow] });
    group.section.append(fileInput, status);
    return {
        section: group.section,
        exportButton: exportRow.row,
        importButton: importRow.row,
        retryButton: retryRow.row,
        fileInput,
        status,
    };
}

export function buildOrganizationContent(ctx, state, ui) {
    ui.managers = Object.fromEntries(NAMED_GROUPS.map(([type, title, inputLabel]) => [
        type,
        buildNamedManager(ctx, state, ui, type, title, inputLabel),
    ]));
    ui.backup = buildBackupGroup(ctx);
    ui.organizationContent = el('div', 'sbca-organization-content');
    ui.organizationContent.append(...Object.values(ui.managers).map(manager => manager.group.section), ui.backup.section);

    const { backup } = ui;
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
}

export function addNamedItem(ctx, state, ui, type, rawName) {
    const name = rawName.trim();
    if (!name) {
        return tr(ctx, 'Enter a name.');
    }
    if (hasDuplicateName(state.organization?.[type], name)) {
        return tr(ctx, 'That name is already in use.');
    }
    const item = { id: createOrganizationId(), name };
    if (type === 'views') {
        item.view = currentSavedView(state, ui);
    }
    state.organization = normalizeOrganization({
        ...state.organization,
        [type]: [...state.organization[type], item],
    });
    state.selectedViewId = type === 'views' ? item.id : state.selectedViewId;
    commitOrganizationChange(ctx, state, ui);
    return '';
}

function hasDuplicateName(items, name, exceptId = null) {
    const folded = name.toLocaleLowerCase();
    return (items ?? []).some(item => item.id !== exceptId && item.name.toLocaleLowerCase() === folded);
}

function renderManagers(ctx, state, ui) {
    for (const [type, manager] of Object.entries(ui.managers)) {
        renderNamedManager(ctx, state, ui, type, manager);
    }
    setOrganizationControlsEnabled(ui, state.organizationWritable);
}

export function renderNamedManager(ctx, state, ui, type, manager) {
    for (const row of manager.itemRows) {
        releaseRowIds(row);
        row.remove();
    }
    const items = state.organization?.[type] ?? [];
    if (ui.editing?.type === type && !items.some(item => item.id === ui.editing.id)) {
        ui.editing = null;
    }
    manager.itemRows = items.length === 0
        ? [createRow({ label: tr(ctx, 'None yet.'), field: `${type}-empty` }).row]
        : items.map(item => ui.editing?.type === type && ui.editing.id === item.id
            ? buildEditRow(ctx, state, ui, type, manager, items, item)
            : buildLabelRow(ctx, state, ui, type, manager, item));
    manager.createRow.before(...manager.itemRows);
}

const renameKey = (type, id) => organizationFocusKey('manager', type, id, 'rename');

function buildLabelRow(ctx, state, ui, type, manager, item) {
    const rename = rowActionButton(tr(ctx, 'Rename {name}', { name: item.name }), 'pen');
    const remove = rowActionButton(tr(ctx, 'Delete {name}', { name: item.name }), 'trash');
    markOrganizationControl(rename, renameKey(type, item.id), manager.createKey);
    markOrganizationControl(remove, organizationFocusKey('manager', type, item.id, 'delete'), manager.createKey);
    rename.addEventListener('click', () => {
        ui.editing = { type, id: item.id, draft: item.name };
        for (const other of Object.values(ui.managers)) {
            other.status.textContent = '';
        }
        renderManagers(ctx, state, ui);
        focusByKey(ui, organizationFocusKey('manager', type, item.id, 'name'));
    });
    remove.addEventListener('click', () => deleteNamedItem(ctx, state, ui, type, item));
    return createRow({ label: item.name, field: `${type}-${item.id}`, suffix: [rename, remove] }).row;
}

function buildEditRow(ctx, state, ui, type, manager, items, item) {
    const input = document.createElement('input');
    input.setAttribute('aria-label', tr(ctx, 'Rename {name}', { name: item.name }));
    const apply = rowActionButton(tr(ctx, 'Rename {name}', { name: item.name }), 'check');
    const cancelEdit = rowActionButton(tr(ctx, 'Cancel'), 'xmark');
    const fallback = renameKey(type, item.id);
    markOrganizationControl(input, organizationFocusKey('manager', type, item.id, 'name'), fallback);
    markOrganizationControl(apply, organizationFocusKey('manager', type, item.id, 'apply'), fallback);
    markOrganizationControl(cancelEdit, organizationFocusKey('manager', type, item.id, 'cancel'), fallback);

    const leave = () => {
        ui.editing = null;
        manager.status.textContent = '';
        renderManagers(ctx, state, ui);
        focusByKey(ui, fallback);
    };
    const commit = () => {
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
        ui.editing = null;
        manager.status.textContent = '';
        commitOrganizationChange(ctx, state, ui);
    };
    input.addEventListener('input', () => {
        ui.editing.draft = input.value;
    });
    input.addEventListener('keydown', event => {
        if (event.isComposing) {
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            commit();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            leave();
        }
    });
    apply.addEventListener('click', commit);
    cancelEdit.addEventListener('click', leave);
    return createEntryRow({
        label: tr(ctx, manager.inputLabel),
        field: `${type}-${item.id}`,
        floating: true,
        value: ui.editing.draft,
        suffix: [apply, cancelEdit],
        input,
    }).row;
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

async function deleteNamedItem(ctx, state, ui, type, item) {
    const message = type === 'views'
        ? tr(ctx, 'Delete saved view {name}?', { name: item.name })
        : (type === 'folders' || type === 'collections') && namedItemHasReferences(state.organization, type, item.id)
            ? tr(ctx, 'Delete {name} and remove it from chats and saved views?', { name: item.name })
            : null;
    if (message) {
        const response = await openAlert({
            heading: message,
            responses: [
                { id: 'cancel', label: tr(ctx, 'Cancel') },
                { id: 'delete', label: tr(ctx, 'Delete'), appearance: 'destructive' },
            ],
        });
        if (response !== 'delete') return;
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
    const response = await openAlert({
        heading: tr(ctx, 'Replace all current folders, collections, saved views, tags, and favorites?'),
        responses: [
            { id: 'cancel', label: tr(ctx, 'Cancel') },
            { id: 'replace', label: tr(ctx, 'Replace'), appearance: 'destructive' },
        ],
    });
    if (response !== 'replace') {
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
        delete ui.backup.status.dataset.sbcaOrganizationError;
        refreshOpenOrganizer(ctx, state, ui);
        markOrganizationDirty(ctx, state, ui);
    });
}
