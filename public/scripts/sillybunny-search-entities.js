// SillyBunny: data-backed destinations; context, editors, and world data stay lazy.

const DEFAULT_ENTITY_SEARCH_LIMIT = 4000;
const WORLD_INFO_SEARCH_TEXT_LIMIT = 64000;
const WORLD_INFO_SELECT_RETRY_MS = 40;
const WORLD_INFO_SELECT_ATTEMPTS = 50;
const worldInfoSearchCache = new Map();

function defaultSearchContextAccessor() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

let searchContextAccessor = defaultSearchContextAccessor;

export function setSearchContextAccessor(accessor) {
    const previousAccessor = searchContextAccessor;
    searchContextAccessor = typeof accessor === 'function' ? accessor : defaultSearchContextAccessor;
    return () => { searchContextAccessor = previousAccessor; };
}

export function resetSearchContextAccessor() {
    searchContextAccessor = defaultSearchContextAccessor;
}

function getSearchContext() {
    try {
        return searchContextAccessor() ?? null;
    } catch {
        return null;
    }
}

function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getSearchValue(value, limit) {
    return Array.isArray(value) ? value.slice(0, limit).join(' ') : String(value ?? '');
}

function getCharacterList(context) {
    try {
        const source = context?.characters;
        if (Array.isArray(source)) return source;
        const getter = typeof source === 'function' ? source : context?.getCharacters;
        // The core getCharacters() refreshes from the server. Only synchronous accessors
        // can be used as a fallback in a search that runs on every keystroke.
        if (typeof getter !== 'function' || getter.constructor?.name === 'AsyncFunction') return [];
        const result = getter.call(context);
        if (Array.isArray(result)) return result;
        result?.catch?.(() => {});
    } catch {
        return [];
    }
    return [];
}

function isCharacter(character) {
    return Boolean(character && typeof character === 'object'
        && (character.name || character.avatar)
        && !character.is_group
        && !character.is_group_only
        && !character.group_only
        && !character.data?.is_group
        && character.type !== 'group'
        && !Array.isArray(character.members));
}

function getAvatarSearchValue(avatar) {
    const value = String(avatar ?? '').split(/[?#]/, 1)[0];
    const filename = value.slice(value.lastIndexOf('/') + 1);
    return filename.replace(/\.[^.]+$/, '');
}

function getWorldNames(context) {
    try {
        const names = context?.getWorldInfoNames?.();
        return Array.isArray(names) ? names : [];
    } catch {
        return [];
    }
}

function createEntry(searchText, displayText, tabId, tabLabel, dedupeKey, action) {
    return {
        element: null,
        searchText,
        displayText,
        sectionLabel: tabLabel,
        tabId,
        tabLabel,
        dedupeKey,
        headingMatch: true,
        action,
    };
}

async function rememberOpened(kind, key) {
    try {
        const { rememberOpenedEntity } = await import('./sillybunny-auto-load.js');
        rememberOpenedEntity(kind, key);
    } catch {
        // The chat is open either way; only the Auto-load Last Chat entity stays behind.
    }
}

// Groups open without switchMenu so search leaves the Characters page where it was, but an Editor tab
// still showing a character, or the no-chat empty state, no longer matches the open chat.
async function refreshStaleCharacterEditor() {
    try {
        const panel = globalThis.document?.getElementById('right-nav-panel');
        if (!panel?.classList.contains('openDrawer') || !['character_edit', 'editor_empty'].includes(panel.dataset.menuType)) return;
        // A phone page on its section list keeps the Editor off-screen, and opening the tab would slide it in.
        // Choosing Editor there resolves the open chat anyway.
        const onPhoneSectionList = Boolean(globalThis.matchMedia?.('(max-width: 768px)')?.matches)
            && !globalThis.document.getElementById('sb-settings-page')?.classList.contains('sb-settings-page--content');
        if (onPhoneSectionList) return;
        await globalThis.SillyBunnyShell?.openTab?.('characters', 'editor');
    } catch {
        // Navigation can be unavailable while the shell is being mounted.
    }
}

async function openCharacter(index) {
    try {
        const context = getSearchContext();
        // Read the avatar before the open: the library can reload while the chat loads.
        const avatar = String(getCharacterList(context)[index]?.avatar ?? '');
        // The app's own selection path opens the editor, fills its fields and starts a session; the
        // editor renders from that form rather than from data, so opening the session directly would
        // show whatever card was last loaded. A false result means a pending chat save blocked it.
        const selectById = typeof context?.selectCharacterById === 'function'
            ? context.selectCharacterById.bind(context)
            : null;
        if (!selectById) {
            try {
                const module = await import('../script.js');
                if (typeof module?.selectCharacterById === 'function') {
                    if (await module.selectCharacterById(index) === false) return;
                    if (avatar) await rememberOpened('character', avatar);
                    await globalThis.SillyBunnyShell?.openTab?.('characters', 'editor');
                    return;
                }
            } catch {
                // Fall through to the session-only path below.
            }
        } else {
            if (await selectById(index) === false) return;
            if (avatar) await rememberOpened('character', avatar);
            await globalThis.SillyBunnyShell?.openTab?.('characters', 'editor');
            return;
        }

        await globalThis.SillyBunnyShell?.openTab?.('characters', 'editor');
        const { openCharacterEditorSession } = await import('./sillybunny-character-editor.js');
        await openCharacterEditorSession(index);
    } catch {
        // The editor can still be deferred while the character panel is mounting.
    }
}

async function openGroup(group) {
    try {
        // openGroupChat only swaps the chat file of the group that is already selected, so it would
        // leave the previous character or group selected under this group's messages.
        const { openGroupById } = await import('./group-chats.js');
        const groupId = String(group.id);
        if (await openGroupById(groupId, { switchMenu: false })) {
            await rememberOpened('group', groupId);
            await refreshStaleCharacterEditor();
        }
        return;
    } catch {
        // Fall through to the groups page if opening the group throws.
    }
    try {
        await globalThis.SillyBunnyShell?.openTab?.('characters', 'groups');
    } catch {
        // Navigation can be unavailable while the shell is being mounted.
    }
}

async function openWorld(name) {
    try {
        await globalThis.SillyBunnyShell?.openTab?.('characters', 'world-info');
        if (!globalThis.document) return;

        for (let attempt = 0; attempt <= WORLD_INFO_SELECT_ATTEMPTS; attempt++) {
            const select = globalThis.document.getElementById('world_editor_select');
            const names = getWorldNames(getSearchContext());
            const index = names.indexOf(name);
            if (select && index >= 0) {
                select.value = String(index);
                const Event = select.ownerDocument?.defaultView?.Event ?? globalThis.Event;
                if (select.value === String(index) && typeof Event === 'function') {
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    return;
                }
            }
            if (attempt < WORLD_INFO_SELECT_ATTEMPTS) {
                await new Promise(resolve => setTimeout(resolve, WORLD_INFO_SELECT_RETRY_MS));
            }
        }
    } catch {
        // Deferred panels can disappear while navigation is in flight.
    }
}

// Only the explicit priming pass populates this metadata snapshot. Neither this lookup
// nor collection calls loadWorldInfo(), so a cache miss never starts a network request.
export function getWorldInfoEntrySearchText(bookName) {
    return worldInfoSearchCache.get(bookName) ?? '';
}

export function collectEntitySearchEntries(normalizedQuery, { limit = DEFAULT_ENTITY_SEARCH_LIMIT, skippedWorlds = null } = {}) {
    const query = normalizeText(normalizedQuery);
    const scanLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_ENTITY_SEARCH_LIMIT;
    if (!query || !scanLimit) return [];

    const context = getSearchContext();
    const characters = getCharacterList(context);
    const terms = query.split(' ');
    const matches = searchText => terms.every(term => searchText.includes(term));
    const entries = [];
    const memberNames = new Map();

    for (let index = 0; index < characters.length && index < scanLimit; index++) {
        const character = characters[index];
        if (!isCharacter(character)) continue;
        const name = String(character.name ?? '').trim()
            || getAvatarSearchValue(character.avatar)
            || String(character.avatar ?? '').trim();
        if (character.avatar) memberNames.set(character.avatar, name);
    }

    for (let index = 0; index < characters.length && index < scanLimit && entries.length < scanLimit; index++) {
        const character = characters[index];
        if (!isCharacter(character)) continue;
        const name = String(character.name ?? '').trim()
            || getAvatarSearchValue(character.avatar)
            || String(character.avatar ?? '').trim();
        const searchText = normalizeText([
            name,
            getAvatarSearchValue(character.avatar),
            character.data?.creator,
            getSearchValue(character.data?.tags, scanLimit),
            character.data?.creator_notes,
        ].join(' '));
        if (!matches(searchText)) continue;
        const characterIdentity = String(character.avatar ?? '').trim() || name || index;
        entries.push(createEntry(searchText, name, 'characters', 'Characters',
            `charentity::${characterIdentity}`, async () => openCharacter(index)));
    }

    const groups = Array.isArray(context?.groups) ? context.groups : [];
    for (let index = 0; index < groups.length && index < scanLimit && entries.length < scanLimit; index++) {
        const group = groups[index];
        if (!group || group.id === undefined || group.id === null) continue;
        const name = String(group.name ?? group.id);
        const parts = [name, group.id, group.disabled_members?.length ? 'disabled members' : ''];
        const members = Array.isArray(group.members) ? group.members : [];
        for (let memberIndex = 0; memberIndex < members.length && memberIndex < scanLimit; memberIndex++) {
            const member = members[memberIndex];
            const avatar = typeof member === 'object' ? member?.avatar ?? member?.id ?? member?.name : member;
            parts.push(avatar, member?.name ?? memberNames.get(avatar) ?? '');
        }
        const disabledMembers = Array.isArray(group.disabled_members) ? group.disabled_members : [];
        for (let memberIndex = 0; memberIndex < disabledMembers.length && memberIndex < scanLimit; memberIndex++) {
            const member = disabledMembers[memberIndex];
            const avatar = typeof member === 'object' ? member?.avatar ?? member?.id ?? member?.name : member;
            parts.push(avatar, member?.name ?? memberNames.get(avatar) ?? '');
        }
        const searchText = normalizeText(parts.join(' '));
        if (!matches(searchText)) continue;
        entries.push(createEntry(searchText, name, 'groups', 'Groups',
            `grpentity::${group.id}`, async () => openGroup(group)));
    }

    const names = entries.length < scanLimit ? getWorldNames(context) : [];
    for (let index = 0; index < names.length && index < scanLimit && entries.length < scanLimit; index++) {
        const name = names[index];
        if (typeof name !== 'string' || !name) continue;
        const cachedText = worldInfoSearchCache.has(name) || !skippedWorlds?.has(name)
            ? getWorldInfoEntrySearchText(name) : '';
        const searchText = normalizeText(`${name} world info lorebook world info book`)
            + (cachedText ? ` ${cachedText}` : '');
        if (!matches(searchText)) continue;
        entries.push(createEntry(searchText, name, 'world-info', 'World Info',
            `wibook::${name}`, async () => openWorld(name)));
    }

    return entries;
}

function getWorldInfoSearchText(data) {
    const entries = data?.entries;
    if (!entries || typeof entries !== 'object') return '';
    const parts = [];
    let length = 0;
    let scanned = 0;
    for (const key in entries) {
        if (scanned >= DEFAULT_ENTITY_SEARCH_LIMIT || length >= WORLD_INFO_SEARCH_TEXT_LIMIT) break;
        scanned += 1;
        if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
        const entry = entries[key];
        if (!entry) continue;
        const text = normalizeText([
            entry.comment,
            getSearchValue(entry.key, DEFAULT_ENTITY_SEARCH_LIMIT),
            getSearchValue(entry.keysecondary, DEFAULT_ENTITY_SEARCH_LIMIT),
        ].join(' ')).slice(0, WORLD_INFO_SEARCH_TEXT_LIMIT - length);
        parts.push(text);
        length += text.length + 1;
    }
    return normalizeText(parts.join(' '));
}

async function loadWorldInfoBefore(context, loadWorldInfo, name, deadline) {
    let timeoutId;
    try {
        return await Promise.race([
            Promise.resolve().then(() => loadWorldInfo.call(context, name)),
            new Promise(resolve => { timeoutId = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); }),
        ]);
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

// skippedWorlds records every attempted name, including failures, to avoid repeated
// failed loads. Successfully primed metadata stays searchable even when its name is in the Set.
export async function primeWorldInfoSearchCache({ names = [], budgetMs = 1500, skippedWorlds = null } = {}) {
    const attempted = skippedWorlds instanceof Set ? skippedWorlds : new Set();
    const budget = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : 1500;
    if (!Array.isArray(names) || !names.length || !budget) return attempted;
    const context = getSearchContext();
    let loadWorldInfo;
    try {
        loadWorldInfo = context?.loadWorldInfo;
    } catch {
        return attempted;
    }
    if (typeof loadWorldInfo !== 'function') return attempted;
    const deadline = Date.now() + budget;
    const nameLimit = Math.min(names.length, DEFAULT_ENTITY_SEARCH_LIMIT);
    let nextIndex = 0;

    const worker = async () => {
        while (nextIndex < nameLimit && Date.now() < deadline) {
            const name = names[nextIndex++];
            if (typeof name !== 'string' || !name || attempted.has(name) || worldInfoSearchCache.has(name)) continue;
            attempted.add(name);
            const data = await loadWorldInfoBefore(context, loadWorldInfo, name, deadline);
            if (!data) continue;
            try {
                worldInfoSearchCache.set(name, getWorldInfoSearchText(data));
            } catch {
                // Malformed books must not prevent the remaining books from being primed.
            }
        }
    };

    await Promise.all([worker(), worker()]);
    return attempted;
}
