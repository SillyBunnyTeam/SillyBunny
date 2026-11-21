import { filterRows, normalizeSavedView, parseOwnerFilter } from '../core.js';
import { KINDS, UNFILED_VALUE } from './constants.js';

/**
 * The archive's view state, kept apart from the saved-view shape so that choosing a location never
 * disturbs the Filters type checks. `group` and `density` have no controls; they ride along so saved
 * views round-trip them unchanged.
 */

const ALL_TYPES = KINDS.map(([kind]) => kind);
const RANGE_FIELDS = ['minDate', 'maxDate', 'minSize', 'maxSize', 'minMessages', 'maxMessages'];

export const ALL_LOCATION = Object.freeze({ type: 'all', value: '' });

function isOrphanOnly(kinds) {
    return Array.isArray(kinds) && kinds.length === 1 && kinds[0] === 'orphan';
}

export function createViewModel(view = {}) {
    const orphanOnly = isOrphanOnly(view.kinds);
    return {
        types: new Set(orphanOnly || !Array.isArray(view.kinds) ? ALL_TYPES : view.kinds),
        orphanOnly,
        favorite: view.favorite,
        owner: view.owner ?? '',
        folder: view.folder,
        collection: view.collection ?? '',
        orphan: view.orphan ?? '',
        tag: view.tag ?? '',
        ...Object.fromEntries(RANGE_FIELDS.map(field => [field, view[field]])),
        sort: view.sort ?? 'recent',
        group: view.group,
        density: view.density,
    };
}

export function modelToView(model, query, organization) {
    const view = {
        query,
        kinds: model.orphanOnly ? ['orphan'] : ALL_TYPES.filter(kind => model.types.has(kind)),
        sort: model.sort,
        group: model.group,
        density: model.density,
        owner: model.owner,
        orphan: model.orphan,
        tag: model.tag,
        ...Object.fromEntries(RANGE_FIELDS.map(field => [field, model[field]])),
    };
    if (model.favorite !== undefined) {
        view.favorite = model.favorite;
    }
    if (model.folder !== undefined) {
        view.folder = model.folder;
    }
    if (model.collection) {
        view.collection = model.collection;
    }
    return normalizeSavedView(view, organization);
}

function locationFields(model) {
    const fields = [];
    if (model.owner) {
        fields.push({ type: 'owner', value: model.owner });
    }
    if (model.folder !== undefined) {
        fields.push({ type: 'folder', value: model.folder });
    }
    if (model.collection) {
        fields.push({ type: 'collection', value: model.collection });
    }
    if (model.favorite === true) {
        fields.push({ type: 'favorites', value: '' });
    }
    if (model.orphanOnly) {
        fields.push({ type: 'orphan', value: '' });
    }
    return fields;
}

/** A location is exactly one location field; a legacy view that sets several selects All Chats and keeps them applied. */
export function currentLocation(model) {
    const fields = locationFields(model);
    return fields.length === 1 ? fields[0] : ALL_LOCATION;
}

export function hasConflictingLocations(model) {
    return locationFields(model).length > 1;
}

export function locationKey({ type, value }) {
    if (type === 'folder') {
        return `folder:${value ?? UNFILED_VALUE}`;
    }
    return value ? `${type}:${value}` : type;
}

export function withLocation(model, { type, value }) {
    return {
        ...model,
        owner: type === 'owner' ? value : '',
        folder: type === 'folder' ? value : undefined,
        collection: type === 'collection' ? value : '',
        orphanOnly: type === 'orphan',
        favorite: type === 'favorites' ? true : model.favorite === true ? undefined : model.favorite,
    };
}

export function resetFilters(model) {
    return {
        ...(hasConflictingLocations(model) ? withLocation(model, ALL_LOCATION) : model),
        types: new Set(ALL_TYPES),
        favorite: model.favorite === true && !hasConflictingLocations(model) ? true : undefined,
        orphan: '',
        tag: '',
        ...Object.fromEntries(RANGE_FIELDS.map(field => [field, undefined])),
    };
}

export function filtersActive(model) {
    return model.types.size !== ALL_TYPES.length
        || model.favorite === false
        || hasConflictingLocations(model)
        || Boolean(model.orphan || model.tag)
        || RANGE_FIELDS.some(field => model[field] !== undefined);
}

/** Whether a location's sidebar section is switched off by the Filters type checks. */
export function locationAllowedByTypes(model, { type, value }) {
    if (type === 'owner') {
        return model.types.has(parseOwnerFilter(value)?.kind === 'group' ? 'group' : 'solo');
    }
    if (type === 'orphan') {
        return model.types.has('orphan');
    }
    return type !== 'favorites' || model.favorite !== false;
}

function baseFilterOptions(model, text) {
    return {
        text,
        kinds: [...model.types],
        // An active Favorites category keeps favourites listed even when their own chat type is off.
        favoritesSelected: model.favorite !== false,
        favorite: model.favorite === false ? false : undefined,
        orphan: model.orphan,
        tag: model.tag,
        ...Object.fromEntries(RANGE_FIELDS.map(field => [field, model[field]])),
    };
}

function locationFilterOptions(model) {
    const options = { owner: model.owner, collection: model.collection };
    if (model.folder !== undefined) {
        options.folder = model.folder;
    }
    if (model.favorite === true) {
        options.favorite = true;
    }
    return options;
}

export function filterBase(rows, model, text, organization) {
    return filterRows(rows, baseFilterOptions(model, text), organization);
}

export function filterByLocation(rows, model, organization) {
    const scoped = filterRows(rows, locationFilterOptions(model), organization);
    return model.orphanOnly ? scoped.filter(row => row.kind === 'orphan') : scoped;
}
