const SCOPES = new Set(['characters', 'groups']);
const FOLDER_TYPES = new Set(['OPEN', 'CLOSED']);
const listeners = new Set();
const EMPTY_STORE = Object.freeze({
    characters: Object.freeze({ folders: Object.freeze([]), members: Object.freeze({}) }),
    groups: Object.freeze({ folders: Object.freeze([]), members: Object.freeze({}) }),
});
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
    return powerUser?.sb_folders?.[requireScope(scope)] ?? EMPTY_STORE[scope];
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
 * @returns {{ version: 1, migratedFromTags: boolean, characters: object, groups: object }}
 */
export function normalizeFoldersData(value, idFactory = fallbackId) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const characters = normalizeFolderCollection(source.characters?.folders, idFactory);
    const groups = normalizeFolderCollection(source.groups?.folders, idFactory);
    return {
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
}

function attachIdentityListeners(eventSource, eventTypes) {
    if (!eventSource?.on || !eventTypes || installedEventSource === eventSource) return;
    if (installedEventSource && installedEventTypes) {
        installedEventSource.removeListener(installedEventTypes.CHARACTER_RENAMED, onCharacterRenamed);
        installedEventSource.removeListener(installedEventTypes.CHARACTER_DUPLICATED, onCharacterDuplicated);
        installedEventSource.removeListener(installedEventTypes.CHARACTER_DELETED, onCharacterDeleted);
    }
    installedEventSource = eventSource;
    installedEventTypes = eventTypes;
    eventSource.on(eventTypes.CHARACTER_RENAMED, onCharacterRenamed);
    eventSource.on(eventTypes.CHARACTER_DUPLICATED, onCharacterDuplicated);
    eventSource.on(eventTypes.CHARACTER_DELETED, onCharacterDeleted);
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
    const store = readFolderScope(scope);
    if (typeof key !== 'string' || !key) return null;
    return store.members[key] ?? null;
}

/** Returns the member keys assigned to a folder in key insertion order. */
export function getFolderMembers(scope, folderId) {
    const store = readFolderScope(scope);
    const id = String(folderId);
    return Object.entries(store.members)
        .filter(([, memberFolderId]) => memberFolderId === id)
        .map(([key]) => key);
}

/** Assigns each key to one folder, or unfiles it when folderId is null. */
export function setFolder(scope, keys, folderIdOrNull) {
    requireScope(scope);
    const normalizedKeys = parseKeys(keys);
    const members = currentFolders()[scope].members;
    let folderId = null;
    if (folderIdOrNull !== null && folderIdOrNull !== undefined) {
        folderId = String(folderIdOrNull);
        if (!folderById(scope, folderId)) throw new RangeError(`Unknown folder id: ${folderId}`);
    }
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
export function createFolder(scope, name, { color = '', expanded = true } = {}) {
    requireScope(scope);
    const existingIds = new Set(currentFolders()[scope].folders.map(entry => entry.id));
    const folder = {
        id: generateUniqueId(existingIds, createId),
        name: parseFolderName(name),
        color: typeof color === 'string' ? color.trim() : '',
        expanded: Boolean(expanded),
    };
    currentFolders()[scope].folders.push(folder);
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
    folder.name = nextName;
    persistChange(scope, 'rename-folder');
    return true;
}

/** Deletes a folder and leaves its members unfiled. */
export function deleteFolder(scope, folderId) {
    requireScope(scope);
    const store = currentFolders()[scope];
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
    const folders = currentFolders()[scope].folders;
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
    const members = currentFolders()[scope].members;
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
