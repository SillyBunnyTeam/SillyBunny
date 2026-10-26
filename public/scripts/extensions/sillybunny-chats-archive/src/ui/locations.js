import { filterRows, ownerFilterKey, parseOwnerFilter, physicalChatKey } from '../core.js';
import { placeholderCopy, tr } from './dom.js';
import { ownerLabel } from './rows.js';
import {
    currentLocation,
    filtersActive,
    locationAllowedByTypes,
    locationKey,
} from './view-model.js';

const SORTERS = {
    recent: (a, b) => b.latest - a.latest,
    oldest: (a, b) => a.latest - b.latest,
    size: (a, b) => b.size - a.size,
    smallest: (a, b) => a.size - b.size,
    count: (a, b) => b.messages - a.messages,
    fewest: (a, b) => a.messages - b.messages,
    name: (a, b) => a.label.localeCompare(b.label),
    'name-reverse': (a, b) => b.label.localeCompare(a.label),
    owner: (a, b) => a.label.localeCompare(b.label),
};

function emptyStats() {
    return { count: 0, latest: 0, size: 0, messages: 0 };
}

function tally(stats, row) {
    stats.count++;
    if (Number.isFinite(row.mtime) && row.mtimeKnown !== false) {
        stats.latest = Math.max(stats.latest, row.mtime);
    }
    if (Number.isFinite(row.sizeBytes) && row.sizeKnown !== false) {
        stats.size += row.sizeBytes;
    }
    if (Number.isFinite(row.count)) {
        stats.messages += row.count;
    }
}

function bucket(map, key, row) {
    let stats = map.get(key);
    if (!stats) {
        stats = { ...emptyStats(), row };
        map.set(key, stats);
    }
    tally(stats, row);
}

function sortEntries(entries, sortKey) {
    const sorter = SORTERS[sortKey] ?? SORTERS.recent;
    return entries.sort((a, b) => sorter(a, b) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

export function buildLocations(ctx, { base, catalog, model, organization, searching }) {
    const filtering = filtersActive(model);
    const selected = currentLocation(model);
    const selectedKey = locationKey(selected);
    const totals = { all: emptyStats(), favorites: emptyStats(), orphan: emptyStats() };
    const owners = new Map();
    const folders = new Map();
    const collections = new Map();
    for (const row of base) {
        const metadata = organization?.chats?.[physicalChatKey(row)];
        tally(totals.all, row);
        if (metadata?.favorite === true) {
            tally(totals.favorites, row);
        }
        if (row.kind === 'orphan') {
            tally(totals.orphan, row);
        }
        const owner = row.kind === 'orphan' ? '' : ownerFilterKey(row);
        if (owner) {
            bucket(owners, owner, row);
        }
        bucket(folders, metadata?.folder ?? null, row);
        for (const id of metadata?.collections ?? []) {
            bucket(collections, id, row);
        }
    }

    const make = (type, value, label, stats = emptyStats(), extra = {}) => {
        const key = locationKey({ type, value });
        return { type, value, key, label, ...stats, selected: key === selectedKey, ...extra };
    };
    const missingOwnerRows = selected.type === 'owner' && !owners.has(selected.value)
        ? filterRows(catalog, { owner: selected.value }, organization)
        : [];
    const selectedOwnerRow = missingOwnerRows.find(row => row.kind !== 'orphan');
    const ownerEntries = kind => {
        const entries = [...owners]
            .filter(([value]) => parseOwnerFilter(value)?.kind === kind)
            .map(([value, stats]) => make('owner', value, ownerLabel(ctx, stats.row), stats, {
                avatar: stats.row.kind === 'solo' ? stats.row.avatar : null,
                icon: kind === 'group' ? 'fa-users' : 'fa-user',
                id: parseOwnerFilter(value).id,
            }));
        if (selectedOwnerRow && parseOwnerFilter(selected.value)?.kind === kind) {
            entries.push(make('owner', selected.value, ownerLabel(ctx, selectedOwnerRow), emptyStats(), {
                avatar: selectedOwnerRow.kind === 'solo' ? selectedOwnerRow.avatar : null,
                icon: kind === 'group' ? 'fa-users' : 'fa-user',
                id: parseOwnerFilter(selected.value).id,
            }));
        }
        const labelCounts = new Map();
        for (const { label } of entries) {
            const folded = label.toLocaleLowerCase();
            labelCounts.set(folded, (labelCounts.get(folded) ?? 0) + 1);
        }
        for (const item of entries) {
            if (labelCounts.get(item.label.toLocaleLowerCase()) > 1) {
                item.hint = tr(ctx, kind === 'character' ? 'Character: {name}' : 'Group: {name}', { name: item.id });
            }
        }
        return entries;
    };
    const folderEntries = (organization?.folders ?? [])
        .map(folder => make('folder', folder.id, folder.name, folders.get(folder.id), { icon: 'fa-folder', organizational: true }));
    const unfiled = make('folder', null, tr(ctx, 'Unfiled'), folders.get(null), { icon: 'fa-folder-open', organizational: true });
    const collectionEntries = (organization?.collections ?? [])
        .map(collection => make('collection', collection.id, collection.name, collections.get(collection.id), {
            icon: 'fa-layer-group',
            organizational: true,
        }));

    const all = make('all', '', placeholderCopy(), totals.all, { icon: 'fa-inbox', placeholder: true });
    const favorites = make('favorites', '', tr(ctx, 'Favorites'), totals.favorites, { icon: 'fa-star' });
    const orphans = make('orphan', '', tr(ctx, 'Orphaned'), totals.orphan, { icon: 'fa-triangle-exclamation', organizational: true });
    const unavailable = [];
    if (selected.type === 'owner' && !owners.has(selected.value) && !selectedOwnerRow) {
        const identity = parseOwnerFilter(selected.value);
        const label = missingOwnerRows[0] ? ownerLabel(ctx, missingOwnerRows[0]) : identity?.id ?? selected.value;
        const count = filterRows(base, { owner: selected.value }, organization).length;
        unavailable.push(make('owner', selected.value, label, { ...emptyStats(), count }, {
            icon: identity?.kind === 'group' ? 'fa-users' : 'fa-user-slash',
            hint: tr(ctx, !identity ? 'Saved filter' : identity.kind === 'character' ? 'Character unavailable' : 'Group unavailable'),
        }));
    }

    const visible = item => locationAllowedByTypes(model, item) && (
        item.type === 'all'
        || item.count > 0
        || (item.selected && (searching || !filtering))
        || (item.organizational === true && !searching && !filtering)
    );
    const sorted = (entries, tail = []) => [...sortEntries(entries.filter(visible), model.sort), ...tail.filter(visible)];
    const sections = [
        { id: 'primary', heading: '', entries: [all, favorites].filter(visible) },
        { id: 'characters', heading: tr(ctx, 'Characters'), entries: sorted(ownerEntries('character')) },
        { id: 'groups', heading: tr(ctx, 'Groups'), entries: sorted(ownerEntries('group')) },
        { id: 'folders', heading: tr(ctx, 'Folders'), entries: sorted(folderEntries, [unfiled]) },
        { id: 'collections', heading: tr(ctx, 'Collections'), entries: sorted(collectionEntries) },
        { id: 'orphans', heading: '', entries: [orphans].filter(visible) },
        { id: 'unavailable', heading: placeholderCopy(), placeholder: true, entries: unavailable.filter(visible) },
    ].filter(section => section.entries.length > 0);

    const shown = sections.flatMap(section => section.entries);
    const current = shown.find(item => item.key === selectedKey);
    return { sections, current: current ?? all, fallback: selected.type !== 'all' && !current };
}
