import { closeActionMenu, openActionMenu, openPopover } from '../../../../sillybunny-action-menu.js';
import { createSelectionMode } from '../../../../sillybunny-editor/selection-mode.js';
import { physicalChatKey } from '../core.js';
import { mutateSelectedChats } from './chat-organizer.js';
import { button, el, showCount, tr } from './dom.js';
import { commaValues } from './filter-values.js';

function metadataOf(state, key) {
    return state.organization?.chats?.[key] ?? {};
}

function selectedAll(state, ui, test) {
    const keys = ui.selection.selectedKeys;
    return keys.length > 0 && keys.every(key => test(metadataOf(state, key)));
}

function selectionTitle(ctx, state, ui, count) {
    const matching = new Set(state.matchingRows.map(physicalChatKey));
    const hidden = ui.selection.selectedKeys.filter(key => !matching.has(key)).length;
    return hidden > 0
        ? tr(ctx, '{count} selected ({hidden} hidden by filters)', { count, hidden })
        : tr(ctx, '{count} selected', { count });
}

function openFavoriteMenu(ctx, state, ui, trigger) {
    const mutate = mutation => mutateSelectedChats(ctx, state, ui, mutation);
    openActionMenu({
        trigger,
        title: tr(ctx, 'Favorite'),
        bounds: ui.dialog.surface,
        sections: [{
            items: [
                {
                    label: tr(ctx, 'Favorite'),
                    kind: 'radio',
                    checked: selectedAll(state, ui, metadata => metadata.favorite === true),
                    onSelect: () => mutate(metadata => {
                        metadata.favorite = true;
                    }),
                },
                {
                    label: tr(ctx, 'Unfavorite'),
                    kind: 'radio',
                    checked: selectedAll(state, ui, metadata => metadata.favorite !== true),
                    onSelect: () => mutate(metadata => {
                        delete metadata.favorite;
                    }),
                },
            ],
        }],
    });
}

function openFolderMenu(ctx, state, ui, trigger) {
    const mutate = mutation => mutateSelectedChats(ctx, state, ui, mutation);
    const folders = state.organization?.folders ?? [];
    openActionMenu({
        trigger,
        title: tr(ctx, 'Folder'),
        bounds: ui.dialog.surface,
        sections: [
            {
                items: folders.map(folder => ({
                    label: folder.name,
                    kind: 'radio',
                    checked: selectedAll(state, ui, metadata => metadata.folder === folder.id),
                    onSelect: () => mutate(metadata => {
                        metadata.folder = folder.id;
                    }),
                })),
            },
            {
                items: [{
                    label: tr(ctx, 'Clear folder'),
                    icon: 'fa-solid fa-folder-minus',
                    onSelect: () => mutate(metadata => {
                        delete metadata.folder;
                    }),
                }],
            },
        ],
    });
}

function openCollectionsMenu(ctx, state, ui, trigger) {
    const mutate = mutation => mutateSelectedChats(ctx, state, ui, mutation);
    const collections = state.organization?.collections ?? [];
    const sections = collections.length === 0
        ? [{ items: [{ label: tr(ctx, 'None yet.'), disabled: true, onSelect: () => {} }] }]
        : [
            {
                title: tr(ctx, 'Add collection'),
                items: collections.map(collection => ({
                    label: collection.name,
                    onSelect: () => mutate(metadata => {
                        metadata.collections = [...new Set([...(metadata.collections ?? []), collection.id])];
                    }),
                })),
            },
            {
                title: tr(ctx, 'Remove collection'),
                items: collections.map(collection => ({
                    label: collection.name,
                    onSelect: () => mutate(metadata => {
                        metadata.collections = (metadata.collections ?? []).filter(id => id !== collection.id);
                    }),
                })),
            },
        ];
    openActionMenu({ trigger, title: tr(ctx, 'Collections'), bounds: ui.dialog.surface, sections });
}

function openTagsPopover(ctx, state, ui, trigger) {
    const mutate = mutation => mutateSelectedChats(ctx, state, ui, mutation);
    const content = el('div', 'sbca-batch-tags');
    const input = document.createElement('input');
    input.className = 'text_pole';
    input.setAttribute('aria-label', tr(ctx, 'Tags (comma-separated)'));
    input.placeholder = tr(ctx, 'Tags (comma-separated)');
    const actions = el('div', 'sbca-popover-actions');
    const add = button('menu_button menu_button_primary', tr(ctx, 'Add tags'));
    const remove = button('menu_button', tr(ctx, 'Remove tags'));
    const apply = mutation => {
        if (commaValues(input.value).length === 0) {
            return;
        }
        mutate(mutation(commaValues(input.value)));
        closeActionMenu({ restoreFocus: true });
    };
    const addTags = tags => metadata => {
        metadata.tags = [...(metadata.tags ?? []), ...tags];
    };
    const removeTags = tags => metadata => {
        const folded = new Set(tags.map(tag => tag.toLocaleLowerCase()));
        metadata.tags = (metadata.tags ?? []).filter(tag => !folded.has(tag.toLocaleLowerCase()));
    };
    add.addEventListener('click', () => apply(addTags));
    remove.addEventListener('click', () => apply(removeTags));
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            apply(addTags);
        }
    });
    actions.append(add, remove);
    content.append(input, actions);
    openPopover({
        trigger,
        title: tr(ctx, 'Tags'),
        content,
        bounds: ui.dialog.surface,
        initialFocus: () => input,
    });
}

function buildActions(ctx, state, ui) {
    const anchor = id => ui.selectionBar.querySelector(`[data-action-id="${id}"]`);
    return [
        { id: 'favorite', label: tr(ctx, 'Favorite'), icon: 'fa-solid fa-star', onActivate: () => openFavoriteMenu(ctx, state, ui, anchor('favorite')) },
        { id: 'folder', label: `${tr(ctx, 'Folder')}…`, icon: 'fa-solid fa-folder', onActivate: () => openFolderMenu(ctx, state, ui, anchor('folder')) },
        { id: 'collections', label: `${tr(ctx, 'Collections')}…`, icon: 'fa-solid fa-layer-group', onActivate: () => openCollectionsMenu(ctx, state, ui, anchor('collections')) },
        { id: 'tags', label: `${tr(ctx, 'Tags')}…`, icon: 'fa-solid fa-tags', onActivate: () => openTagsPopover(ctx, state, ui, anchor('tags')) },
    ];
}

/**
 * Points the shared selection mode at the header and bar of the page that shows the list. It runs before
 * every entry because the list moves between the root frame and a pushed page when the layout collapses.
 */
function prepareSelection(ui, slots) {
    const handle = ui.listPage ?? ui.dialog;
    Object.assign(slots, {
        header: handle.header,
        headerStart: handle.headerStart,
        headerEnd: handle.headerEnd,
        titleNode: handle.titleNode,
        search: handle.search,
        closeButton: handle.closeButton,
        menuButton: handle.menuButton,
    });
    const host = ui.listPage ? ui.listPage.body : ui.dialog.body;
    if (ui.selectionBar.parentNode !== host) {
        host.append(ui.selectionBar);
    }
    return true;
}

/** Batch actions need a writable organization and at least one chat; the shared mode only checks the chat count. */
function syncActionBar(state, ui) {
    for (const action of ui.selectionBar.querySelectorAll('.sb-selection-action')) {
        action.disabled = !state.organizationWritable || ui.selection.count === 0;
    }
}

export function createArchiveSelection(ctx, state, ui) {
    const slots = {};
    // The shared mode hides its `header` element at creation. The real frame headers are passed through
    // `headerSlots`, so this detached element absorbs that hiding.
    const scratchHeader = document.createElement('div');
    return createSelectionMode({
        root: ui.dialog.surface,
        list: ui.list,
        rowSelector: '[data-sbca-key]',
        getKey: row => row.dataset.sbcaKey,
        range: true,
        getAllKeys: () => state.matchingRows.map(physicalChatKey),
        header: scratchHeader,
        headerSlots: slots,
        actionBar: ui.selectionBar,
        actions: buildActions(ctx, state, ui),
        title: count => selectionTitle(ctx, state, ui, count),
        canEnter: () => prepareSelection(ui, slots),
        onChange: () => {
            showCount(ui);
            syncActionBar(state, ui);
        },
        onExit: () => showCount(ui),
        iconOnlyAtNarrow: true,
    });
}

export function updateSelectionControls(ctx, state, ui) {
    if (!ui.selection?.isActive) {
        return;
    }
    ui.selection.decorate();
    syncActionBar(state, ui);
}

export function clearSelection(ui) {
    ui.selection?.clear();
}
