import { physicalChatKey } from '../core.js';
import { createEntryRow, createPrefGroup, createRow, releaseRowIds } from '../../../../sillybunny-editor/rows.js';
import { createSelectRow } from '../../../../sillybunny-editor/select-row.js';
import { appendOption, button, glyph, rowActionButton, tr } from './dom.js';
import { commaValues } from './filter-values.js';
import { markOrganizationControl, organizationFocusKey } from './focus.js';
import { commitChatMetadataChange } from './organization.js';
import { syncViewerFavoriteAction } from './viewer.js';

export function mutateSelectedChats(ctx, state, ui, mutation) {
    const keys = ui.selection?.selectedKeys ?? [];
    if (!state.organizationWritable || keys.length === 0) {
        return;
    }
    const chats = { ...state.organization.chats };
    for (const key of keys) {
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

function comboRow(ui, { label, field, options, value, noneLabel, emptyText, focusKey, onChange }) {
    const select = document.createElement('select');
    for (const [optionValue, text, hidden] of options) {
        appendOption(select, optionValue, text).hidden = Boolean(hidden);
    }
    select.value = value;
    const row = createSelectRow({ select, label, field, noneLabel, emptyText, bounds: ui.dialog.surface, onChange });
    markOrganizationControl(select);
    markOrganizationControl(row.trigger, focusKey);
    return row;
}

function removableRow({ label, field, icon, removeLabel, focusKey, fallbackKey, onRemove }) {
    const remove = rowActionButton(removeLabel, 'xmark');
    markOrganizationControl(remove, focusKey, fallbackKey);
    remove.addEventListener('click', onRemove);
    return createRow({ label, field, prefix: glyph(icon), suffix: remove }).row;
}

export function buildOrganizeGroup(ctx, state, row, ui) {
    const key = physicalChatKey(row);
    const metadata = state.organization?.chats?.[key] ?? {};
    const mutate = mutation => mutateChatMetadata(ctx, state, ui, row, mutation);
    const focusKey = (...parts) => organizationFocusKey('organizer', key, ...parts);
    const tagInputKey = focusKey('tag-input');
    const folders = state.organization?.folders ?? [];
    const collections = state.organization?.collections ?? [];
    const attached = new Set(metadata.collections ?? []);

    const folderRow = comboRow(ui, {
        label: tr(ctx, 'Folder'),
        field: 'folder',
        options: [['', tr(ctx, 'Unfiled')], ...folders.map(folder => [folder.id, folder.name])],
        value: metadata.folder ?? '',
        noneLabel: tr(ctx, 'Unfiled'),
        focusKey: focusKey('folder'),
        onChange: value => mutate(next => {
            if (value) {
                next.folder = value;
            } else {
                delete next.folder;
            }
        }),
    });

    const collectionRow = comboRow(ui, {
        label: tr(ctx, 'Collections'),
        field: 'collections',
        options: [
            ['', tr(ctx, 'Add collection'), true],
            ...collections.filter(collection => !attached.has(collection.id)).map(collection => [collection.id, collection.name]),
        ],
        value: '',
        emptyText: tr(ctx, 'None yet.'),
        focusKey: focusKey('collection'),
        onChange: value => {
            if (value) {
                mutate(next => {
                    next.collections = [...new Set([...(next.collections ?? []), value])];
                });
            }
        },
    });
    const collectionRows = collections.filter(collection => attached.has(collection.id)).map(collection => removableRow({
        label: collection.name,
        field: `collection-${collection.id}`,
        icon: 'layer-group',
        removeLabel: tr(ctx, 'Remove Collection {name}', { name: collection.name }),
        focusKey: focusKey('collection', collection.id),
        fallbackKey: focusKey('collection'),
        onRemove: () => mutate(next => {
            next.collections = (next.collections ?? []).filter(id => id !== collection.id);
        }),
    }));

    const tagInput = document.createElement('input');
    const tagAdd = button('menu_button', tr(ctx, 'Add Tags'));
    markOrganizationControl(tagInput, tagInputKey);
    markOrganizationControl(tagAdd, focusKey('tag-add'), tagInputKey);
    const addTags = () => {
        const values = commaValues(tagInput.value);
        if (values.length > 0) {
            mutate(next => {
                next.tags = [...(next.tags ?? []), ...values];
            });
        }
    };
    tagAdd.addEventListener('click', addTags);
    tagInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            addTags();
        }
    });
    const tagEntry = createEntryRow({
        label: tr(ctx, 'Tags'),
        field: 'tags',
        floating: true,
        placeholder: tr(ctx, 'Add tags (comma-separated)'),
        suffix: tagAdd,
        input: tagInput,
    });
    const tagRows = (metadata.tags ?? []).map(tag => removableRow({
        label: tag,
        field: `tag-${tag}`,
        icon: 'tag',
        removeLabel: tr(ctx, 'Remove Tag {name}', { name: tag }),
        focusKey: focusKey('tag', tag),
        fallbackKey: tagInputKey,
        onRemove: () => mutate(next => {
            next.tags = (next.tags ?? []).filter(name => name.toLocaleLowerCase() !== tag.toLocaleLowerCase());
        }),
    }));

    const group = createPrefGroup({
        title: tr(ctx, 'Organize Chat'),
        field: 'organize',
        rows: [folderRow, collectionRow, ...collectionRows, tagEntry, ...tagRows],
    });
    group.section.classList.add('sbca-organize');
    for (const control of group.section.querySelectorAll('[data-sbca-organization-control]')) {
        control.disabled = !state.organizationWritable;
    }
    return group;
}

export function mutateChatMetadata(ctx, state, ui, row, mutation) {
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

export function refreshOpenOrganizer(ctx, state, ui) {
    if (!state.selectedRow) {
        return;
    }
    const current = ui.viewerContent.querySelector('.sbca-organize');
    if (current) {
        const next = buildOrganizeGroup(ctx, state, state.selectedRow, ui);
        releaseRowIds(current);
        current.replaceWith(next.section);
    }
    const favoriteAction = ui.viewerContent.querySelector('.sbca-favorite-action');
    if (favoriteAction) {
        syncViewerFavoriteAction(state, state.selectedRow, favoriteAction);
    }
}
