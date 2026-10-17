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
import { objectNavigation } from './sillybunny-editor/object-navigation.js';
import { animateListChange } from './sillybunny-motion.js';

const CHARACTER_LIST_STYLESHEETS = Object.freeze([
    { href: 'css/sillybunny-entity-list.css?v=20261016a', id: 'deferred-entity-list-css' },
    { href: 'css/sillybunny-editor-shell.css?v=20261018a', id: 'deferred-editor-shell-css' },
    { href: 'css/sillybunny-character-list.css?v=20261018b', id: 'deferred-character-list-css' },
]);
const PAGE_SIZES = Object.freeze([10, 25, 50, 100, 250, 500, 1000]);
const mountedLists = new WeakMap();
const mountingLists = new WeakMap();
const rowFactories = new WeakMap();

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
    return row;
}

function updateRow(row, entry, dependencies) {
    const factory = rowFactories.get(row);
    factory.update(rowOptions(entry));
    if (entry.kind === 'character' || entry.kind === 'group') {
        const { data } = entry;
        if (factory.slots.avatar) factory.slots.avatar.title = textValue(data.avatarTitle);
        factory.slots.title.title = textValue(data.nameTitle);
        const more = factory.slots.suffix.lastElementChild;
        more.title = t`Actions for ${entry.label}`;
        more.setAttribute('aria-label', more.title);
        setActiveState(row, entry.active);
        row.classList.toggle('is_fav', entry.favorite);
        const favoriteInput = row.querySelector('.ch_fav');
        if (favoriteInput instanceof HTMLInputElement) favoriteInput.value = textValue(valueFrom(entry.data, entry.item, 'fav', 'favorite'));
        if (entry.kind === 'character') rowTags(row, entry.data.avatar ?? entry.item.avatar, entry.data, dependencies.tags);
        if (entry.kind === 'group') rowTags(row, entry.data.id ?? entry.item.id, entry.data, dependencies.tags);
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

    const menu = (trigger, title, sections) => openActionMenu({ trigger, title, sections, onClose: () => trigger.setAttribute('aria-expanded', 'false') });
    function refresh() {
        if (suppressedStateRenders || destroyed) return;
        return dataModules.script.printCharacters(false);
    }

    function decorateSelection() {
        const active = Boolean(selection?.isActive);
        if (active !== selectionActive) {
            selectionActive = active;
            run(() => overlay.notifySharedSelectionState(active ? 'select' : 'browse'));
        }
        selection?.decorate();
        for (const row of rowsContainer.querySelectorAll('.ds-entity-row')) {
            row.classList.toggle('is-selected', !active && Boolean(rowEntry(row)?.active));
            for (const control of row.querySelectorAll('.ds-entity-row__suffix')) control.inert = active;
            if (row.matches('.bogus_folder_select')) {
                row.inert = active;
                if (active) row.setAttribute('aria-disabled', 'true');
                else row.removeAttribute('aria-disabled');
            }
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
            makeMenuItem(t`Show Tag List`, 'tag', () => filter('.showTagList')?.click(), { checked: Boolean(power_user.show_tag_filters) }),
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
        const extensionSlot = document.getElementById('rm_buttons_container');
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
        const page = Number(dataModules.state.getListPage?.(state.view)) || 1;
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
            update: (row, entry) => updateRow(row, entry, dataModules),
        });
        if (Date.now() >= typingUntil && state.lastQuery === search.query) animateListChange(rowsContainer, updateRows, { key: entityRowMotionKey });
        else updateRows();
        decorateSelection();
        box.scrollTop = model.fullRefresh ? 0 : scrollTop;
        state.lastQuery = search?.query ?? '';
        search?.report(modelCount(model), model.sourceCount);
        await renderStatus(model, revision);
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

    async function restoreState(snapshot, isCurrent = () => true) {
        if (!snapshot || !isCurrent()) return;
        if (snapshot.query !== undefined) {
            const query = String(snapshot.query);
            search.setQuery(query, { notify: false });
            dataModules.script.entitiesFilter?.setFilterData?.('search', query, true);
            dataModules.script.entitiesFilter?.clearFuzzySearchCaches?.();
        }
        if (Number.isInteger(snapshot.page) && snapshot.page > 0) await writePagination(state.view, snapshot.page, pagination.pageSize);
        if (!isCurrent()) return;
        await dataModules.script.printCharacters?.(false);
        if (!isCurrent()) return;
        box.scrollTop = Number(snapshot.scrollTop) || 0;
        if (snapshot.focusKey) {
            requestAnimationFrame(() => {
                if (!isCurrent() || destroyed) return;
                [...rowsContainer.querySelectorAll('[data-sb-list-key]')]
                    .find(row => row.dataset.sbListKey === snapshot.focusKey)?.focus({ preventScroll: true });
            });
        }
    }

    function setOverflow() {
        if (!header?.element) return;
        const element = header.element;
        const available = element.clientWidth;
        if (!available) return;
        const titles = element.querySelector('.sb-list-header__titles');
        const extensions = element.querySelector('.sb-character-list__extension-slot');
        const measured = [titles, extensions].filter(Boolean);
        const savedFlex = measured.map(child => child.style.flex);
        header.setOverflowed([]);
        // Measure uncompressed content so the flex spacer and truncated title cannot hide a collision.
        measured.forEach(child => { child.style.flex = '0 0 auto'; });
        const styles = getComputedStyle(element);
        const pixels = value => Number.parseFloat(value) || 0;
        const gap = pixels(styles.columnGap);
        const children = [...element.children].filter(child => getComputedStyle(child).display !== 'none');
        const widths = new Map(children.map(child => {
            const childStyle = getComputedStyle(child);
            const width = child.matches('.sb-list-header__spacer') ? 0 : child.getBoundingClientRect().width;
            return [child, width + pixels(childStyle.marginLeft) + pixels(childStyle.marginRight)];
        }));
        let required = pixels(styles.paddingLeft) + pixels(styles.paddingRight)
            + [...widths.values()].reduce((sum, width) => sum + width, 0) + gap * Math.max(0, children.length - 1);
        const candidates = children.filter(child => child.hasAttribute('data-overflow-priority'))
            .sort((first, second) => Number(first.dataset.overflowPriority) - Number(second.dataset.overflowPriority));
        const wanted = [];
        for (const button of candidates) {
            if (required <= available) break;
            wanted.push(button.dataset.actionId);
            required -= widths.get(button) + gap;
        }
        measured.forEach((child, index) => { child.style.flex = savedFlex[index]; });
        overflowed = new Set(wanted);
        header.setOverflowed(wanted);
    }

    function mount() {
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
        resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(setOverflow) : null;
        resizeObserver?.observe(header.element);
        const extensionSlot = header.element.querySelector('.sb-character-list__extension-slot');
        if (extensionSlot) {
            resizeObserver?.observe(extensionSlot);
            extensionObserver = new MutationObserver(setOverflow);
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
            destroy() {
                if (destroyed) return;
                destroyed = true;
                renderRevision++;
                unbindKeyboard();
                resizeObserver?.disconnect();
                extensionObserver?.disconnect();
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
 * @returns {Promise<{ section: HTMLElement, render: (model: object) => Promise<void>|void, captureState: () => object, restoreState: (state: object) => Promise<void>, destroy: () => void }>}
 */
export async function mountCharacterList(container = document.getElementById('rm_characters_block')) {
    if (!(container instanceof HTMLElement)) throw new TypeError('Character list requires an HTMLElement host.');
    if (mountedLists.has(container)) return mountedLists.get(container);
    if (mountingLists.has(container)) return mountingLists.get(container);
    const promise = (async () => {
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
            await loadCharacterListStyles();
            const [script, groups, state, tags] = await Promise.all([loadScriptModule(), loadGroupModule(), loadStateModule(), loadTagModule()]);
            const controller = createCharacterListController(container, { script, groups, state, tags }, restoreDOM);
            mounted = controller.mount();
            for (const { element, style } of originalChildren) {
                if (!mounted.section.contains(element)) continue;
                if (style === null) element.removeAttribute('style');
                else element.setAttribute('style', style);
            }
            state.registerCharacterListStateRenderer?.(mounted.refresh);
            script.setCharacterListRenderer({ render: mounted.render });
            await script.printCharacters?.(false);
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

/** Returns the active list destination state. @returns {object|null} */
export function captureCharacterListState() {
    return getMountedCharacterList()?.captureState() ?? null;
}

/** Restores state captured from a list destination. @param {object|null} state @param {() => boolean} [isCurrent] @returns {Promise<void>} */
export async function restoreCharacterListState(state, isCurrent) {
    const mounted = getMountedCharacterList();
    if (!mounted) return;
    await mounted.restoreState(state, isCurrent);
}
