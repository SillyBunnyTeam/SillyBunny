import { normalizeOrganization, parseOrganization } from '../core.js';
import { ORGANIZATION_FILE_NAME } from '../api.js';
import { openAlert } from '../../../../sillybunny-editor/dialog.js';
import { refreshOpenOrganizer } from './chat-organizer.js';
import { MAX_ORGANIZATION_IMPORT_BYTES } from './constants.js';
import { button, el, inputControl, tr } from './dom.js';
import { downloadBlob } from './downloads.js';
import { markOrganizationControl, organizationFocusKey, preserveArchiveFocus } from './focus.js';
import { markOrganizationDirty } from './organization-save.js';
import { commitOrganizationChange, refreshOrganizationUI } from './organization.js';
import { applySavedView, currentSavedView } from './saved-views.js';

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

export function buildNamedManager(ctx, type, title, inputLabel) {
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

export function buildBackupControls(ctx) {
    const root = el('section', 'sbca-organization-backup');
    root.append(el('h5', 'sbca-manager-heading', tr(ctx, 'Organization backup')));
    const exportButton = button('sbca-control', tr(ctx, 'Export organization'));
    const importButton = button('sbca-control', tr(ctx, 'Import organization'));
    const retryButton = button('sbca-control', tr(ctx, 'Retry'));
    retryButton.hidden = true;
    markOrganizationControl(exportButton);
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.hidden = true;
    const status = el('div', 'sbca-import-status');
    status.setAttribute('role', 'alert');
    root.append(exportButton, importButton, retryButton, fileInput, status);
    return { root, exportButton, importButton, retryButton, fileInput, status };
}

export function wireNamedManager(ctx, state, ui, type, manager) {
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
        const item = { id: createOrganizationId(), name };
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

export function renderNamedManager(ctx, state, ui, type, manager) {
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

export function exportOrganization(ctx, state) {
    if (!state.organization) {
        return;
    }
    const text = `${JSON.stringify(normalizeOrganization(state.organization), null, 2)}\n`;
    downloadBlob(text, 'application/json;charset=utf-8', ORGANIZATION_FILE_NAME);
    globalThis.toastr?.success(tr(ctx, 'Organization export started.'));
}

export async function importOrganization(ctx, state, ui) {
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
