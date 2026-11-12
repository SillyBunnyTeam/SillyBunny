import { accountStorage } from './util/AccountStorage.js';
import { FILTER_TYPES } from './filters.js';

const VIEWS = Object.freeze(['characters', 'groups']);
const GROUP_SORT_STORAGE_KEY = 'GroupList_SortOrder';
const DEFAULT_GROUP_SORT = Object.freeze({ field: 'name', order: 'asc' });
const GROUP_SORT_FIELDS = new Set(['name', 'create_date', 'date_added', 'fav', 'date_last_chat', 'chat_size']);
const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_KEYS = Object.freeze({
    characters: 'Characters_PerPage',
    groups: 'Groups_PerPage',
});
const STORAGE_PREFIXES = Object.freeze({
    characters: 'CharacterList',
    groups: 'GroupList',
});

const viewState = new Map(VIEWS.map(view => [view, {
    filters: null,
    query: '',
    page: 1,
}]));

let activeView = 'characters';
let switchRevision = 0;
let readCharacterSort = () => ({ ...DEFAULT_GROUP_SORT });
let writeCharacterSort = () => {};
let renderList = null;

function assertView(view) {
    if (!VIEWS.includes(view)) {
        throw new TypeError(`Invalid character list view: ${view}`);
    }
}

function cloneFilterData(filterData) {
    return typeof structuredClone === 'function'
        ? structuredClone(filterData)
        : JSON.parse(JSON.stringify(filterData));
}

function normalizeSort(sort, fallback = DEFAULT_GROUP_SORT) {
    const value = sort && typeof sort === 'object' ? sort : fallback;
    return {
        field: String(value.field || fallback.field),
        order: String(value.order || fallback.order),
        ...(value.rule !== undefined ? { rule: value.rule == null ? null : String(value.rule) } : {}),
    };
}

function parseGroupSort(sort) {
    if (!sort || typeof sort !== 'object' || !GROUP_SORT_FIELDS.has(sort.field)
        || !['asc', 'desc', 'random'].includes(sort.order)
        || (sort.rule != null && sort.rule !== 'boolean')) {
        return null;
    }
    return normalizeSort(sort);
}

function selectNativeSortOption(sort) {
    const options = document.querySelectorAll('#character_sort_order option');
    for (const option of options) {
        const matches = option.dataset.field === sort.field
            && option.dataset.order === sort.order
            && (option.dataset.rule ?? null) === (sort.rule ?? null);
        if (matches) {
            option.selected = true;
            return;
        }
    }
}

function scheduleRender() {
    return renderList?.() ?? Promise.resolve();
}

async function getScriptAndTags() {
    const [script, tags] = await Promise.all([
        import('../script.js'),
        import('./tags.js'),
    ]);
    return { script, tags };
}

/**
 * Registers the character sort accessors without making the state module depend
 * on power-user.js during module initialization.
 * @param {{ read: () => object, write: (sort: object) => void }} accessors
 */
export function registerCharacterListSortAccessors({ read, write }) {
    if (typeof read !== 'function' || typeof write !== 'function') {
        throw new TypeError('Character list sort accessors must provide read and write functions');
    }
    readCharacterSort = read;
    writeCharacterSort = write;
}

/**
 * Registers the list render callback used by state setters.
 * @param {(() => Promise<void>|void)|null} renderer
 */
export function registerCharacterListStateRenderer(renderer) {
    if (renderer !== null && typeof renderer !== 'function') {
        throw new TypeError('Character list state renderer must be a function or null');
    }
    renderList = renderer;
}

/**
 * Switches the main list's view, saving the outgoing view's state and restoring the incoming one.
 * @param {'characters'|'groups'} view
 */
export async function switchCharacterListView(view, { render = true } = {}) {
    assertView(view);
    const revision = ++switchRevision;
    const { script, tags } = await getScriptAndTags();
    if (revision !== switchRevision) {
        return;
    }
    const currentFilters = script.entitiesFilter.getFilterData;
    const outgoing = viewState.get(activeView);
    outgoing.filters = cloneFilterData(Object.fromEntries(Object.values(FILTER_TYPES).map(type => [
        type,
        currentFilters.call(script.entitiesFilter, type),
    ])));
    outgoing.query = String(document.getElementById('character_search_bar')?.value ?? outgoing.query ?? '');

    activeView = view;
    const incoming = viewState.get(view);
    script.setCharacterMenuEntityView(view);
    tags.setMainListFilterStoragePrefix(STORAGE_PREFIXES[view]);

    if (incoming.filters) {
        for (const [type, value] of Object.entries(incoming.filters)) {
            script.entitiesFilter.setFilterData(type, cloneFilterData(value), true);
        }
    } else {
        tags.loadMainListFilterStates(view);
        incoming.filters = cloneFilterData(Object.fromEntries(Object.values(FILTER_TYPES).map(type => [
            type,
            script.entitiesFilter.getFilterData(type),
        ])));
    }

    const query = String(incoming.query ?? '');
    const searchInput = document.getElementById('character_search_bar');
    if (searchInput) {
        searchInput.value = query;
    }
    script.entitiesFilter.setFilterData(FILTER_TYPES.SEARCH, query, true);
    script.entitiesFilter.clearFuzzySearchCaches();
    if (!query) {
        selectNativeSortOption(getListSort(view));
    }
    if (revision !== switchRevision) {
        return;
    }
    if (render) await script.printCharacters(false);
}

/**
 * Gets the active main list view.
 * @returns {'characters'|'groups'}
 */
export function getCharacterListView() {
    return activeView;
}

/**
 * Gets the sort settings for a main list view.
 * @param {'characters'|'groups'} view
 * @returns {{ field: string, order: string, rule: string|null }}
 */
export function getListSort(view) {
    assertView(view);
    if (view === 'characters') {
        return normalizeSort(readCharacterSort(), { field: 'name', order: 'asc', rule: null });
    }

    const stored = accountStorage.getItem(GROUP_SORT_STORAGE_KEY);
    if (!stored) {
        return { ...DEFAULT_GROUP_SORT };
    }

    try {
        return parseGroupSort(JSON.parse(stored)) ?? { ...DEFAULT_GROUP_SORT };
    } catch {
        return { ...DEFAULT_GROUP_SORT };
    }
}

/**
 * Sets the sort settings for a main list view and re-renders it.
 * @param {'characters'|'groups'} view
 * @param {{ field: string, order: string, rule?: string|null }} sort
 * @returns {Promise<void>}
 */
export function setListSort(view, sort) {
    assertView(view);
    const normalized = view === 'groups' ? parseGroupSort(sort) : normalizeSort(sort, readCharacterSort());
    if (!normalized) {
        throw new TypeError('Invalid group list sort settings');
    }
    if (view === 'characters') {
        writeCharacterSort(normalized);
    } else {
        accountStorage.setItem(GROUP_SORT_STORAGE_KEY, JSON.stringify(normalized));
    }
    if (view === activeView && !document.getElementById('character_search_bar')?.value) {
        selectNativeSortOption(normalized);
    }
    return scheduleRender();
}

/**
 * Gets the sort options valid for a main list view.
 * @param {'characters'|'groups'} view
 * @returns {Array<{ field: string, order: string, rule?: string, label: string, i18nKey: string }>}
 */
export function getListSortOptions(view) {
    assertView(view);
    const options = Array.from(document.querySelectorAll('#character_sort_order option'))
        .map(option => ({
            field: String(option.dataset.field ?? ''),
            order: String(option.dataset.order ?? ''),
            ...(option.dataset.rule ? { rule: option.dataset.rule } : {}),
            label: option.textContent.trim(),
            i18nKey: option.dataset.i18n ?? option.textContent.trim(),
        }))
        .filter(option => option.field && option.field !== 'search' && option.order);
    if (view === 'characters') {
        return options;
    }

    return options.filter(option => GROUP_SORT_FIELDS.has(option.field));
}

/**
 * Gets the persisted page size for a main list view.
 * @param {'characters'|'groups'} view
 * @returns {number}
 */
export function getListPageSize(view) {
    assertView(view);
    const storedSize = Number(accountStorage.getItem(PAGE_SIZE_KEYS[view]));
    return Number.isInteger(storedSize) && storedSize > 0 ? storedSize : DEFAULT_PAGE_SIZE;
}

/**
 * Persists a view's page size. The paginator applies its size before requesting a render.
 * @param {'characters'|'groups'} view
 * @param {number} size
 */
export function setListPageSize(view, size) {
    assertView(view);
    const parsedSize = Number(size);
    if (!Number.isInteger(parsedSize) || parsedSize <= 0) {
        throw new RangeError(`Invalid character list page size: ${size}`);
    }
    accountStorage.setItem(PAGE_SIZE_KEYS[view], String(parsedSize));
}

/**
 * Gets the in-memory page for a main list view.
 * @param {'characters'|'groups'} view
 * @returns {number}
 */
export function getListPage(view) {
    assertView(view);
    return viewState.get(view).page;
}

/**
 * Sets the in-memory page for a main list view.
 * @param {'characters'|'groups'} view
 * @param {number} page
 * @returns {Promise<void>}
 */
export function setListPage(view, page) {
    assertView(view);
    const parsedPage = Number(page);
    if (!Number.isInteger(parsedPage) || parsedPage < 1) {
        throw new RangeError(`Invalid character list page: ${page}`);
    }
    viewState.get(view).page = parsedPage;
    return view === activeView ? scheduleRender() : Promise.resolve();
}

/**
 * Records a page after the upstream pagination fallback without triggering another render.
 * @param {'characters'|'groups'} view
 * @param {number} page
 */
export function recordListPage(view, page) {
    assertView(view);
    if (Number.isInteger(page) && page >= 1) {
        viewState.get(view).page = page;
    }
}

/**
 * Resets a view's page after a full data refresh.
 * @param {'characters'|'groups'} view
 */
export function resetListPage(view) {
    assertView(view);
    viewState.get(view).page = 1;
}
