// Pure data helpers: no DOM and no fetch.

const SIZE_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
const CHAT_KINDS = new Set(['solo', 'group', 'orphan']);
const ORPHAN_TYPES = new Set(['missing-character', 'missing-group', 'unlinked-group', 'root']);
const SORT_KEYS = new Set(['recent', 'oldest', 'size', 'smallest', 'count', 'fewest', 'name', 'name-reverse', 'owner']);
const GROUP_KEYS = new Set(['flat', 'owner', 'type', 'folder']);
const DENSITIES = new Set(['comfortable', 'compact', 'minimal']);
const OWNER_FILTER_KINDS = new Set(['character', 'group']);
const OWNER_FILTER_PREFIX = '@sbca:';
const PREVIEW_LENGTH = 400;
const JSONL_CHUNK_SIZE = 1000;

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTimestamp(value) {
    const timestamp = Number(value);
    return Number.isFinite(new Date(timestamp).valueOf()) ? timestamp : 0;
}

function trimmed(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function previewText(value, maxLength = Infinity) {
    const preview = trimmed(value).replace(/\s+/g, ' ');
    return preview.length > maxLength ? `${preview.slice(0, maxLength - 3)}...` : preview;
}

function uniqueStrings(values, allowed = null) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const item = trimmed(value);
        const folded = item.toLowerCase();
        if (item && !seen.has(folded) && (!allowed || allowed.has(item))) {
            seen.add(folded);
            result.push(item);
        }
    }
    return result;
}

function uniqueIds(values) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const id = trimmed(value);
        if (id && !seen.has(id)) {
            seen.add(id);
            result.push(id);
        }
    }
    return result;
}

/**
 * Parses the host's human-readable file size ("1.5MB", "512B", "1.2 KB") back to bytes.
 * @param {string} text
 * @returns {number}
 */
export function parseHumanSize(text) {
    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)$/i.exec(String(text ?? '').trim());
    if (!match) {
        return 0;
    }
    const bytes = Number(match[1]) * SIZE_UNITS[match[2].toLowerCase()];
    return Number.isFinite(bytes) ? bytes : 0;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) {
        return '';
    }
    if (value < 1024) {
        return `${value}B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unit = -1;
    do {
        size /= 1024;
        unit++;
    } while (size >= 1024 && unit < units.length - 1);
    return `${Number(size.toFixed(size >= 10 ? 0 : 1))}${units[unit]}`;
}

/**
 * Parses the server's `last_mes` into epoch milliseconds. It is mtimeMs (number)
 * for empty chats but the last message's send_date (string, host-humanized
 * format) otherwise. Pass the host's timestampToMoment to handle those.
 * @param {number|string} value
 * @param {(ts: number|string) => {isValid: () => boolean, valueOf: () => number}} [toMoment]
 * @returns {number}
 */
export function parseLastMes(value, toMoment) {
    if (typeof value === 'number') {
        return validTimestamp(value);
    }
    if (!value) {
        return 0;
    }
    try {
        const moment = toMoment?.(value);
        if (moment?.isValid?.()) {
            return validTimestamp(moment.valueOf());
        }
    } catch {
        // Fall through to Date.parse.
    }
    const parsed = Date.parse(value);
    return validTimestamp(parsed);
}

/**
 * Normalizes one /api/chats/recent row against the loaded character and group lists.
 * Rows carry `avatar` (character chats), `group` (group chats), or neither (root orphans).
 * @param {object} row Raw ChatInfo row from the server
 * @param {Array<{avatar: string, name?: string}>|Map<string, object>} characters
 * @param {Array<{id: string, name?: string}>|Map<string, object>} groups
 * @param {(ts: number|string) => object} [toMoment] Host timestampToMoment for send_date strings
 */
export function normalizeRow(row, characters = [], groups = [], toMoment = undefined) {
    if (!isRecord(row)) {
        return null;
    }
    if ((row.avatar != null && typeof row.avatar !== 'string')
        || (row.group != null && typeof row.group !== 'string' && typeof row.group !== 'number')
        || (row.chatFolder != null && typeof row.chatFolder !== 'string')
        || (row.file_name != null && typeof row.file_name !== 'string')
        || (row.file_id != null && typeof row.file_id !== 'string' && typeof row.file_id !== 'number')) {
        return null;
    }
    const avatar = row.avatar ?? null;
    const chatFolder = row.chatFolder ?? (avatar ? avatar.replace(/\.png$/i, '') : null);
    const groupId = row.group ?? null;
    const character = avatar
        ? characters instanceof Map ? characters.get(avatar) : characters.find(x => x?.avatar === avatar)
        : null;
    const group = groupId !== null
        ? groups instanceof Map ? groups.get(String(groupId)) : groups.find(x => x && String(x.id) === String(groupId))
        : null;

    let kind = 'orphan';
    let ownerName = '';
    let orphanType = 'root';
    if (group) {
        kind = 'group';
        ownerName = group.name || groupId;
    } else if (character) {
        kind = 'solo';
        ownerName = character.name || avatar;
    } else if (avatar) {
        // Chat folder exists but no character PNG resolves to it anymore.
        ownerName = avatar.replace(/\.png$/i, '');
        orphanType = 'missing-character';
    } else if (groupId !== null) {
        ownerName = String(groupId);
        orphanType = 'missing-group';
    }

    const fileName = typeof row.file_name === 'string' ? row.file_name : '';
    const sizeBytes = parseHumanSize(row.file_size);
    const sizeKnown = sizeBytes > 0 || /^\s*0(?:\.0+)?\s*(?:b|kb|mb|gb|tb)\s*$/i.test(String(row.file_size ?? ''));
    const mtime = parseLastMes(row.last_mes, toMoment);
    const countValue = Number(row.chat_items);
    const count = row.chat_items === undefined || row.chat_items === null
        ? null
        : Number.isSafeInteger(countValue) && countValue >= 0 ? countValue : 0;
    return {
        kind,
        orphanType: kind === 'orphan' ? orphanType : null,
        source: row._source ?? 'recent',
        ownerName,
        avatar,
        chatFolder,
        groupId: group ? group.id : groupId,
        file_id: fileName ? fileName.replace(/\.jsonl$/i, '') : String(row.file_id ?? ''),
        file_name: fileName,
        sizeText: row.file_size ?? '',
        sizeBytes,
        sizeKnown,
        count,
        mtime,
        mtimeKnown: mtime !== 0,
        snippet: previewText(row.mes, PREVIEW_LENGTH),
    };
}

/**
 * Maps a Data Maid orphan record into the normalized archive row shape.
 * @param {{name?: string, hash?: string, parent?: string, size?: number, mtime?: number}} record
 * @param {'missing-character'|'unlinked-group'} orphanType
 */
export function dataMaidRecordToRow(record, orphanType) {
    if (!isRecord(record) || typeof record.name !== 'string' || typeof record.hash !== 'string') {
        return null;
    }
    const fileName = String(record.name ?? '');
    const rawSize = Number(record.size);
    const hasSize = Number.isFinite(rawSize) && rawSize >= 0;
    const sizeBytes = hasSize ? rawSize : 0;
    const mtime = parseLastMes(record.mtime);
    const chatFolder = orphanType === 'missing-character' ? String(record.parent ?? '') : null;
    return {
        kind: 'orphan',
        orphanType,
        source: 'data-maid',
        ownerName: chatFolder ?? '',
        avatar: null,
        chatFolder,
        groupId: null,
        file_id: fileName.replace(/\.jsonl$/i, ''),
        file_name: fileName,
        sizeText: hasSize ? formatBytes(sizeBytes) : '',
        sizeBytes,
        sizeKnown: hasSize,
        count: null,
        mtime,
        mtimeKnown: mtime !== 0,
        snippet: '',
        dataMaidHash: String(record.hash ?? ''),
    };
}

export function physicalChatKey(row) {
    const fileId = String(row?.file_id ?? '');
    if (row?.kind === 'group' || row?.orphanType === 'missing-group' || row?.orphanType === 'unlinked-group') {
        return JSON.stringify(['group', fileId]);
    }
    if (row?.kind === 'solo' || row?.orphanType === 'missing-character' || row?.chatFolder || row?.avatar) {
        const folder = row.chatFolder ?? String(row.avatar ?? '').replace(/\.png$/i, '');
        return JSON.stringify(['character', folder, fileId]);
    }
    return JSON.stringify(['root', fileId]);
}

export function ownerFilterKey(row) {
    if (row?.kind === 'group' || row?.orphanType === 'missing-group') {
        const id = row.groupId == null ? '' : String(row.groupId);
        return id ? `${OWNER_FILTER_PREFIX}${JSON.stringify(['group', id])}` : '';
    }
    if (row?.kind === 'solo' || row?.orphanType === 'missing-character') {
        const folder = row.chatFolder ?? String(row.avatar ?? '').replace(/\.png$/i, '');
        return folder ? `${OWNER_FILTER_PREFIX}${JSON.stringify(['character', folder])}` : '';
    }
    return '';
}

export function parseOwnerFilter(value) {
    const selected = trimmed(value);
    if (!selected.startsWith(OWNER_FILTER_PREFIX)) {
        return null;
    }
    try {
        const encoded = selected.slice(OWNER_FILTER_PREFIX.length);
        const parsed = JSON.parse(encoded);
        if (!Array.isArray(parsed)
            || parsed.length !== 2
            || !OWNER_FILTER_KINDS.has(parsed[0])
            || typeof parsed[1] !== 'string'
            || !parsed[1]
            || JSON.stringify(parsed) !== encoded) {
            return null;
        }
        return { kind: parsed[0], id: parsed[1] };
    } catch {
        return null;
    }
}

function matchesOwner(row, owner) {
    const selected = trimmed(owner);
    if (!selected) {
        return true;
    }
    if (parseOwnerFilter(selected)) {
        return ownerFilterKey(row) === selected;
    }
    return [row?.ownerName, row?.groupId, row?.chatFolder, row?.avatar]
        .some(value => String(value ?? '') === selected);
}

function normalizeNamedItems(items, shape = (_item, id, name) => ({ id, name })) {
    const result = [];
    const ids = new Set();
    const names = new Set();
    for (const item of Array.isArray(items) ? items : []) {
        if (!isRecord(item)) {
            continue;
        }
        const id = trimmed(item.id);
        const name = trimmed(item.name);
        const foldedName = name.toLowerCase();
        if (!id || !name || ids.has(id) || names.has(foldedName)) {
            continue;
        }
        const normalized = shape(item, id, name);
        if (normalized) {
            ids.add(id);
            names.add(foldedName);
            result.push(normalized);
        }
    }
    return result;
}

function referenceIds(organization, field) {
    if (!organization) {
        return null;
    }
    return new Set((Array.isArray(organization[field]) ? organization[field] : []).map(item => item.id));
}

export function normalizeSavedView(view, organization = null) {
    if (!isRecord(view)) {
        return {};
    }
    const result = {};
    const query = trimmed(view.query);
    if (query) {
        result.query = query;
    }
    if (Array.isArray(view.kinds)) {
        result.kinds = uniqueStrings(view.kinds, CHAT_KINDS);
    }
    const sort = trimmed(view.sort);
    if (SORT_KEYS.has(sort)) {
        result.sort = sort;
    }
    const group = trimmed(view.group);
    if (GROUP_KEYS.has(group)) {
        result.group = group;
    }
    const density = trimmed(view.density);
    if (DENSITIES.has(density)) {
        result.density = density;
    }
    const owner = trimmed(view.owner);
    if (owner) {
        result.owner = owner;
    }
    const orphan = trimmed(view.orphan);
    if (ORPHAN_TYPES.has(orphan)) {
        result.orphan = orphan;
    }
    if (typeof view.favorite === 'boolean') {
        result.favorite = view.favorite;
    }

    const folderIds = referenceIds(organization, 'folders');
    if (view.folder === null) {
        result.folder = null;
    } else {
        const folder = trimmed(view.folder);
        if (folder && (!folderIds || folderIds.has(folder))) {
            result.folder = folder;
        }
    }
    const collectionIds = referenceIds(organization, 'collections');
    const collection = trimmed(view.collection);
    if (collection && (!collectionIds || collectionIds.has(collection))) {
        result.collection = collection;
    }
    const tag = trimmed(view.tag);
    if (tag) {
        result.tag = tag;
    }

    for (const field of ['minSize', 'maxSize']) {
        if (typeof view[field] === 'number' && Number.isFinite(view[field]) && view[field] >= 0) {
            result[field] = view[field];
        }
    }
    for (const field of ['minMessages', 'maxMessages']) {
        if (Number.isSafeInteger(view[field]) && view[field] >= 0) {
            result[field] = view[field];
        }
    }
    for (const field of ['minDate', 'maxDate']) {
        if (typeof view[field] === 'number' && Number.isFinite(view[field]) && view[field] >= 0) {
            result[field] = view[field];
        } else {
            const date = trimmed(view[field]);
            if (date && Number.isFinite(Date.parse(date))) {
                result[field] = date;
            }
        }
    }
    return result;
}

export function createDefaultOrganization() {
    return { version: 1, lastView: {}, views: [], folders: [], collections: [], chats: {} };
}

export function normalizeOrganization(value) {
    if (!isRecord(value)) {
        throw new TypeError('Organization root must be an object');
    }
    if (value.version !== 1) {
        throw new Error(`Unsupported organization version: ${String(value.version)}`);
    }

    const folders = normalizeNamedItems(value.folders);
    const collections = normalizeNamedItems(value.collections);
    const references = { folders, collections };
    const views = normalizeNamedItems(value.views, (item, id, name) => (
        isRecord(item.view) ? { id, name, view: normalizeSavedView(item.view, references) } : null
    ));
    const folderIds = referenceIds(references, 'folders');
    const collectionIds = referenceIds(references, 'collections');
    const chats = [];
    const chatKeys = new Set();
    for (const [rawKey, metadata] of isRecord(value.chats) ? Object.entries(value.chats) : []) {
        const key = rawKey.trim();
        if (!key || chatKeys.has(key) || !isRecord(metadata)) {
            continue;
        }
        const normalized = {};
        if (metadata.favorite === true) {
            normalized.favorite = true;
        }
        const folder = trimmed(metadata.folder);
        if (folder && folderIds.has(folder)) {
            normalized.folder = folder;
        }
        const chatCollections = uniqueIds(metadata.collections).filter(id => collectionIds.has(id));
        if (chatCollections.length > 0) {
            normalized.collections = chatCollections;
        }
        const tags = uniqueStrings(metadata.tags);
        if (tags.length > 0) {
            normalized.tags = tags;
        }
        if (Object.keys(normalized).length > 0) {
            chatKeys.add(key);
            chats.push([key, normalized]);
        }
    }
    return {
        version: 1,
        lastView: normalizeSavedView(value.lastView, references),
        views,
        folders,
        collections,
        chats: Object.fromEntries(chats),
    };
}

export function parseOrganization(text) {
    return normalizeOrganization(JSON.parse(text));
}

/**
 * Maps one /api/chats/search result (whose `file_name` is actually extension-less)
 * into the /api/chats/recent row shape so normalizeRow can consume it.
 * @param {object} result Search result from the server
 * @param {{avatar_url?: string, group_id?: string}} scope The scope the search ran against
 */
export function deepResultToRecentRow(result, scope) {
    if (!isRecord(result) || typeof result.file_name !== 'string' || !result.file_name) {
        return null;
    }
    return {
        _source: 'search',
        avatar: scope.avatar_url,
        group: scope.group_id,
        file_id: result.file_name,
        file_name: `${result.file_name}.jsonl`,
        file_size: result.file_size,
        chat_items: result.message_count,
        last_mes: result.last_mes,
        mes: result.preview_message,
    };
}

export function buildSearchScopes(characters = [], groups = [], owner = '') {
    const scopes = characters
        .filter(character => typeof character?.avatar === 'string' && character.avatar)
        .filter(character => matchesOwner({
            kind: 'solo',
            ownerName: character.name,
            avatar: character.avatar,
            chatFolder: character.avatar.replace(/\.png$/i, ''),
        }, owner))
        .map(character => ({ avatar_url: character.avatar }));
    for (const group of groups) {
        if (!group || (typeof group.id !== 'string' && typeof group.id !== 'number')) {
            continue;
        }
        if (!matchesOwner({ kind: 'group', ownerName: group.name, groupId: group.id }, owner)) {
            continue;
        }
        scopes.push({ group_id: group.id });
        if (typeof group.id === 'string' && group.id !== '0' && /^\d+$/.test(group.id) && String(Number(group.id)) === group.id) {
            scopes.push({ group_id: Number(group.id) });
        }
    }
    return scopes;
}

function* jsonlLines(text) {
    const source = String(text ?? '');
    let start = 0;
    let lineNumber = 0;
    while (start <= source.length) {
        let end = source.indexOf('\n', start);
        if (end < 0) {
            end = source.length;
        }
        lineNumber++;
        let line = source.slice(start, end);
        if (line.endsWith('\r')) {
            line = line.slice(0, -1);
        }
        if (lineNumber === 1) {
            line = line.replace(/^\uFEFF/, '');
        }
        yield { line, lineNumber };
        if (end === source.length) {
            break;
        }
        start = end + 1;
    }
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }
}

function chunkSize(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : JSONL_CHUNK_SIZE;
}

/**
 * Parses an exported JSONL chat without invoking the host's recovery-aware read endpoints.
 * @param {string} text
 * @returns {object[]}
 */
export function parseJsonl(text) {
    const records = [];
    for (const { line, lineNumber } of jsonlLines(text)) {
        if (!line.trim()) {
            continue;
        }
        try {
            records.push(JSON.parse(line));
        } catch (error) {
            throw new Error(`Invalid JSONL on line ${lineNumber}`, { cause: error });
        }
    }
    return records;
}

export async function parseChatJsonl(text, { signal, linesPerChunk = JSONL_CHUNK_SIZE } = {}) {
    let header = null;
    const messages = [];
    let objectCount = 0;
    let processed = 0;
    const batchSize = chunkSize(linesPerChunk);
    for (const { line, lineNumber } of jsonlLines(text)) {
        if (line.trim()) {
            let record;
            try {
                record = JSON.parse(line);
            } catch (error) {
                throw new Error(`Invalid JSONL on line ${lineNumber}`, { cause: error });
            }
            if (isRecord(record)) {
                if (objectCount === 0 && !('mes' in record)) {
                    header = record;
                } else {
                    messages.push(shapeMessage(record));
                }
                objectCount++;
            }
        }
        if (++processed % batchSize === 0) {
            throwIfAborted(signal);
            await new Promise(resolve => setTimeout(resolve, 0));
            throwIfAborted(signal);
        }
    }
    throwIfAborted(signal);
    return {
        header,
        metadataKeys: Object.keys(header?.chat_metadata ?? {}),
        messages,
    };
}

/**
 * Mirrors the host's plain-text export while also supporting Data Maid orphan files.
 * @param {object[]} records
 * @returns {string}
 */
export function recordsToText(records) {
    return (Array.isArray(records) ? records : [])
        .filter(record => !record?.is_system && typeof record?.mes === 'string' && record.mes)
        .map(record => `${record.name ?? ''}: ${typeof record.extra?.display_text === 'string' && record.extra.display_text ? record.extra.display_text : record.mes}`)
        .join('\n\n');
}

export function matchesQueryFragments(text, query) {
    const searchable = String(text ?? '').toLowerCase();
    const fragments = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return fragments.length > 0 && fragments.every(fragment => searchable.includes(fragment));
}

export function findMatchingMessageIndex(messages, query) {
    const fragments = [...new Set(String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean))];
    if (fragments.length === 0) {
        return -1;
    }
    const matched = new Set();
    let firstMatch = -1;
    const list = Array.isArray(messages) ? messages : [];
    for (let index = 0; index < list.length; index++) {
        const text = typeof list[index]?.mes === 'string' ? list[index].mes.toLowerCase() : '';
        let containsFragment = false;
        for (const fragment of fragments) {
            if (text.includes(fragment)) {
                matched.add(fragment);
                containsFragment = true;
            }
        }
        if (containsFragment && firstMatch < 0) {
            firstMatch = index;
        }
    }
    return matched.size === fragments.length ? firstMatch : -1;
}

/**
 * Uses the host search semantics: every whitespace-delimited fragment must occur
 * somewhere in message content, but not necessarily in the same message.
 * @param {object[]} records
 * @param {string} query
 * @returns {string|null} A matching preview, or null when the chat does not match.
 */
export function findMatchingSnippet(records, query) {
    const index = findMatchingMessageIndex(records, query);
    if (index < 0) {
        return null;
    }
    return previewText(records[index].mes, PREVIEW_LENGTH);
}

function createJsonlSearch(query) {
    return {
        fragments: [...new Set(String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean))],
        matched: new Set(),
        snippet: null,
    };
}

function searchJsonlRecord(search, record) {
    if (!isRecord(record) || typeof record.mes !== 'string') {
        return;
    }
    const text = record.mes.toLowerCase();
    let containsFragment = false;
    for (const fragment of search.fragments) {
        if (text.includes(fragment)) {
            search.matched.add(fragment);
            containsFragment = true;
        }
    }
    if (containsFragment && search.snippet === null) {
        search.snippet = previewText(record.mes, PREVIEW_LENGTH);
    }
}

function finishJsonlSearch(search, invalidLines) {
    return {
        snippet: search.fragments.length > 0 && search.matched.size === search.fragments.length ? search.snippet : null,
        invalidLines,
    };
}

export function findMatchingSnippetInJsonl(text, query) {
    const search = createJsonlSearch(query);
    let invalidLines = 0;
    for (const { line } of jsonlLines(text)) {
        try {
            if (line.trim()) {
                searchJsonlRecord(search, JSON.parse(line));
            }
        } catch {
            // Search the readable records even when one line is corrupt.
            invalidLines++;
        }
    }
    return finishJsonlSearch(search, invalidLines);
}

export async function findMatchingSnippetInJsonlAsync(text, query, { signal, linesPerChunk = JSONL_CHUNK_SIZE } = {}) {
    const search = createJsonlSearch(query);
    let invalidLines = 0;
    let processed = 0;
    const batchSize = chunkSize(linesPerChunk);
    for (const { line } of jsonlLines(text)) {
        try {
            if (line.trim()) {
                searchJsonlRecord(search, JSON.parse(line));
            }
        } catch {
            invalidLines++;
        }
        if (++processed % batchSize === 0) {
            throwIfAborted(signal);
            await new Promise(resolve => setTimeout(resolve, 0));
            throwIfAborted(signal);
        }
    }
    throwIfAborted(signal);
    return finishJsonlSearch(search, invalidLines);
}

function organizationMaps(organization) {
    return {
        folders: new Map((organization?.folders ?? []).map(item => [item.id, item.name])),
        collections: new Map((organization?.collections ?? []).map(item => [item.id, item.name])),
    };
}

function chatMetadata(row, organization) {
    const metadata = organization?.chats?.[physicalChatKey(row)];
    return isRecord(metadata) ? metadata : {};
}

function numberBound(value, date = false) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (date && typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function rowNumber(row, field) {
    const value = row[field];
    const knownField = field === 'sizeBytes' ? 'sizeKnown' : field === 'mtime' ? 'mtimeKnown' : null;
    return Number.isFinite(value) && (!knownField || row[knownField] !== false) ? value : null;
}

export function filterRows(rows, options = {}, organization = null) {
    const needle = String(options.text ?? '').trim().toLowerCase();
    const maps = organizationMaps(organization);
    const bounds = {
        minDate: numberBound(options.minDate, true),
        maxDate: numberBound(options.maxDate, true),
        minSize: numberBound(options.minSize),
        maxSize: numberBound(options.maxSize),
        minMessages: numberBound(options.minMessages),
        maxMessages: numberBound(options.maxMessages),
    };
    const ranges = [
        [bounds.minDate, bounds.maxDate, 'mtime'],
        [bounds.minSize, bounds.maxSize, 'sizeBytes'],
        [bounds.minMessages, bounds.maxMessages, 'count'],
    ];
    const hasFolderFilter = Object.hasOwn(options, 'folder') && options.folder !== undefined && options.folder !== '';
    const owner = trimmed(options.owner);
    const collection = trimmed(options.collection);
    const tag = trimmed(options.tag).toLowerCase();
    return rows.filter(row => {
        if (options.kinds && !options.kinds.includes(row.kind)) {
            return false;
        }
        if (owner && !matchesOwner(row, owner)) {
            return false;
        }
        if (options.orphan && row.orphanType !== options.orphan) {
            return false;
        }

        const metadata = chatMetadata(row, organization);
        if (typeof options.favorite === 'boolean' && (metadata.favorite === true) !== options.favorite) {
            return false;
        }
        if (hasFolderFilter && (options.folder === null ? !!metadata.folder : metadata.folder !== options.folder)) {
            return false;
        }
        if (collection && !metadata.collections?.includes(collection)) {
            return false;
        }
        if (tag && !metadata.tags?.some(value => String(value).toLowerCase() === tag)) {
            return false;
        }

        for (const [minimum, maximum, field] of ranges) {
            if (minimum === null && maximum === null) {
                continue;
            }
            const value = rowNumber(row, field);
            if (value === null || (minimum !== null && value < minimum) || (maximum !== null && value > maximum)) {
                return false;
            }
        }

        if (!needle) {
            return true;
        }
        const labels = [
            maps.folders.get(metadata.folder),
            ...(metadata.collections ?? []).map(id => maps.collections.get(id)),
            ...(metadata.tags ?? []),
        ];
        return [row.file_id, row.ownerName, row.snippet, ...labels]
            .some(field => String(field ?? '').toLowerCase().includes(needle));
    });
}

function compareNumber(a, b, field, direction) {
    const left = rowNumber(a, field);
    const right = rowNumber(b, field);
    if (left === null || right === null) {
        return left === null ? right === null ? 0 : 1 : -1;
    }
    return (left - right) * direction;
}

function compareText(left, right) {
    return String(left ?? '').localeCompare(String(right ?? ''));
}

const SORTERS = {
    recent: (a, b) => compareNumber(a, b, 'mtime', -1),
    oldest: (a, b) => compareNumber(a, b, 'mtime', 1),
    size: (a, b) => compareNumber(a, b, 'sizeBytes', -1),
    smallest: (a, b) => compareNumber(a, b, 'sizeBytes', 1),
    count: (a, b) => compareNumber(a, b, 'count', -1),
    fewest: (a, b) => compareNumber(a, b, 'count', 1),
    name: (a, b) => compareText(a.file_id, b.file_id),
    'name-reverse': (a, b) => compareText(b.file_id, a.file_id),
    owner: (a, b) => compareText(a.ownerName, b.ownerName),
};

export function sortRows(rows, key = 'recent') {
    const sorter = SORTERS[key] ?? SORTERS.recent;
    return [...rows].sort((a, b) => (
        sorter(a, b)
        || compareText(a.file_id, b.file_id)
        || compareText(physicalChatKey(a), physicalChatKey(b))
    ));
}

export function groupRows(rows, mode = 'flat', organization = null) {
    const selectedMode = GROUP_KEYS.has(mode) ? mode : 'flat';
    const maps = organizationMaps(organization);
    const groups = new Map();
    for (const row of rows) {
        let key = 'flat';
        let label = '';
        if (selectedMode === 'owner') {
            const scope = row.kind === 'group' || row.orphanType === 'missing-group'
                ? ['group', String(row.groupId ?? '')]
                : row.chatFolder || row.avatar
                    ? ['character', row.chatFolder ?? row.avatar]
                    : ['orphan', row.orphanType ?? ''];
            key = JSON.stringify(scope);
            label = row.ownerName || 'Unknown owner';
        } else if (selectedMode === 'type') {
            key = String(row.kind ?? 'unknown');
            label = key;
        } else if (selectedMode === 'folder') {
            const folder = chatMetadata(row, organization).folder ?? null;
            key = JSON.stringify(['folder', folder]);
            label = folder === null ? 'Unfiled' : maps.folders.get(folder) ?? folder;
        }
        if (!groups.has(key)) {
            groups.set(key, { key, label, rows: [] });
        }
        groups.get(key).rows.push(row);
    }
    return [...groups.values()];
}

/**
 * Splits raw JSONL records (as returned by /api/chats/get) into a header and
 * display-ready messages. The header is the first record iff it has no `mes`.
 * @param {object[]} records
 */
function shapeMessage(raw) {
    const mes = typeof raw.mes === 'string' ? raw.mes : '';
    const swipes = Array.isArray(raw.swipes) ? raw.swipes : [];
    let selectedSwipe = Number.isSafeInteger(raw.swipe_id) ? raw.swipe_id : swipes.indexOf(mes);
    if (selectedSwipe < 0 || selectedSwipe >= swipes.length) {
        selectedSwipe = swipes.indexOf(mes);
    }
    const alternatives = swipes.filter((swipe, index) => typeof swipe === 'string' && index !== selectedSwipe);
    return {
        name: typeof raw.name === 'string' ? raw.name : '',
        send_date: raw.send_date ?? '',
        mes,
        isUser: !!raw.is_user,
        isSystem: !!raw.is_system,
        swipeCount: alternatives.length,
        alternatives,
        extra: isRecord(raw.extra) ? raw.extra : null,
    };
}

export function shapeChatRecords(records) {
    const list = Array.isArray(records) ? records.filter(x => x && typeof x === 'object') : [];
    const header = (list.length > 0 && !('mes' in list[0])) ? list[0] : null;
    const messages = [];
    for (let index = header ? 1 : 0; index < list.length; index++) {
        messages.push(shapeMessage(list[index]));
    }

    return {
        header,
        metadataKeys: Object.keys(header?.chat_metadata ?? {}),
        messages,
    };
}
