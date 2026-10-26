import { physicalChatKey } from '../core.js';
import { UNFILED_VALUE } from './constants.js';
import {
    button,
    el,
    inputControl,
    selectControl,
    tr,
} from './dom.js';
import { markOrganizationControl } from './focus.js';

export function buildBatchControls(ctx) {
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

export function updateSelectionControls(ctx, state, ui) {
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
