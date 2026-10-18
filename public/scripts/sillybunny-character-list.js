import { power_user } from './power-user.js';
import { t } from './i18n.js';
import { openActionMenu } from './sillybunny-action-menu.js';
import { createEntityRow, entityKey, entityRowMotionKey, limitTagChips } from './sillybunny-editor/entity-row.js';
import { createListHeader } from './sillybunny-editor/list-header.js';
import { createListPagination } from './sillybunny-editor/list-pagination.js';
import { reconcileRows, bindListKeyboard, rowEntry } from './sillybunny-editor/list-rows.js';
import { createListSearch } from './sillybunny-editor/list-search.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { createSelectionMode } from './sillybunny-editor/selection-mode.js';
import { attachTagFilterMenu } from './sillybunny-editor/tag-filter-menu.js';
import { closePicker, isPickerOpen } from './sillybunny-editor/picker.js';
import { objectNavigation } from './sillybunny-editor/object-navigation.js';
import { eventSource, event_types } from './events.js';
import { animateListChange, stopMotion } from './sillybunny-motion.js';

const CHARACTER_LIST_STYLESHEETS = Object.freeze([
    { href: 'css/sillybunny-entity-list.css?v=20261018a', id: 'deferred-entity-list-css' },
    { href: 'css/sillybunny-editor-shell.css?v=20261018b', id: 'deferred-editor-shell-css' },
    { href: 'css/sillybunny-character-list.css?v=20261018d', id: 'deferred-character-list-css' },
]);
const PAGE_SIZES = Object.freeze([10, 25, 50, 100, 250, 500, 1000]);
const mountedLists = new WeakMap();
const mountingLists = new WeakMap();
const rowFactories = new WeakMap();
const rowPresentations = new WeakMap();
const pendingListRestores = new Map();

/** Supplies a route's snapshot before shell activation renders the list. */
export function prepareCharacterListRestore(view, snapshot, isCurrent = () => true) {
    if (!['characters', 'groups'].includes(view)) throw new TypeError(`Invalid character list view: ${view}`);
    const request = { snapshot, isCurrent };
    pendingListRestores.set(view, request);
    return () => {
        if (pendingListRestores.get(view) === request) pendingListRestores.delete(view);
    };
}

let scriptModulePromise;
let groupModulePromise;
let stateModulePromise;
let tagModulePromise;

function loadScriptModule() {
    scriptModulePromise ??= import('../script.js');
    return scriptModulePromise;
}

function loadGroupModule() {
    groupModulePromise ??= import('./group-chats.js');
    return groupModulePromise;
}

function loadStateModule() {
    stateModulePromise ??= import('./sillybunny-character-list-state.js');
    return stateModulePromise;
}

function loadTagModule() {
    tagModulePromise ??= import('./tags.js');
    return tagModulePromise;
}

function thumbnailUrl(script, avatar) {
    const value = textValue(avatar);
    if (!value) return '';
    return script.getThumbnailUrlForViewport?.('avatar', value) ?? value;
}

function node(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
}

function icon(name) {
    const element = node('i', `fa-solid fa-${name}`);
    element.setAttribute('aria-hidden', 'true');
    return element;
}

function run(action) {
    Promise.resolve().then(action).catch(error => globalThis.toastr?.error(error?.message ?? String(error)));
}

function actionButton(label, glyph, action) {
    const button = node('button', 'ds-entity-row__button');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.append(icon(glyph));
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        run(() => action(button));
    });
    // The upstream Enter handler walks past native buttons to their compat row.
    button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
    });
    return button;
}

function valueFrom(data, item, ...keys) {
    for (const key of keys) {
        if (data?.[key] !== undefined && data?.[key] !== null) return data[key];
        if (item?.[key] !== undefined && item?.[key] !== null) return item[key];
    }
    return undefined;
}

function textValue(value) {
    return value === undefined || value === null ? '' : String(value);
}

function isFavorite(value) {
    return value === true || value === 1 || value === 'true';
}

function setActiveState(row, active) {
    row.classList.toggle('is-active-entity', Boolean(active));
    row.classList.toggle('is-selected', Boolean(active));
    if (active) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
}

function makeBadge(glyph, className, label) {
    const badge = node('span', className);
    if (glyph) badge.append(icon(glyph));
    if (label) badge.append(document.createTextNode(label));
    return badge;
}

function buildSubtitle(data, item) {
    const parts = [];
    const aux = textValue(valueFrom(data, item, 'auxFieldValue', 'characterVersion'));
    const notes = textValue(valueFrom(data, item, 'creatorNotes', 'description'));
    const avatarFileName = valueFrom(data, item, 'avatarFileName', 'avatar');
    const showAvatar = Boolean(valueFrom(data, item, 'showCardAvatarUrls'));
    const values = [
        node('span', 'character_version', aux),
        node('span', 'ch_description', notes),
        showAvatar && avatarFileName ? node('span', 'ch_avatar_url', textValue(avatarFileName)) : null,
    ].filter(Boolean);
    let hasVisiblePart = false;
    values.forEach(value => {
        value.hidden = !value.textContent;
        if (!value.hidden && hasVisiblePart) parts.push(document.createTextNode(' · '));
        if (!value.hidden) hasVisiblePart = true;
        parts.push(value);
    });
    return parts;
}

function groupSubtitle(data, item) {
    const names = valueFrom(data, item, 'memberNamesText');
    return names ? [node('span', 'group_select_block_list ch_description', textValue(names))] : [];
}

function rowTags(row, key, data, tags) {
    const tagSlot = row.slots?.tags ?? row.querySelector('.ds-entity-row__tags');
    if (!tagSlot) return;
    const printTagList = tags?.printTagList;
    tagSlot.replaceChildren();
    if (typeof printTagList === 'function' && typeof globalThis.$ === 'function') {
        printTagList(globalThis.$(tagSlot), {
            forEntityOrKey: key,
            tagOptions: { isCharacterList: true },
        });
    } else {
        const names = Array.isArray(data?.tags) ? data.tags : [];
        for (const tag of names) {
            const chip = node('span', 'tag');
            chip.append(node('span', 'tag_name', typeof tag === 'string' ? tag : textValue(tag.name)));
            tagSlot.append(chip);
        }
    }
    const allNames = Array.isArray(data?.tags)
        ? data.tags.map(tag => typeof tag === 'string' ? tag : textValue(tag?.name)).filter(Boolean)
        : typeof tags?.getTagsList === 'function'
            ? tags.getTagsList(key).filter(tag => !tag.is_hidden_on_character_card).map(tag => tag.name)
            : [...tagSlot.querySelectorAll('.tag:not(.placeholder-expander)')]
                .map(tag => tag.querySelector('.tag_name')?.textContent ?? tag.textContent ?? '')
                .map(name => name.trim())
                .filter(Boolean);
    limitTagChips(tagSlot, { allNames });
}

function createFolderAvatar(item) {
    const folderIcon = item?.folder_type === 'BACK'
        ? icon('right-from-bracket')
        : icon(item?.folder_type === 'OPEN' ? 'folder-open' : item?.folder_type === 'CLOSED' ? 'eye-slash' : 'folder');
    if (item?.folder_type === 'BACK') folderIcon.classList.add('fa-flip-horizontal');
    folderIcon.classList.add('bogus_folder_icon');
    return folderIcon;
}

function createBackEntry(script) {
    const template = script.getBackBlock?.();
    const legacy = template?.[0] ?? template;
    return {
        kind: 'back',
        key: entityKey('tag', 'back'),
        item: {
            name: legacy?.querySelector?.('.ch_name')?.textContent?.trim() || t`Go back`,
            avatar: legacy?.querySelector?.('.bogus_folder_icon')?.cloneNode(true) ?? createFolderAvatar({ folder_type: 'BACK' }),
        },
    };
}

async function createHiddenEntry(count, script) {
    const template = await script.getHiddenBlock?.(count);
    const legacy = template?.[0] ?? template;
    return {
        kind: 'hidden',
        key: 'status:hidden',
        item: { name: legacy?.textContent?.trim() || textValue(count) },
    };
}

function createFolderEntry(entity, tags) {
    const item = entity.item ?? {};
    const template = tags.getTagBlock?.(item, entity.entities ?? [], entity.hidden ?? 0, entity.isUseless ?? false);
    const legacy = template?.[0] ?? template;
    return {
        kind: 'tag',
        key: entityKey('tag', entity.id),
        entity,
        item,
        label: legacy?.querySelector?.('.ch_name')?.textContent?.trim() || textValue(item.name),
        avatar: legacy?.querySelector?.('.bogus_folder_icon')?.cloneNode(true) ?? createFolderAvatar(item),
        folderClasses: legacy ? [...legacy.classList].filter(className => !['bogus_folder_select', 'entity_block'].includes(className)) : [],
        subtitle: [legacy?.querySelector?.('.bogus_folder_counter'), legacy?.querySelector?.('.bogus_folder_hidden_counter')]
            .filter(Boolean)
            .map(element => element.cloneNode(true)),
    };
}

function normalizeEntry(entity, view, dataModules) {
    if (entity.type === 'tag') return createFolderEntry(entity, dataModules.tags);
    const item = entity.item ?? entity;
    if (entity.type === 'group' || view === 'groups') {
        const data = dataModules.script.getGroupRowData?.(item) ?? item;
        const avatar = dataModules.groups.getGroupAvatarElement(item);
        avatar?.querySelectorAll('img').forEach(image => {
            image.setAttribute('loading', 'lazy');
            image.setAttribute('decoding', 'async');
            if (!image.hasAttribute('alt')) image.alt = '';
        });
        return {
            kind: 'group',
            key: entityKey('group', data.id ?? entity.id),
            entity,
            item,
            data,
            label: textValue(data.name ?? item.name),
            subtitle: groupSubtitle(data, item),
            favorite: isFavorite(valueFrom(data, item, 'favorite', 'fav')),
            active: Boolean(valueFrom(data, item, 'active', 'isActive')),
            avatar,
        };
    }
    const data = dataModules.script.getCharacterRowData?.(item, entity.id) ?? item;
    return {
        kind: 'character',
        key: entityKey('character', valueFrom(data, item, 'avatar') ?? entity.id),
        entity,
        item,
        data,
        label: textValue(data.name ?? item.name),
        subtitle: buildSubtitle(data, item),
        favorite: isFavorite(valueFrom(data, item, 'favorite', 'fav')),
        active: Boolean(valueFrom(data, item, 'active', 'isActive')),
        avatar: {
            src: textValue(valueFrom(data, item, 'avatarUrl')) || thumbnailUrl(dataModules.script, valueFrom(data, item, 'avatar')),
            alt: textValue(data.name ?? item.name),
        },
    };
}

function rowOptions(entry) {
    if (entry.kind === 'back') {
        return {
            key: entry.key,
            label: entry.item.name,
            title: entry.item.name,
            avatar: entry.item.avatar ?? createFolderAvatar({ folder_type: 'BACK' }),
            activation: 'navigate',
            compatClasses: { row: ['bogus_folder_select', 'bogus_folder_select_back', 'entity_block'], avatar: ['avatar'], title: ['ch_name'] },
            attributes: { tagid: 'back', id: 'BogusFolderBack' },
        };
    }
    if (entry.kind === 'hidden') {
        return {
            key: entry.key,
            label: entry.item.name,
            title: entry.item.name,
            compatClasses: { row: ['entity_block'] },
            attributes: { 'aria-hidden': 'true' },
        };
    }
    if (entry.kind === 'tag') {
        const item = entry.item;
        const folderClass = item.folder_type ? String(item.folder_type).toLowerCase() : '';
        return {
            key: entry.key,
            label: entry.label,
            title: entry.label,
            subtitle: entry.subtitle,
            avatar: entry.avatar ?? createFolderAvatar(item),
            activation: 'navigate',
            compatClasses: {
                row: ['bogus_folder_select', 'entity_block', folderClass, ...(entry.folderClasses ?? [])].filter(Boolean),
                avatar: ['avatar'],
                title: ['ch_name'],
                subtitle: ['character_name_block_sub_line'],
            },
            attributes: { tagid: textValue(entry.entity.id), id: `BogusFolder${entry.entity.id}` },
        };
    }

    const { data, item } = entry;
    const badges = [];
    if (entry.favorite) {
        const favorite = makeBadge('star', 'ch_fav_icon');
        favorite.title = t`Favorites`;
        favorite.setAttribute('aria-label', favorite.title);
        badges.push(favorite);
    }
    if (entry.kind === 'character' && Boolean(valueFrom(data, item, 'assistant', 'isAssistant'))) {
        const assistant = makeBadge('user-graduate', 'ch_assistant');
        assistant.title = t`This character will be used as a welcome page assistant.`;
        badges.push(assistant);
    }
    if (entry.kind === 'group') {
        badges.push(node('span', 'group_select_counter', textValue(data.memberCountText ?? data.memberCount ?? '')));
    }
    return {
        key: entry.key,
        label: entry.label,
        title: entry.label,
        subtitle: entry.subtitle,
        avatar: entry.avatar,
        tags: true,
        badges,
        activation: 'activate',
        compatClasses: {
            row: [entry.kind === 'group' ? 'group_select' : 'character_select', 'entity_block'],
            avatar: ['avatar'],
            title: ['ch_name'],
            subtitle: entry.kind === 'group' ? ['group_select_block_list', 'ch_description'] : [],
            tags: ['tags', 'tags_inline'],
        },
        attributes: entry.kind === 'group'
            ? { 'data-grid': textValue(data.id ?? item.id), grid: textValue(data.id ?? item.id) }
            : {
                'data-chid': textValue(data.chid ?? data.id ?? entry.entity.id),
                chid: textValue(data.chid ?? data.id ?? entry.entity.id),
                id: `CharID${data.chid ?? data.id ?? entry.entity.id}`,
            },
    };
}

function createRowEntry(entry, actionHandlers) {
    const factory = createEntityRow(rowOptions(entry));
    const { row } = factory;
    rowFactories.set(row, factory);
    if (entry.kind !== 'character' && entry.kind !== 'group') return row;
    factory.update({ suffix: [
        actionButton(t`Edit`, 'pen', () => actionHandlers.edit(rowEntry(row))),
        actionButton(t`Actions for ${entry.label}`, 'ellipsis-vertical', trigger => actionHandlers.menu(trigger, rowEntry(row))),
    ] });
    const favoriteInput = node('input', 'ch_fav');
    favoriteInput.type = 'hidden';
    row.append(favoriteInput);
    const indicator = node('span', 'sb-character-list__active-dot');
    indicator.setAttribute('aria-hidden', 'true');
    row.append(indicator);
    return row;
}

function updateRow(row, entry, dependencies, visible) {
    const factory = rowFactories.get(row);
    const tagKey = entry.kind === 'group' ? entry.data?.id ?? entry.item.id : entry.data?.avatar ?? entry.item.avatar;
    const tags = dependencies.tags.getTagsList?.(tagKey) ?? entry.data?.tags ?? [];
    const presentation = Object.fromEntries(Object.entries(entry.data ?? {}).filter(([key]) => key !== 'active' && key !== 'isActive'));
    const tagPresentation = tags.map(tag => typeof tag === 'string' ? tag : Object.fromEntries(Object.entries(tag).filter(([key]) => key !== 'filter_state')));
    const actionLabels = entry.kind === 'character' || entry.kind === 'group'
        ? [t`Edit`, t`Actions for ${entry.label}`] : null;
    const signature = JSON.stringify([
        entry.kind, entry.label ?? entry.item.name, presentation, tagPresentation, actionLabels,
        entry.item?.folder_type, entry.folderClasses, entry.subtitle?.map(part => part.textContent),
        entry.kind === 'tag' ? entry.avatar?.outerHTML : null,
        entry.kind === 'group' ? [...(entry.avatar?.querySelectorAll('img') ?? [])].map(image => image.getAttribute('src')) : null,
    ]);
    const changed = rowPresentations.get(row) !== signature;
    if (changed) {
        const indicator = row.querySelector('.sb-character-list__active-dot');
        factory.update(rowOptions(entry));
        if (indicator) factory.slots.title.prepend(indicator);
        if (actionLabels) {
            if (factory.slots.avatar) factory.slots.avatar.title = textValue(entry.data.avatarTitle);
            factory.slots.title.title = textValue(entry.data.nameTitle);
            const edit = factory.slots.suffix.firstElementChild;
            edit.title = actionLabels[0];
            edit.setAttribute('aria-label', edit.title);
            const more = factory.slots.suffix.lastElementChild;
            more.title = actionLabels[1];
            more.setAttribute('aria-label', more.title);
        }
        rowPresentations.set(row, signature);
    }
    if (entry.kind === 'character' || entry.kind === 'group') {
        if (visible) setActiveState(row, entry.active);
        row.classList.toggle('is_fav', entry.favorite);
        const favoriteInput = row.querySelector('.ch_fav');
        if (favoriteInput instanceof HTMLInputElement) favoriteInput.value = textValue(valueFrom(entry.data, entry.item, 'fav', 'favorite'));
        if (changed) rowTags(row, tagKey, entry.data, dependencies.tags);
    }
}

function getHiddenCount(model) {
    if (Number.isFinite(model.hidden)) return Math.max(0, model.hidden);
    const renderedEntities = model.entities.filter(entity => entity.type !== 'tag').length;
    return Math.max(0, Number(model.sourceCount) - renderedEntities);
}

function makeMenuItem(label, glyph, onSelect, options = {}) {
    return { label, icon: `fa-solid fa-${glyph}`, onSelect: () => run(onSelect), ...options };
}

function clickTransport(selector) {
    document.querySelector(selector)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function modelCount(model) {
    return model.entities.filter(entity => entity.type !== 'tag').length;
}

async function loadStylesheets(stylesheets) {
    const loader = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    if (!loader) return;
    await Promise.all(stylesheets.map(async ({ href, id }) => {
        let link = document.getElementById(id);
        try {
            const loading = loader(href, { id });
            link = document.getElementById(id);
            await loading;
        } catch (error) {
            if (link instanceof HTMLLinkElement && document.getElementById(id) === link) link.remove();
            throw error;
        }
    }));
}

/**
 * Loads the deferred styles needed by the Characters and Groups list.
 * @param {{ href: string, id: string }[]} [stylesheets]
 * @returns {Promise<void>}
 */
export async function loadCharacterListStyles(stylesheets = CHARACTER_LIST_STYLESHEETS) {
    await loadStylesheets(stylesheets);
}

function createCharacterListController(container, dependencies, restoreDOM) {
    const rowsContainer = document.getElementById('rm_print_characters_block');
    if (!(rowsContainer instanceof HTMLElement)) throw new Error('Character list rows container is missing.');
    const section = node('section', 'sb-character-list');
    section.dataset.view = 'characters';
    section.setAttribute('aria-busy', 'true');
    const loading = createStatusPage({ icon: 'spinner fa-spin', title: t`Loading...`, compact: true });
    const status = node('div', 'sb-character-list__status');
    status.append(loading.element);

    const searchField = node('label', 'sb-character-list__search');
    searchField.hidden = true;
    const searchInput = document.getElementById('character_search_bar');
    if (!(searchInput instanceof HTMLInputElement)) throw new Error('Character search input is missing.');
    searchField.append(icon('magnifying-glass'), searchInput);
    searchInput.setAttribute('aria-label', t`Search`);
    const filters = document.querySelector('#rm_characters_block #charListFixedTop > .rm_tag_controls');
    if (!(filters instanceof HTMLElement)) throw new Error('Character list filters are missing.');
    filters.classList.add('ds-tag-filter');
    const filterRow = node('div', 'sb-character-list__filters');
    filterRow.append(filters);
    const tagMenu = attachTagFilterMenu(filters);
    const box = node('div', 'ds-entity-list sb-character-list__box');
    const overlay = dependencies.script.characterGroupOverlay;
    overlay.setLegacyRowSelectionEnabled(false);
    rowsContainer.replaceChildren();
    rowsContainer.classList.add('ds-entity-list__rows', 'sb-character-list__rows');
    rowsContainer.setAttribute('role', 'list');
    const footer = node('div', 'ds-entity-list__footer');
    const selectionHeader = node('header', 'sb-character-list__selection-header');
    const selectionBar = node('div', 'sb-character-list__selection-bar');
    box.append(rowsContainer, footer, selectionBar);
    const transport = document.getElementById('rm_print_characters_pagination');

    const state = {
        view: 'characters',
        rows: new Map(),
        lastQuery: '',
        pageSync: 0,
        selectableKeys: [],
    };
    let header;
    let search;
    let pagination;
    let overflowed = new Set();
    let resizeObserver;
    let extensionObserver;
    const dataModules = dependencies;
    let typingUntil = 0;
    let paginationView = state.view;
    let renderRevision = 0;
    let suppressedStateRenders = 0;
    let handlingSearchInput = false;
    let unbindKeyboard;
    let destroyed = false;
    let selection;
    let selectionActive = false;
    let bulkBusy = false;
    let switchingView = false;
    let pendingActivation = null;
    let listVisible = false;
    let visibilityObserver;
    let preserveRestoredScroll = false;
    let revealActiveOnRender = false;
    const headerWidths = new Map();
    let headerWidth = 0;
    let firstRenderComplete = false;
    let firstRevealFrame = 0;
    let headerGap = 0;
    let extensionSlot;
    let extensionItems = new Set();
    let extensionGap = 0;
    let extensionInsets = 0;
    let extensionMargin = 0;

    const menu = (trigger, title, sections) => openActionMenu({ trigger, title, sections, onClose: () => trigger.setAttribute('aria-expanded', 'false') });
    function refresh() {
        if (suppressedStateRenders || destroyed) return;
        return dataModules.script.printCharacters(false);
    }

    function decorateSelection() {
        const active = Boolean(selection?.isActive);
        if (active !== selectionActive) {
            selectionActive = active;
            if (active) {
                closeTagPicker();
                cancelActivation();
            }
            run(() => overlay.notifySharedSelectionState(active ? 'select' : 'browse'));
        }
        selection?.decorate();
        for (const row of rowsContainer.querySelectorAll('.ds-entity-row')) {
            if (listVisible) row.classList.toggle('is-selected', !active && Boolean(rowEntry(row)?.active));
            for (const control of row.querySelectorAll('.ds-entity-row__suffix')) control.inert = active;
            if (row.matches('.bogus_folder_select')) {
                row.inert = active;
                if (active) row.setAttribute('aria-disabled', 'true');
                else row.removeAttribute('aria-disabled');
            }
        }
    }

    function closeTagPicker() {
        const trigger = filters.querySelector('.sb-tag-filter-menu-button');
        if (trigger && isPickerOpen(trigger)) closePicker({ animate: false, restoreFocus: false });
    }

    function syncActiveRows() {
        if (destroyed || !listVisible) return;
        for (const { row } of state.rows.values()) {
            const entry = rowEntry(row);
            if (entry.kind !== 'character' && entry.kind !== 'group') continue;
            const data = entry.kind === 'group'
                ? dataModules.script.getGroupRowData(entry.item)
                : dataModules.script.getCharacterRowData(entry.item, entry.entity.id);
            entry.active = Boolean(data.active ?? data.isActive);
            setActiveState(row, entry.active);
        }
        decorateSelection();
    }

    function cancelActivation() {
        const activation = pendingActivation;
        pendingActivation = null;
        if (activation) stopMotion(activation.row);
    }

    function syncListVisibility() {
        const visible = !section.closest('[hidden], [aria-hidden="true"]') && section.getClientRects().length > 0;
        if (visible === listVisible) return;
        listVisible = visible;
        if (!visible) {
            if (!pendingActivation?.dismissed) cancelActivation();
            return;
        }
        syncActiveRows();
        if (!preserveRestoredScroll) scrollToActiveRow();
    }

    function scrollToActiveRow() {
        rowsContainer.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
    }

    /** Reveals the current chat after shell mounting; editor Back restores its own origin instead. */
    async function revealActiveEntity(isCurrent = () => true) {
        const view = dataModules.state.getCharacterListView();
        const requestedRestore = pendingListRestores.get(view);
        pendingListRestores.delete(view);
        const restore = requestedRestore?.isCurrent() ? requestedRestore : null;
        const generation = dependencies.getNavigationGeneration();
        const isRevealCurrent = () => !destroyed && isCurrent() && (!restore || restore.isCurrent())
            && dependencies.getNavigationGeneration() === generation;
        if (!isRevealCurrent()) return;
        if (restore) await applyRestoreSnapshot(restore.snapshot, view);
        if (!isRevealCurrent()) return;
        revealActiveOnRender = !restore && !preserveRestoredScroll;
        try {
            await dataModules.script.printCharacters(false);
        } finally {
            revealActiveOnRender = false;
        }
        if (!isRevealCurrent()) return;
        section.hidden = false;
        syncListVisibility();
        syncActiveRows();
        if (restore) await finishRestoreSnapshot(restore.snapshot, isRevealCurrent);
        if (!isRevealCurrent()) return;
        if (!preserveRestoredScroll && !selection.isActive) scrollToActiveRow();
        preserveRestoredScroll = false;
    }

    async function activateChat(row, entry) {
        if (pendingActivation || destroyed || selection.isActive) return;
        const activation = {
            row, view: state.view, dismissed: false, snapshot: captureState(), generation: dependencies.getNavigationGeneration(),
        };
        pendingActivation = activation;
        row.classList.add('is-activating-entity');
        const onAccepted = () => {
            if (pendingActivation !== activation || destroyed || selection.isActive || activation.dismissed
                || dependencies.getNavigationGeneration() !== activation.generation) return;
            // The shell also uses pinnedOpen for layout; only the user's pin prevents dismissal.
            if (document.getElementById('rm_button_panel_pin')?.checked) return;
            activation.dismissed = true;
            section.hidden = true;
            globalThis.SillyBunnyShell?.closeCharacters?.();
            activation.generation = dependencies.getNavigationGeneration();
        };
        const reopen = async () => {
            const isRecoveryCurrent = () => pendingActivation === activation && !destroyed
                && dependencies.getNavigationGeneration() === activation.generation;
            if (!activation.dismissed || !isRecoveryCurrent()) return;
            const cancelRestore = prepareCharacterListRestore(activation.view, { ...activation.snapshot, focusKey: entry.key }, isRecoveryCurrent);
            try {
                const opening = globalThis.SillyBunnyShell?.openTab?.('characters', activation.view);
                // The recovery itself synchronously advances the shell generation.
                activation.generation = dependencies.getNavigationGeneration();
                await opening;
            } finally {
                cancelRestore();
            }
        };
        try {
            const selected = entry.kind === 'group'
                ? await dataModules.groups.openGroupById(String(entry.data.id ?? entry.item.id), { switchMenu: false, onAccepted })
                : await dataModules.script.selectCharacterById(Number(entry.data.chid ?? entry.entity.id), { switchMenu: false, onAccepted });
            if (!selected) {
                await reopen();
                return;
            }
            if (pendingActivation !== activation || destroyed || selection.isActive || state.view !== activation.view) return;
            syncActiveRows();
        } catch (error) {
            await reopen();
            throw error;
        } finally {
            row.classList.remove('is-activating-entity');
            if (pendingActivation === activation) pendingActivation = null;
        }
    }

    function selectionIdsByKey() {
        const entries = state.view === 'groups'
            ? dataModules.groups.groups.map(group => [entityKey('group', group.id), String(group.id)])
            : dataModules.script.characters.flatMap((character, index) => character?.avatar ? [[entityKey('character', character.avatar), index]] : []);
        return new Map(entries);
    }

    async function bulkAction(action) {
        if (bulkBusy) return;
        const idsByKey = selectionIdsByKey();
        const keys = selection.selectedKeys.filter(key => idsByKey.has(key));
        selection.select(keys);
        if (!keys.length) return;
        const currentSelection = selection;
        bulkBusy = true;
        selectionBar.inert = true;
        selectionBar.setAttribute('aria-busy', 'true');
        try {
            await overlay.runBulkAction(action, keys.map(key => idsByKey.get(key)));
            if (!destroyed && selection === currentSelection) selection.exit();
        } finally {
            bulkBusy = false;
            selectionBar.inert = false;
            selectionBar.removeAttribute('aria-busy');
        }
    }

    function createSelection() {
        const action = (id, label, glyph, danger = false) => ({
            id, label, icon: `fa-solid fa-${glyph}`, danger, onActivate: () => run(() => bulkAction(id)),
        });
        const actions = state.view === 'groups'
            ? [action('tag', t`Tag`, 'tags'), action('delete', t`Delete`, 'trash', true)]
            : [
                action('favorite', t`Favorite`, 'star'),
                action('tag', t`Tag`, 'tags'),
                action('duplicate', t`Duplicate`, 'copy'),
                action('persona', t`Convert to Persona`, 'user'),
                action('delete', t`Delete`, 'trash', true),
            ];
        return createSelectionMode({
            root: section, list: rowsContainer, header: selectionHeader, actionBar: selectionBar,
            rowSelector: '.character_select, .group_select',
            getKey: row => row.dataset.sbListKey,
            rowLabel: row => row.querySelector('.ch_name')?.textContent ?? '',
            range: true,
            getAllKeys: () => state.selectableKeys,
            canEnter: () => !bulkBusy && state.selectableKeys.length > 0,
            actions,
            onChange: decorateSelection,
            onExit: () => {
                decorateSelection();
                if (!switchingView) run(refresh);
            },
        });
    }

    async function writePagination(view, page, pageSize) {
        suppressedStateRenders++;
        try {
            if (dataModules.state.getListPageSize(view) !== pageSize) await dataModules.state.setListPageSize(view, pageSize);
            if (dataModules.state.getListPage(view) !== page) await dataModules.state.setListPage(view, page);
        } finally {
            suppressedStateRenders--;
        }
    }

    const createPagination = view => createListPagination({
        pageSizes: PAGE_SIZES,
        readPageSize: () => dataModules.state.getListPageSize(view),
        // The helper commits its size after writePageSize; persist in onChange
        // instead so C1's render callback sees both the new page and size.
        onChange: ({ page, pageSize }) => {
            if (state.pageSync) return;
            run(async () => {
                await writePagination(view, page, pageSize);
                await refresh();
                // Disabling Next/Previous on the last/first page can leave the browser without a keyboard target.
                const focused = document.activeElement;
                if (selection.isActive && (!section.contains(focused) || focused.matches?.(':disabled'))) {
                    selectionHeader.querySelector('.sb-selection-cancel')?.focus({ preventScroll: true });
                }
            });
        },
        keepSizeVisible: true,
    });

    function currentSortOptions() {
        const options = dataModules.state.getListSortOptions?.(state.view);
        if (Array.isArray(options) && options.length) return options;
        return [...document.querySelectorAll('#character_sort_order option')]
            .filter(option => option.dataset.field && option.dataset.field !== 'search' && !option.hidden)
            .map(option => ({ field: option.dataset.field, order: option.dataset.order, rule: option.dataset.rule, label: option.textContent.trim() }));
    }

    function openSortMenu(trigger) {
        const current = dataModules.state.getListSort?.(state.view) ?? {};
        const sortItems = currentSortOptions().map(option => makeMenuItem(option.label || option.i18nKey || t`Sort`, 'check', () => dataModules.state.setListSort?.(state.view, option), {
            checked: option.field === current.field && option.order === current.order && (option.rule ?? null) === (current.rule ?? null),
        }));
        const viewItems = [
            ['list', t`List`],
            ['grid', t`Grid`],
        ].map(([value, label]) => makeMenuItem(label, power_user.charListGrid === (value === 'grid') ? 'check' : 'circle', () => {
            if (Boolean(power_user.charListGrid) !== (value === 'grid')) clickTransport('#charListGridToggle');
        }, {
            checked: power_user.charListGrid === (value === 'grid'),
        }));
        menu(trigger, t`Sort`, [{ title: t`Sort`, items: sortItems }, { title: t`View`, items: viewItems }]);
    }

    function openListMenu(trigger) {
        const filter = selector => document.querySelector(`#rm_characters_block ${selector}`);
        const sections = [];
        if (overflowed.has('sort')) sections.push({ items: [makeMenuItem(t`Sort`, 'arrow-down-wide-short', () => openSortMenu(trigger))] });
        if (overflowed.has('search')) sections.push({ items: [makeMenuItem(t`Search`, 'magnifying-glass', () => search.toggle())] });
        sections.push({ items: [makeMenuItem(t`Select`, 'check-double', () => selection.enter(null, trigger), { disabled: bulkBusy || !state.selectableKeys.length })] });
        sections.push({ items: [
            makeMenuItem(t`Manage tags`, 'tags', () => filter('.manageTags')?.click()),
            makeMenuItem(t`Tags as Folders`, 'folder', () => clickTransport('#bogus_folders'), { checked: Boolean(power_user.bogus_folders) }),
            makeMenuItem(t`Clear all filters`, 'filter-circle-xmark', () => filter('.clearAllFilters')?.click()),
        ] });
        sections.push({ items: [makeMenuItem(t`Import`, 'file-import', () => globalThis.SillyBunnyShell?.openTab?.('characters', 'import'))] });
        menu(trigger, state.view === 'groups' ? t`Groups` : t`Characters`, sections);
    }

    async function openEditor(entry) {
        const target = entry.kind === 'group'
            ? { kind: 'group-editor', id: String(entry.data.id ?? entry.item.id), via: 'group-list' }
            : { kind: 'character-editor', id: String(entry.data.avatar ?? entry.item.avatar), via: 'character-list' };
        await objectNavigation.navigate(target, { from: () => ({ kind: state.view === 'groups' ? 'group-list' : 'character-list' }) });
    }

    async function characterAction(entry, action) {
        const script = dataModules.script;
        const avatar = entry.data.avatar ?? entry.item.avatar;
        const id = entry.data.chid ?? entry.data.id ?? entry.entity.id;
        if (action === 'favorite') {
            if (typeof script.toggleCharacterFavoriteById === 'function') await script.toggleCharacterFavoriteById(id);
            return;
        }
        if (action === 'duplicate') {
            if (typeof script.duplicateCharacter === 'function') await script.duplicateCharacter({ avatar });
            return;
        }
        if (action === 'persona') {
            const personas = await import('./personas.js');
            await personas.convertCharacterToPersona(Number(id));
            return;
        }
        if (action === 'delete') await script.deleteCharacterById(id);
    }

    async function groupAction(entry, action) {
        const groups = dataModules.groups;
        const id = entry.data.id ?? entry.item.id;
        if (action === 'favorite' && typeof groups.toggleGroupFavoriteById === 'function') await groups.toggleGroupFavoriteById(id);
        if (action === 'delete' && typeof groups.deleteGroupById === 'function') await groups.deleteGroupById(id);
    }

    function openRowMenu(trigger, entry) {
        const favorite = entry.favorite;
        const items = entry.kind === 'group'
            ? [
                makeMenuItem(t`Favorites`, 'star', () => groupAction(entry, 'favorite'), { checked: favorite }),
                makeMenuItem(t`Delete`, 'trash', () => groupAction(entry, 'delete'), { danger: true }),
            ]
            : [
                makeMenuItem(t`Favorites`, 'star', () => characterAction(entry, 'favorite'), { checked: favorite }),
                makeMenuItem(t`Duplicate`, 'copy', () => characterAction(entry, 'duplicate')),
                makeMenuItem(t`Convert to Persona`, 'user', () => characterAction(entry, 'persona')),
                makeMenuItem(t`Delete`, 'trash', () => characterAction(entry, 'delete'), { danger: true }),
            ];
        menu(trigger, t`Actions for ${entry.label}`, [{ items }]);
    }

    function createHeader() {
        const actions = [
            { id: 'search', label: t`Search`, icon: 'magnifying-glass', onActivate: () => search.toggle(), overflowPriority: 2 },
            { id: 'new', label: t`New`, icon: 'plus', onActivate: () => clickTransport(state.view === 'groups' ? '#rm_button_group_chats' : '#rm_button_create') },
            { id: 'sort', label: t`Sort`, icon: 'arrow-down-wide-short', menu: true, onActivate: openSortMenu, overflowPriority: 1 },
            { id: 'more', label: t`More...`, icon: 'ellipsis-vertical', menu: true, onActivate: openListMenu },
        ];
        header = createListHeader({ title: t`Characters`, actions, className: 'sb-character-list__header' });
        extensionSlot = document.getElementById('rm_buttons_container');
        if (extensionSlot) {
            extensionSlot.classList.add('sb-character-list__extension-slot');
            header.element.append(extensionSlot);
        }
        return header.element;
    }

    async function renderStatus(model, revision) {
        let content = null;
        if (!model.sourceCount) {
            const template = await dataModules.script.getEmptyBlock?.();
            const legacy = template?.[0] ?? template;
            const empty = createStatusPage({
                icon: 'address-card',
                title: legacy?.textContent?.trim() || t`No results`,
                actions: [{ label: t`New`, primary: true, onActivate: () => clickTransport(state.view === 'groups' ? '#rm_button_group_chats' : '#rm_button_create') }],
            });
            content = empty.element;
        } else if (!model.entities.length) {
            const empty = createStatusPage({ icon: 'magnifying-glass', title: t`No results`, actions: [{ label: t`Clear all filters`, onActivate: () => document.querySelector('#rm_characters_block .clearAllFilters')?.click() }] });
            content = empty.element;
        }
        if (revision === renderRevision) status.replaceChildren(...(content ? [content] : []));
    }

    async function render(model) {
        if (destroyed) return;
        if (!model || !Array.isArray(model.entities)) throw new TypeError('Character list model requires entities.');
        const revision = ++renderRevision;
        const view = model.view === 'groups' ? 'groups' : 'characters';
        const viewChanged = state.view !== model.view;
        if (viewChanged) {
            cancelActivation();
            closeTagPicker();
            switchingView = true;
            selection.exit();
            selection.destroy();
            switchingView = false;
        }
        state.view = view;
        const idsByKey = selectionIdsByKey();
        state.selectableKeys = model.entities.filter(entity => entity.type !== 'tag')
            .map(entity => view === 'groups'
                ? entityKey('group', entity.item?.id ?? entity.id)
                : entityKey('character', (entity.item ?? entity).avatar))
            .filter(key => idsByKey.has(key));
        if (viewChanged) selection = createSelection();
        if (selection.isActive) selection.select(selection.selectedKeys.filter(key => idsByKey.has(key)));
        search.setQuery(searchInput.value, { notify: false });
        if (viewChanged || searchInput.value) {
            searchField.hidden = !searchInput.value;
            header.button('search').setAttribute('aria-expanded', String(!searchField.hidden));
        }
        section.dataset.view = state.view;
        header?.setTitle(state.view === 'groups' ? t`Groups` : t`Characters`);
        const noun = state.view === 'groups' ? t`groups` : t`characters`;
        header?.setSubtitle(`${model.sourceCount} ${noun}`);
        setOverflow();
        const pageSize = Number(dataModules.state.getListPageSize?.(state.view)) || pagination.pageSize;
        let page = Number(dataModules.state.getListPage?.(state.view)) || 1;
        if (revealActiveOnRender && !selection.isActive) {
            const index = model.entities.findIndex(entity => {
                if (entity.type === 'tag') return false;
                const data = entity.type === 'group'
                    ? dataModules.script.getGroupRowData(entity.item)
                    : dataModules.script.getCharacterRowData(entity.item, entity.id);
                return Boolean(data.active ?? data.isActive);
            });
            if (index >= 0) page = Math.floor(index / pageSize) + 1;
        }
        if (paginationView !== state.view || pagination.pageSize !== pageSize) {
            pagination.destroy();
            pagination = createPagination(state.view);
            paginationView = state.view;
            footer.replaceChildren(pagination.element);
        }
        const currentPagination = pagination;
        currentPagination.setTotal(model.entities.length);
        const clampedPage = Math.min(currentPagination.pages, page);
        state.pageSync++;
        try {
            await currentPagination.goTo(clampedPage);
            if (revision !== renderRevision) return;
            await writePagination(view, clampedPage, currentPagination.pageSize);
        } finally {
            state.pageSync--;
        }
        if (revision !== renderRevision) return;
        const pageEntries = currentPagination.slice(model.entities).map(entity => normalizeEntry(entity, view, dataModules));
        if (model.folderOpen) pageEntries.unshift(createBackEntry(dataModules.script));
        const hidden = getHiddenCount(model);
        if (model.hasAnyFilter && hidden > 0) pageEntries.push(await createHiddenEntry(hidden, dataModules.script));
        if (revision !== renderRevision) return;
        const scrollTop = box.scrollTop;
        const updateRows = () => reconcileRows({
            container: rowsContainer,
            cache: state.rows,
            entries: pageEntries,
            key: entry => entry.key,
            signature: entry => entry.kind,
            create: entry => createRowEntry(entry, { edit: openEditor, menu: openRowMenu }),
            update: (row, entry) => updateRow(row, entry, dataModules, listVisible),
        });
        if (listVisible && !viewChanged && !revealActiveOnRender && state.rows.size > 0 && pageEntries.length <= 50 && Date.now() >= typingUntil && state.lastQuery === search.query) animateListChange(rowsContainer, updateRows, { key: entityRowMotionKey });
        else updateRows();
        decorateSelection();
        box.scrollTop = model.fullRefresh ? 0 : scrollTop;
        state.lastQuery = search?.query ?? '';
        search?.report(modelCount(model), model.sourceCount);
        await renderStatus(model, revision);
        if (revision === renderRevision) {
            firstRenderComplete = true;
            finishFirstReveal();
        }
        if (revision === renderRevision) syncListVisibility();
        if (revision === renderRevision) model.pageLoaded?.();
    }

    function captureState() {
        const focused = document.activeElement instanceof HTMLElement ? document.activeElement.closest('[data-sb-list-key]') : null;
        return {
            query: search?.query ?? searchInput.value,
            page: dataModules.state.getListPage?.(state.view) ?? pagination.page,
            scrollTop: box.scrollTop,
            focusKey: focused?.dataset.sbListKey ?? null,
        };
    }

    async function applyRestoreSnapshot(snapshot, view = state.view) {
        preserveRestoredScroll = true;
        if (snapshot.query !== undefined) {
            const query = String(snapshot.query);
            search.setQuery(query, { notify: false });
            dataModules.script.entitiesFilter?.setFilterData?.('search', query, true);
            dataModules.script.entitiesFilter?.clearFuzzySearchCaches?.();
        }
        if (Number.isInteger(snapshot.page) && snapshot.page > 0) {
            const size = dataModules.state.getListPageSize(view);
            await writePagination(view, snapshot.page, size);
        }
    }

    async function restoreState(snapshot, isCurrent = () => true) {
        if (!snapshot || !isCurrent()) return;
        await applyRestoreSnapshot(snapshot);
        if (!isCurrent()) return;
        await dataModules.script.printCharacters?.(false);
        if (!isCurrent()) return;
        await finishRestoreSnapshot(snapshot, isCurrent);
    }

    async function finishRestoreSnapshot(snapshot, isCurrent) {
        if (!isCurrent()) return;
        box.scrollTop = Number(snapshot.scrollTop) || 0;
        if (snapshot.focusKey) {
            await new Promise(resolve => requestAnimationFrame(() => {
                if (isCurrent() && !destroyed) {
                    [...rowsContainer.querySelectorAll('[data-sb-list-key]')]
                        .find(row => row.dataset.sbListKey === snapshot.focusKey)?.focus({ preventScroll: true });
                }
                resolve();
            }));
        }
    }

    function headerItemWidth(item) {
        const allocatedWidth = headerWidths.get(item) ?? 0;
        if (item !== extensionSlot) return allocatedWidth;
        // A flex-shrunk slot can be narrower than its controls; reserve their observed border boxes instead.
        const widths = [...extensionItems].map(child => headerWidths.get(child) ?? 0).filter(width => width > 0);
        const intrinsicWidth = widths.reduce((sum, width) => sum + width, 0)
            + Math.max(0, widths.length - 1) * extensionGap + extensionInsets;
        return Math.max(allocatedWidth, intrinsicWidth) + extensionMargin;
    }

    function observeExtensionItems() {
        const previous = extensionItems;
        extensionItems = new Set(extensionSlot.children);
        for (const child of previous) {
            if (extensionItems.has(child)) continue;
            resizeObserver?.unobserve(child);
            headerWidths.delete(child);
        }
        for (const child of extensionItems) {
            if (!previous.has(child)) resizeObserver?.observe(child, { box: 'border-box' });
        }
        setOverflow();
    }

    function setOverflow() {
        if (!header?.element || !headerWidth) return;
        const element = header.element;
        const children = [...element.children].filter(child => !child.matches('.sb-list-header__spacer'));
        let required = children.reduce((sum, child) => sum + headerItemWidth(child), 0) + headerGap * children.length;
        const candidates = children.filter(child => child.hasAttribute('data-overflow-priority'))
            .sort((first, second) => Number(first.dataset.overflowPriority) - Number(second.dataset.overflowPriority));
        const wanted = [];
        for (const button of candidates) {
            if (required <= headerWidth) break;
            wanted.push(button.dataset.actionId);
            required -= (headerWidths.get(button) ?? 0) + headerGap;
        }
        overflowed = new Set(wanted);
        header.setOverflowed(wanted);
    }

    function finishFirstReveal() {
        if (!firstRenderComplete || firstRevealFrame || !section.classList.contains('sb-character-list--preparing')) return;
        if (resizeObserver && !headerWidth) return;
        // Allow a rendering turn for auto-contained rows, even when they do not resize their parent.
        firstRevealFrame = requestAnimationFrame(() => {
            firstRevealFrame = requestAnimationFrame(() => {
                firstRevealFrame = 0;
                if (destroyed) return;
                setOverflow();
                section.classList.remove('sb-character-list--preparing');
            });
        });
    }

    function mount() {
        section.classList.add('sb-character-list--preparing');
        const headerElement = createHeader();
        section.append(headerElement, selectionHeader, searchField, filterRow, box, status);
        if (transport) {
            transport.classList.add('sb-character-list__transports');
            section.append(transport);
        }
        container.append(section);
        selection = createSelection();
        const searchStatus = node('div', 'sb-character-list__search-status');
        searchStatus.setAttribute('aria-live', 'polite');
        section.append(searchStatus);
        const beginInput = () => { handlingSearchInput = true; };
        const endInput = () => { handlingSearchInput = false; };
        searchInput.addEventListener('input', beginInput);
        search = createListSearch({
            field: searchField,
            input: searchInput,
            trigger: header.button('search'),
            scope: section,
            status: searchStatus,
            debounce: 0,
            onChange: () => {
                typingUntil = Date.now() + 400;
                if (!handlingSearchInput) searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            },
            typeToSearchSelector: '[data-sb-list-key]',
        });
        searchInput.addEventListener('input', endInput);
        pagination = createPagination(state.view);
        footer.append(pagination.element);
        unbindKeyboard = bindListKeyboard(rowsContainer, {
            rowSelector: '.ds-entity-row--activatable:not([aria-disabled="true"])',
            onOpen: (row, event) => {
                if (selection.isActive) return true;
                const entry = rowEntry(row);
                if (entry?.kind === 'character' || entry?.kind === 'group') {
                    // Keep the upstream selection guards, but own completion instead of its mobile-only delegated close.
                    event.preventDefault();
                    event.stopPropagation();
                    run(() => activateChat(row, entry));
                    return true;
                }
                if (event instanceof KeyboardEvent) {
                    if (event.key === 'Enter') return false;
                    if (event.key === ' ') {
                        row.click();
                        return true;
                    }
                }
                return false;
            },
        });
        const headerStyle = getComputedStyle(header.element);
        const measuredGap = Number.parseFloat(headerStyle.columnGap);
        headerGap = Number.isFinite(measuredGap) ? measuredGap : 4;
        if (extensionSlot) {
            const style = getComputedStyle(extensionSlot);
            const pixels = value => Number.parseFloat(value) || 0;
            extensionGap = pixels(style.columnGap);
            extensionInsets = pixels(style.paddingInlineStart) + pixels(style.paddingInlineEnd)
                + pixels(style.borderInlineStartWidth) + pixels(style.borderInlineEndWidth);
            extensionMargin = pixels(style.marginInlineStart) + pixels(style.marginInlineEnd);
        }
        resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver((entries = []) => {
            for (const entry of entries) {
                if (entry.target === header.element) headerWidth = entry.contentRect.width;
                else {
                    const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
                    if (width > 0 || extensionItems.has(entry.target)) headerWidths.set(entry.target, width);
                }
            }
            setOverflow();
            finishFirstReveal();
            syncListVisibility();
        }) : null;
        resizeObserver?.observe(header.element, { box: 'border-box' });
        resizeObserver?.observe(section);
        for (const child of header.element.children) resizeObserver?.observe(child, { box: 'border-box' });
        visibilityObserver = new MutationObserver(syncListVisibility);
        for (const ancestor of [document.documentElement, section.closest('#right-nav-panel'), section.closest('#sb-settings-page')].filter(Boolean)) {
            visibilityObserver.observe(ancestor, { attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class', 'data-sb-settings-open'] });
        }
        const activeEvents = [event_types.CHAT_CHANGED, event_types.CHAT_LOADED, event_types.GROUP_UPDATED].filter(Boolean);
        activeEvents.forEach(event => eventSource.on(event, syncActiveRows));
        if (extensionSlot) {
            observeExtensionItems();
            extensionObserver = new MutationObserver(observeExtensionItems);
            extensionObserver.observe(extensionSlot, { childList: true, subtree: true, characterData: true });
        }
        setOverflow();
        section.removeAttribute('aria-busy');
        loading.element.remove();
        section.dataset.mounted = 'true';
        return {
            section,
            render,
            refresh,
            captureState,
            restoreState,
            revealActiveEntity,
            destroy() {
                if (destroyed) return;
                destroyed = true;
                cancelActivation();
                renderRevision++;
                cancelAnimationFrame(firstRevealFrame);
                unbindKeyboard();
                resizeObserver?.disconnect();
                extensionObserver?.disconnect();
                visibilityObserver.disconnect();
                activeEvents.forEach(event => eventSource.removeListener(event, syncActiveRows));
                tagMenu.destroy();
                search.destroy();
                selection.exit();
                selection.destroy();
                searchInput.removeEventListener('input', beginInput);
                searchInput.removeEventListener('input', endInput);
                pagination.destroy();
                header.destroy();
                mountedLists.delete(container);
                dataModules.script.setCharacterListRenderer(null);
                dataModules.state.registerCharacterListStateRenderer?.(null);
                if (globalThis.SillyBunnyCharacterListController?.section === section) delete globalThis.SillyBunnyCharacterListController;
                restoreDOM();
                section.remove();
                overlay.setLegacyRowSelectionEnabled(true);
            },
        };
    }

    return { section, mount, render, state };
}

/**
 * Mounts the shared Characters/Groups list controller.
 * @param {HTMLElement} [container] Existing #rm_characters_block host.
 * @returns {Promise<{ section: HTMLElement, render: (model: object) => Promise<void>|void, captureState: () => object, restoreState: (state: object) => Promise<void>, revealActiveEntity: (isCurrent?: () => boolean) => Promise<void>, destroy: () => void }>}
 */
export async function mountCharacterList(container = document.getElementById('rm_characters_block'), { render = true, getNavigationGeneration = () => 0 } = {}) {
    if (!(container instanceof HTMLElement)) throw new TypeError('Character list requires an HTMLElement host.');
    if (mountedLists.has(container)) return mountedLists.get(container);
    if (mountingLists.has(container)) return mountingLists.get(container);
    const promise = (async () => {
        await loadCharacterListStyles();
        const originalChildren = [...container.children].map(element => ({ element, style: element.getAttribute('style') }));
        const engineSelectors = ['#character_search_bar', '#charListFixedTop > .rm_tag_controls', '#rm_print_characters_block', '#rm_print_characters_pagination', '#rm_buttons_container'];
        const engines = engineSelectors.map(selector => container.querySelector(selector)).filter(Boolean).map(element => {
            const marker = document.createComment('sb-character-list-origin');
            element.before(marker);
            return { element, marker, attributes: [...element.attributes].map(attribute => [attribute.name, attribute.value]) };
        });
        const originalRows = [...(container.querySelector('#rm_print_characters_block')?.childNodes ?? [])];
        const restoreDOM = () => {
            for (const { element, marker, attributes } of engines) {
                marker.replaceWith(element);
                for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
                for (const [name, value] of attributes) element.setAttribute(name, value);
            }
            container.querySelector('#rm_print_characters_block')?.replaceChildren(...originalRows);
            for (const { element, style } of originalChildren) {
                if (style === null) element.removeAttribute('style');
                else element.setAttribute('style', style);
            }
        };
        for (const { element } of originalChildren) element.style.setProperty('display', 'none', 'important');
        const section = node('section', 'sb-character-list sb-character-list--loading');
        section.append(createStatusPage({ icon: 'spinner fa-spin', title: t`Loading...`, compact: true }).element);
        container.append(section);
        let mounted;
        try {
            const [script, groups, state, tags] = await Promise.all([loadScriptModule(), loadGroupModule(), loadStateModule(), loadTagModule()]);
            const controller = createCharacterListController(container, { script, groups, state, tags, getNavigationGeneration }, restoreDOM);
            section.remove();
            mounted = controller.mount();
            for (const { element, style } of originalChildren) {
                if (!mounted.section.contains(element)) continue;
                if (style === null) element.removeAttribute('style');
                else element.setAttribute('style', style);
            }
            state.registerCharacterListStateRenderer?.(mounted.refresh);
            script.setCharacterListRenderer({ render: mounted.render });
            if (render) await script.printCharacters?.(false);
            section.remove();
            mountedLists.set(container, mounted);
            globalThis.SillyBunnyCharacterListController = mounted;
            return mounted;
        } catch (error) {
            mounted?.destroy();
            if (!mounted) restoreDOM();
            container.querySelectorAll(':scope > .sb-character-list').forEach(element => element.remove());
            throw error;
        }
    })();
    mountingLists.set(container, promise);
    try {
        return await promise;
    } finally {
        mountingLists.delete(container);
    }
}

/** Returns the mounted controller for a host, if present. @param {HTMLElement} container @returns {object|null} */
export function getMountedCharacterList(container = document.getElementById('rm_characters_block')) {
    return container instanceof HTMLElement ? mountedLists.get(container) ?? null : null;
}

/** Restores state captured from a list destination. @param {object|null} state @param {() => boolean} [isCurrent] @returns {Promise<void>} */
export async function restoreCharacterListState(state, isCurrent) {
    const mounted = getMountedCharacterList();
    if (!mounted) return;
    await mounted.restoreState(state, isCurrent);
}
