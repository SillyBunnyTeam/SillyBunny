import { physicalChatKey } from '../core.js';
import {
    appendOption,
    button,
    el,
    inputControl,
    selectControl,
    tr,
} from './dom.js';
import { commaValues } from './filter-values.js';
import { markOrganizationControl, organizationFocusKey } from './focus.js';
import { commitChatMetadataChange } from './organization.js';
import { nextRenderId } from './render-id.js';
import { syncViewerFavoriteAction } from './viewer.js';

export function mutateSelectedChats(ctx, state, ui, mutation) {
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

export function buildChatOrganizer(ctx, state, row, ui) {
    const organizer = el('section', 'sbca-organizer');
    organizer.append(el('h5', 'sbca-organizer-heading', tr(ctx, 'Organize chat')));
    const key = physicalChatKey(row);
    const tagInputKey = organizationFocusKey('organizer', key, 'tag-input');
    const metadata = state.organization?.chats?.[key] ?? {};

    const folderField = selectControl(ctx, 'Folder', [['', 'Unfiled']]);
    const folderLabel = folderField.wrap.querySelector('.sbca-label');
    folderLabel.classList.add('sbca-organizer-section-title');
    folderLabel.id = `sbca_organizer_folder_${nextRenderId()}`;
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

    const collectionsField = selectControl(ctx, 'Collections', [['', 'Collections']]);
    const collectionsLabel = collectionsField.wrap.querySelector('.sbca-label');
    collectionsLabel.classList.add('sbca-organizer-section-title');
    collectionsLabel.id = `sbca_organizer_collections_${nextRenderId()}`;
    const collections = el('div', 'sbca-organizer-collections');
    collections.setAttribute('role', 'group');
    collections.setAttribute('aria-labelledby', collectionsLabel.id);
    const selectedCollections = new Set(metadata.collections ?? []);
    for (const collection of state.organization?.collections ?? []) {
        appendOption(collectionsField.select, collection.id, collection.name);
    }
    collectionsField.select.value = '';
    markOrganizationControl(collectionsField.select, organizationFocusKey('organizer', key, 'collection'));
    collectionsField.select.addEventListener('change', () => mutateChatMetadata(ctx, state, ui, row, value => {
        value.collections = [...new Set([...(value.collections ?? []), collectionsField.select.value])].filter(Boolean);
    }));
    collections.append(collectionsField.wrap);
    const collectionList = el('div', 'sbca-tag-list sbca-collection-list');
    for (const collection of state.organization?.collections ?? []) {
        if (!selectedCollections.has(collection.id)) {
            continue;
        }
        const item = el('span', 'sbca-tag-item sbca-collection-item');
        const remove = button('sbca-control sbca-tag-remove', tr(ctx, 'Remove'));
        remove.setAttribute('aria-label', tr(ctx, 'Remove collection {name}', { name: collection.name }));
        remove.title = collection.name;
        markOrganizationControl(remove, organizationFocusKey('organizer', key, 'collection', collection.id));
        remove.addEventListener('click', () => mutateChatMetadata(ctx, state, ui, row, value => {
            value.collections = (value.collections ?? []).filter(id => id !== collection.id);
        }));
        item.append(el('span', 'sbca-tag-text', collection.name), remove);
        collectionList.append(item);
    }
    collections.append(collectionList);

    const tags = el('div', 'sbca-organizer-tags');
    const tagsLabel = el('span', 'sbca-label', tr(ctx, 'Tags'));
    tagsLabel.classList.add('sbca-organizer-section-title');
    tagsLabel.id = `sbca_organizer_tags_${nextRenderId()}`;
    tags.setAttribute('role', 'group');
    tags.setAttribute('aria-labelledby', tagsLabel.id);
    tags.append(tagsLabel);
    const tagList = el('div', 'sbca-tag-list');
    for (const tag of metadata.tags ?? []) {
        const item = el('span', 'sbca-tag-item');
        const remove = button('sbca-control sbca-tag-remove', tr(ctx, 'Remove'));
        remove.setAttribute('aria-label', tr(ctx, 'Remove tag {name}', { name: tag }));
        markOrganizationControl(remove, organizationFocusKey('organizer', key, 'tag', tag), tagInputKey);
        remove.addEventListener('click', () => mutateChatMetadata(ctx, state, ui, row, value => {
            value.tags = (value.tags ?? []).filter(name => name.toLocaleLowerCase() !== tag.toLocaleLowerCase());
        }));
        item.append(el('span', 'sbca-tag-text', tag), remove);
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
    const folder = el('div', 'sbca-organizer-folder');
    folder.setAttribute('role', 'group');
    folder.setAttribute('aria-labelledby', folderLabel.id);
    folder.append(folderField.wrap);
    organizer.append(folder, collections, tags);
    for (const control of organizer.querySelectorAll('[data-sbca-organization-control]')) {
        control.disabled = !state.organizationWritable;
    }
    return organizer;
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
    const current = ui.viewerContent.querySelector('.sbca-organizer');
    if (current) {
        current.replaceWith(buildChatOrganizer(ctx, state, state.selectedRow, ui));
    }
    const favoriteAction = ui.viewerContent.querySelector('.sbca-favorite-action');
    if (favoriteAction) {
        syncViewerFavoriteAction(state, state.selectedRow, favoriteAction);
    }
}
