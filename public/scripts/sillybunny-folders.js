/**
 * Joins the folders in upstream's image-metadata index with the presentation records in `power_user.sb_folders.backgrounds`.
 * The index decides which folders exist and what they are called. The scope decides their order, colour and expanded state.
 * A scope record whose folder the index no longer has is skipped, and an indexed folder with no record gets the defaults.
 * It lives in this file, which loads at startup, because the gallery's own modules load with the Appearance page.
 * @param {Array<{ id: string, color?: string, expanded?: boolean }>} stored
 * @param {Array<{ id: string, name: string }>} indexed
 * @returns {Array<{ id: string, name: string, color: string, expanded: boolean }>}
 */
export function mergeBackgroundFolders(stored, indexed) {
    const byId = new Map(indexed.map(folder => [folder.id, folder]));
    const merged = [];
    const seen = new Set();
    for (const record of stored) {
        const folder = byId.get(record?.id);
        if (!folder || seen.has(folder.id)) continue;
        seen.add(folder.id);
        merged.push({ id: folder.id, name: folder.name, color: typeof record.color === 'string' ? record.color : '', expanded: record.expanded !== false });
    }
    for (const folder of indexed) {
        if (seen.has(folder.id)) continue;
        seen.add(folder.id);
        merged.push({ id: folder.id, name: folder.name, color: '', expanded: true });
    }
    return merged;
}

const SCOPES = new Set(['characters', 'groups', 'personas', 'backgrounds']);
// Settings saved before persona or background folders existed have no such scope; it is created on the first write so they load unchanged.
const LAZY_SCOPES = new Set(['personas', 'backgrounds']);
const FOLDER_TYPES = new Set(['OPEN', 'CLOSED']);
const listeners = new Set();
const EMPTY_STORE = Object.freeze({
    characters: Object.freeze({ folders: Object.freeze([]), members: Object.freeze({}) }),
    groups: Object.freeze({ folders: Object.freeze([]), members: Object.freeze({}) }),
    personas: Object.freeze({ folders: Object.freeze([]), members: Object.freeze({}) }),
    backgrounds: Object.freeze({ folders: Object.freeze([]), members: Object.freeze({}) }),
});
/*
 * The Backgrounds scope keeps only what upstream's image-metadata index has no field for: order, colour and the expanded state.
 * The folders' names and the files' memberships stay in that index, which the gallery reads and writes through upstream's routes.
 * `backgroundIndex` is the in-memory copy of it (a file maps to the ids of every folder it is in), and `backgroundBridge`
 * sends each change to those routes. The scope's own `members` stay empty.
 */
let backgroundIndex = { folders: [], members: {} };
let backgroundBridge = null;

let powerUser;
let saveSettings = () => {};
let createId = fallbackId;
let installedEventSource;
let installedEventTypes;
let revision = 0;

function fallbackId() {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    return `folder-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function requireScope(scope) {
    if (!SCOPES.has(scope)) throw new TypeError(`Invalid folder scope: ${scope}`);
    return scope;
}

function currentFolders() {
    if (!powerUser) throw new Error('The SillyBunny folder store has not been configured.');
    return powerUser.sb_folders;
}

function readFolderScope(scope) {
    const stored = powerUser?.sb_folders?.[requireScope(scope)] ?? EMPTY_STORE[scope];
    if (scope !== 'backgrounds') return stored;
    return { folders: mergeBackgroundFolders(stored.folders, backgroundIndex.folders), members: {} };
}

function backgroundMemberIds(file) {
    const known = new Set(backgroundIndex.folders.map(folder => folder.id));
    return (backgroundIndex.members[file] ?? []).filter(id => known.has(id));
}

/** Writes the merged folder list into settings, so a change to one folder's state keeps the order the user sees. Records of folders the index lost stay at the end. */
function writeBackgroundRecords(mutate) {
    const merged = readFolderScope('backgrounds').folders;
    mutate(merged);
    const store = writableScope('backgrounds');
    const stale = store.folders.filter(record => !backgroundIndex.folders.some(folder => folder.id === record.id));
    store.folders = [...merged.map(folder => ({ id: folder.id, name: folder.name, color: folder.color, expanded: folder.expanded })), ...stale];
}

function writableScope(scope) {
    const store = currentFolders();
    store[scope] ??= { folders: [], members: {} };
    return store[scope];
}

function notifyChange(scope, reason) {
    revision++;
    const change = Object.freeze({ revision, scope, reason });
    for (const listener of [...listeners]) listener(change);
}

function persistChange(scope, reason) {
    saveSettings();
    notifyChange(scope, reason);
}

function parseFolderName(name) {
    if (typeof name !== 'string' || !name.trim()) throw new RangeError('Folder names must not be empty.');
    return name.trim();
}

function parseKeys(keys) {
    if (typeof keys === 'string') keys = [keys];
    if (!keys || typeof keys[Symbol.iterator] !== 'function') throw new TypeError('Folder member keys must be an iterable of strings.');
    const normalized = [...new Set([...keys].map(key => {
        if (typeof key !== 'string' || !key) throw new TypeError('Folder member keys must be non-empty strings.');
        return key;
    }))];
    return normalized;
}

function generateUniqueId(existing, idFactory) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const id = String(idFactory()).trim();
        if (id && !existing.has(id)) return id;
    }
    throw new Error('Folder id generation did not produce a unique non-empty id.');
}

function folderById(scope, id) {
    return readFolderScope(scope).folders.find(folder => folder.id === String(id));
}

function isEquivalent(first, second) {
    return JSON.stringify(first) === JSON.stringify(second);
}

function normalizeFolderCollection(value, idFactory) {
    const source = Array.isArray(value) ? value : [];
    const folders = [];
    const ids = new Set();
    for (const entry of source) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!name) continue;
        let id = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (!id || ids.has(id)) id = generateUniqueId(ids, idFactory);
        ids.add(id);
        folders.push({
            id,
            name,
            color: typeof entry.color === 'string' ? entry.color.trim() : '',
            expanded: entry.expanded !== false,
        });
    }
    return folders;
}

function normalizeMembers(value, folders) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const folderIds = new Set(folders.map(folder => folder.id));
    return Object.fromEntries(Object.entries(value).filter(([key, id]) => key && typeof id === 'string' && folderIds.has(id)));
}

/**
 * Parses persisted folder settings into the supported one-level schema.
 * @param {unknown} value
 * @param {() => string} [idFactory]
 * @returns {{ version: 1, migratedFromTags: boolean, characters: object, groups: object, personas?: object }}
 */
export function normalizeFoldersData(value, idFactory = fallbackId) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const characters = normalizeFolderCollection(source.characters?.folders, idFactory);
    const groups = normalizeFolderCollection(source.groups?.folders, idFactory);
    const normalized = {
        version: 1,
        migratedFromTags: source.migratedFromTags === true,
        characters: {
            folders: characters,
            members: normalizeMembers(source.characters?.members, characters),
        },
        groups: {
            folders: groups,
            members: normalizeMembers(source.groups?.members, groups),
        },
    };
    for (const scope of LAZY_SCOPES) {
        const saved = source[scope];
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) continue;
        const scopeFolders = normalizeFolderCollection(saved.folders, idFactory);
        normalized[scope] = { folders: scopeFolders, members: normalizeMembers(saved.members, scopeFolders) };
    }
    return normalized;
}

const IDENTITY_LISTENERS = Object.freeze([
    ['CHARACTER_RENAMED', onCharacterRenamed],
    ['CHARACTER_DUPLICATED', onCharacterDuplicated],
    ['CHARACTER_DELETED', onCharacterDeleted],
    ['PERSONA_CREATED', onPersonaCreated],
    ['PERSONA_DELETED', onPersonaDeleted],
]);

function attachIdentityListeners(eventSource, eventTypes) {
    if (!eventSource?.on || !eventTypes || installedEventSource === eventSource) return;
    if (installedEventSource && installedEventTypes) {
        for (const [name, listener] of IDENTITY_LISTENERS) {
            if (installedEventTypes[name]) installedEventSource.removeListener(installedEventTypes[name], listener);
        }
    }
    installedEventSource = eventSource;
    installedEventTypes = eventTypes;
    for (const [name, listener] of IDENTITY_LISTENERS) {
        if (eventTypes[name]) eventSource.on(eventTypes[name], listener);
    }
}

function onCharacterRenamed(oldAvatar, newAvatar) {
    if (typeof oldAvatar !== 'string' || !oldAvatar || typeof newAvatar !== 'string' || !newAvatar) return;
    const members = currentFolders().characters.members;
    if (!Object.hasOwn(members, oldAvatar)) return;
    members[newAvatar] = members[oldAvatar];
    delete members[oldAvatar];
    persistChange('characters', 'rename-member');
}

function onCharacterDuplicated({ oldAvatar, newAvatar } = {}) {
    const folderId = getFolderId('characters', oldAvatar);
    if (!folderId || typeof newAvatar !== 'string' || !newAvatar) return;
    currentFolders().characters.members[newAvatar] = folderId;
    persistChange('characters', 'duplicate-member');
}

function onCharacterDeleted({ character } = {}) {
    const avatar = character?.avatar;
    if (typeof avatar !== 'string' || !Object.hasOwn(currentFolders().characters.members, avatar)) return;
    delete currentFolders().characters.members[avatar];
    persistChange('characters', 'delete-member');
}

// A persona keeps its avatar id across renames, so only duplicate and delete touch membership.
function onPersonaCreated({ avatarId, duplicatedFromAvatarId } = {}) {
    const folderId = getFolderId('personas', duplicatedFromAvatarId);
    if (!folderId || typeof avatarId !== 'string' || !avatarId) return;
    writableScope('personas').members[avatarId] = folderId;
    persistChange('personas', 'duplicate-member');
}

function onPersonaDeleted({ avatarId } = {}) {
    removeEntityKey('personas', avatarId);
}

/**
 * Binds the settings persistence and upstream character identity events.
 * @param {{ powerUser: object, saveSettingsDebounced: () => void, idFactory?: () => string, eventSource?: object, eventTypes?: object }} options
 */
export function configureFolderStore({ powerUser: settings, saveSettingsDebounced, idFactory, eventSource, eventTypes } = {}) {
    if (!settings || typeof settings !== 'object') throw new TypeError('Folder store requires the power-user settings object.');
    if (typeof saveSettingsDebounced !== 'function') throw new TypeError('Folder store requires saveSettingsDebounced.');
    powerUser = settings;
    saveSettings = saveSettingsDebounced;
    if (typeof idFactory === 'function') createId = idFactory;
    attachIdentityListeners(eventSource, eventTypes);
}

/** Returns folders in display order as detached records. */
export function getFolders(scope) {
    return readFolderScope(scope).folders.map(folder => ({ ...folder }));
}

/** Returns the folder id for a member, or null when it is unfiled. */
export function getFolderId(scope, key) {
    if (typeof key !== 'string' || !key) return null;
    // A background that upstream data placed in several folders reports the first; the gallery shows it in each until it is moved.
    if (requireScope(scope) === 'backgrounds') return backgroundMemberIds(key)[0] ?? null;
    return readFolderScope(scope).members[key] ?? null;
}

/** Returns the member keys assigned to a folder in key insertion order. */
export function getFolderMembers(scope, folderId) {
    const id = String(folderId);
    if (requireScope(scope) === 'backgrounds') {
        return Object.keys(backgroundIndex.members).filter(file => backgroundMemberIds(file).includes(id));
    }
    const store = readFolderScope(scope);
    return Object.entries(store.members)
        .filter(([, memberFolderId]) => memberFolderId === id)
        .map(([key]) => key);
}

/** Assigns each key to one folder, or unfiles it when folderId is null. */
export function setFolder(scope, keys, folderIdOrNull) {
    requireScope(scope);
    const normalizedKeys = parseKeys(keys);
    if (scope === 'backgrounds') return moveBackgrounds(normalizedKeys, folderIdOrNull);
    let folderId = null;
    if (folderIdOrNull !== null && folderIdOrNull !== undefined) {
        folderId = String(folderIdOrNull);
        if (!folderById(scope, folderId)) throw new RangeError(`Unknown folder id: ${folderId}`);
    } else if (!currentFolders()[scope]) {
        return false;
    }
    const members = writableScope(scope).members;
    let changed = false;
    for (const key of normalizedKeys) {
        if (folderId === null) {
            if (!Object.hasOwn(members, key)) continue;
            delete members[key];
            changed = true;
            continue;
        }
        if (members[key] === folderId) continue;
        members[key] = folderId;
        changed = true;
    }
    if (changed) persistChange(scope, 'set-members');
    return changed;
}

/** Creates a folder and returns its persisted record. */
export function createFolder(scope, name, { color = '', expanded = true, id = '' } = {}) {
    requireScope(scope);
    if (scope === 'backgrounds') return createBackgroundFolder(name, { color, expanded, id });
    const store = writableScope(scope);
    const existingIds = new Set(store.folders.map(entry => entry.id));
    const folder = {
        id: generateUniqueId(existingIds, createId),
        name: parseFolderName(name),
        color: typeof color === 'string' ? color.trim() : '',
        expanded: Boolean(expanded),
    };
    store.folders.push(folder);
    persistChange(scope, 'create-folder');
    return { ...folder };
}

/** Renames a folder; folder names may be duplicated. */
export function renameFolder(scope, folderId, name) {
    requireScope(scope);
    const folder = folderById(scope, folderId);
    if (!folder) return false;
    const nextName = parseFolderName(name);
    if (folder.name === nextName) return false;
    if (scope === 'backgrounds') return renameBackgroundFolder(folder.id, nextName);
    folder.name = nextName;
    persistChange(scope, 'rename-folder');
    return true;
}

/** Deletes a folder and leaves its members unfiled. */
export function deleteFolder(scope, folderId) {
    requireScope(scope);
    currentFolders();
    if (scope === 'backgrounds') return deleteBackgroundFolder(String(folderId));
    const store = readFolderScope(scope);
    const id = String(folderId);
    const index = store.folders.findIndex(folder => folder.id === id);
    if (index < 0) return false;
    store.folders.splice(index, 1);
    for (const [key, memberFolderId] of Object.entries(store.members)) {
        if (memberFolderId === id) delete store.members[key];
    }
    persistChange(scope, 'delete-folder');
    return true;
}

/** Reorders a folder by an integer delta and returns whether it moved. */
export function moveFolder(scope, folderId, delta) {
    requireScope(scope);
    if (!Number.isInteger(delta)) throw new TypeError('Folder order delta must be an integer.');
    currentFolders();
    if (scope === 'backgrounds') return moveBackgroundFolder(String(folderId), delta);
    const folders = readFolderScope(scope).folders;
    const index = folders.findIndex(folder => folder.id === String(folderId));
    const target = index + delta;
    if (index < 0 || target < 0 || target >= folders.length || delta === 0) return false;
    const [folder] = folders.splice(index, 1);
    folders.splice(target, 0, folder);
    persistChange(scope, 'move-folder');
    return true;
}

/** Changes a folder's decorative colour. */
export function setFolderColor(scope, folderId, color) {
    requireScope(scope);
    const folder = folderById(scope, folderId);
    if (!folder) return false;
    const nextColor = typeof color === 'string' ? color.trim() : '';
    if (folder.color === nextColor) return false;
    if (scope === 'backgrounds') return changeBackgroundFolder(folder.id, { color: nextColor }, 'set-folder-color');
    folder.color = nextColor;
    persistChange(scope, 'set-folder-color');
    return true;
}

/** Changes the remembered expanded state. */
export function setFolderExpanded(scope, folderId, expanded) {
    requireScope(scope);
    const folder = folderById(scope, folderId);
    if (!folder) return false;
    const nextExpanded = Boolean(expanded);
    if (folder.expanded === nextExpanded) return false;
    if (scope === 'backgrounds') return changeBackgroundFolder(folder.id, { expanded: nextExpanded }, 'set-folder-expanded');
    folder.expanded = nextExpanded;
    persistChange(scope, 'set-folder-expanded');
    return true;
}

/** Normalizes the live settings value and persists only if it changed. */
export function normalizeFolders() {
    const previous = currentFolders();
    const normalized = normalizeFoldersData(previous, createId);
    if (isEquivalent(previous, normalized)) return false;
    powerUser.sb_folders = normalized;
    persistChange(null, 'normalize');
    return true;
}

/** Removes a deleted character or group key from folder membership. */
export function removeEntityKey(scope, key) {
    requireScope(scope);
    if (typeof key !== 'string' || !key) return false;
    currentFolders();
    if (scope === 'backgrounds') return removeBackgroundFromFolders(key);
    const members = readFolderScope(scope).members;
    if (!Object.hasOwn(members, key)) return false;
    delete members[key];
    persistChange(scope, 'delete-member');
    return true;
}

/** Subscribes to one notification per persisted store mutation. */
export function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Folder store subscribers must be functions.');
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Converts existing tag folders once without changing tags or tag_map. */
export function convertLegacyTagFolders({
    enabled,
    tags = [],
    tagMap = {},
    characters = [],
    groups = [],
    accountStorage,
    entitiesFilter,
    tagFilterType,
    notify,
} = {}) {
    const store = currentFolders();
    if (store.migratedFromTags) return false;
    const folderTags = enabled ? tags.filter(tag => FOLDER_TYPES.has(tag?.folder_type)) : [];
    const folderTagIds = new Set(folderTags.map(tag => String(tag.id)));
    let convertedCount = 0;

    const migrateScope = (scope, keys) => {
        const folderIds = new Map();
        for (const tag of folderTags) {
            const hasMembers = keys.some(key => Array.isArray(tagMap[key]) && tagMap[key].includes(tag.id));
            if (!hasMembers) continue;
            const folder = {
                id: generateUniqueId(new Set(store[scope].folders.map(folder => folder.id)), createId),
                name: parseFolderName(tag.name),
                color: typeof tag.color === 'string' ? tag.color.trim() : '',
                expanded: tag.folder_type === 'OPEN',
            };
            store[scope].folders.push(folder);
            folderIds.set(String(tag.id), folder.id);
            convertedCount++;
        }
        for (const key of keys) {
            const matchingIds = [...new Set((Array.isArray(tagMap[key]) ? tagMap[key] : [])
                .filter(id => folderTagIds.has(String(id))).map(String))];
            if (matchingIds.length !== 1) continue;
            const folderId = folderIds.get(matchingIds[0]);
            if (folderId) store[scope].members[key] = folderId;
        }
    };

    if (enabled) {
        migrateScope('characters', characters.map(character => character?.avatar).filter(key => typeof key === 'string' && key));
        migrateScope('groups', groups.map(group => group?.id).filter(key => typeof key === 'string' && key));
        for (const id of folderTagIds) {
            accountStorage?.removeItem?.(`CharacterList_tag_${id}`);
            accountStorage?.removeItem?.(`GroupList_tag_${id}`);
        }
        const filterData = entitiesFilter?.getFilterData?.(tagFilterType);
        if (filterData) {
            const selected = Array.isArray(filterData.selected) ? filterData.selected : [];
            const excluded = Array.isArray(filterData.excluded) ? filterData.excluded : [];
            const next = {
                selected: selected.filter(id => !folderTagIds.has(String(id))),
                excluded: excluded.filter(id => !folderTagIds.has(String(id))),
            };
            if (!isEquivalent(filterData, next)) entitiesFilter.setFilterData(tagFilterType, next, true);
        }
    }

    store.migratedFromTags = true;
    persistChange(null, 'migrate-tags');
    if (convertedCount > 0) notify?.();
    return convertedCount > 0;
}

/** Takes keys out of one folder and leaves any other folder they are in. For the single-folder scopes this is the same as unfiling them. */
export function removeFromFolder(scope, keys, folderId) {
    requireScope(scope);
    const normalizedKeys = parseKeys(keys);
    const id = String(folderId);
    if (scope !== 'backgrounds') {
        const inFolder = normalizedKeys.filter(key => getFolderId(scope, key) === id);
        return inFolder.length > 0 && setFolder(scope, inFolder, null);
    }
    const previous = {};
    for (const key of normalizedKeys) {
        const ids = backgroundMemberIds(key);
        if (!ids.includes(id)) continue;
        previous[key] = ids;
        const rest = ids.filter(candidate => candidate !== id);
        if (rest.length) backgroundIndex.members[key] = rest;
        else delete backgroundIndex.members[key];
    }
    if (!Object.keys(previous).length) return false;
    notifyChange(scope, 'set-members');
    backgroundBridge?.unassign?.(previous, id);
    return true;
}

/**
 * Loads upstream's folders and file memberships into the Backgrounds scope. Nothing is written to settings.
 * @param {{ folders: Array<{ id: string, name: string }>, imageFolderMap: Record<string, string[]> }} index
 */
export function hydrateBackgroundIndex({ folders, imageFolderMap }) {
    backgroundIndex = {
        folders: (folders ?? []).filter(folder => folder && typeof folder.id === 'string' && typeof folder.name === 'string').map(folder => ({ id: folder.id, name: folder.name })),
        members: Object.fromEntries(Object.entries(imageFolderMap ?? {}).filter(([, ids]) => Array.isArray(ids) && ids.length).map(([file, ids]) => [file, [...ids]])),
    };
    notifyChange('backgrounds', 'hydrate');
}

/**
 * Connects the Backgrounds scope to upstream's routes. Each hook gets the change after the scope took it.
 * @param {{ move?: Function, unassign?: Function, rename?: Function, remove?: Function }|null} bridge
 */
export function attachBackgroundBridge(bridge) {
    backgroundBridge = bridge;
}

function moveBackgrounds(keys, folderIdOrNull) {
    const target = folderIdOrNull === null || folderIdOrNull === undefined ? null : String(folderIdOrNull);
    if (target && !backgroundIndex.folders.some(folder => folder.id === target)) throw new RangeError(`Unknown folder id: ${target}`);
    const previous = {};
    for (const key of keys) {
        const ids = backgroundMemberIds(key);
        if (target ? ids.length === 1 && ids[0] === target : ids.length === 0) continue;
        previous[key] = ids;
        if (target) backgroundIndex.members[key] = [target];
        else delete backgroundIndex.members[key];
    }
    if (!Object.keys(previous).length) return false;
    notifyChange('backgrounds', 'set-members');
    backgroundBridge?.move?.(previous, target);
    return true;
}

function removeBackgroundFromFolders(file) {
    if (!Object.hasOwn(backgroundIndex.members, file)) return false;
    delete backgroundIndex.members[file];
    notifyChange('backgrounds', 'delete-member');
    return true;
}

function createBackgroundFolder(name, { color, expanded, id }) {
    const folderId = typeof id === 'string' ? id.trim() : '';
    // The id is upstream's. A folder that no route has created yet must not exist here, or a later write would name an id the index does not know.
    if (!folderId) throw new TypeError('A background folder needs the id that the image-metadata route issued.');
    if (backgroundIndex.folders.some(folder => folder.id === folderId)) throw new RangeError(`Duplicate folder id: ${folderId}`);
    const record = { id: folderId, name: parseFolderName(name), color: typeof color === 'string' ? color.trim() : '', expanded: Boolean(expanded) };
    backgroundIndex.folders.push({ id: record.id, name: record.name });
    writeBackgroundRecords(folders => {
        const at = folders.findIndex(folder => folder.id === record.id);
        if (at >= 0) folders[at] = record;
        else folders.push(record);
    });
    persistChange('backgrounds', 'create-folder');
    return { ...record };
}

function renameBackgroundFolder(folderId, name) {
    const indexed = backgroundIndex.folders.find(folder => folder.id === folderId);
    if (!indexed) return false;
    indexed.name = name;
    const recorded = powerUser?.sb_folders?.backgrounds?.folders?.find(record => record.id === folderId);
    if (recorded) recorded.name = name;
    if (recorded) persistChange('backgrounds', 'rename-folder');
    else notifyChange('backgrounds', 'rename-folder');
    backgroundBridge?.rename?.(folderId, name);
    return true;
}

function deleteBackgroundFolder(folderId) {
    const at = backgroundIndex.folders.findIndex(folder => folder.id === folderId);
    if (at < 0) return false;
    backgroundIndex.folders.splice(at, 1);
    for (const [file, ids] of Object.entries(backgroundIndex.members)) {
        const rest = ids.filter(id => id !== folderId);
        if (rest.length) backgroundIndex.members[file] = rest;
        else delete backgroundIndex.members[file];
    }
    const store = powerUser?.sb_folders?.backgrounds;
    if (store) store.folders = store.folders.filter(record => record.id !== folderId);
    persistChange('backgrounds', 'delete-folder');
    backgroundBridge?.remove?.(folderId);
    return true;
}

function moveBackgroundFolder(folderId, delta) {
    const folders = readFolderScope('backgrounds').folders;
    const index = folders.findIndex(folder => folder.id === folderId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= folders.length || delta === 0) return false;
    writeBackgroundRecords(list => {
        const [folder] = list.splice(index, 1);
        list.splice(target, 0, folder);
    });
    persistChange('backgrounds', 'move-folder');
    return true;
}

function changeBackgroundFolder(folderId, changes, reason) {
    writeBackgroundRecords(list => Object.assign(list.find(folder => folder.id === folderId) ?? {}, changes));
    persistChange('backgrounds', reason);
    return true;
}
