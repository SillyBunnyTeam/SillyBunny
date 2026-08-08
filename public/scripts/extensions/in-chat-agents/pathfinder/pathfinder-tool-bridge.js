import { isPathfinderSubmoduleEnabled } from '../agent-store.js';
import { getSettings, getTree, isLorebookEnabled, canReadBook, canWriteBook, canDeleteBook } from './tree-store.js';

const CHAT_LOREBOOK_METADATA_KEY = 'world_info';

const PATHFINDER_LOG_PREFIX = '[Pathfinder]';

export const TOOL_NAMES = {
    SEARCH: 'Pathfinder_Search',
    REMEMBER: 'Pathfinder_Remember',
    UPDATE: 'Pathfinder_Update',
    FORGET: 'Pathfinder_Forget',
    SUMMARIZE: 'Pathfinder_Summarize',
    REORGANIZE: 'Pathfinder_Reorganize',
    MERGE_SPLIT: 'Pathfinder_MergeSplit',
    NOTEBOOK: 'Pathfinder_Notebook',
};

export const ALL_TOOL_NAMES = Object.values(TOOL_NAMES);

/** Tools that modify lorebook data and can be gated behind a confirmation dialog. */
export const CONFIRMABLE_TOOLS = new Set([
    TOOL_NAMES.REMEMBER,
    TOOL_NAMES.UPDATE,
    TOOL_NAMES.FORGET,
    TOOL_NAMES.SUMMARIZE,
    TOOL_NAMES.REORGANIZE,
    TOOL_NAMES.MERGE_SPLIT,
]);

/**
 * Resolve the tool_choice value that forces tool use, when the user enabled
 * "require tool use on every response". The server backends translate:
 * the Claude backend wraps the string as {type: <value>} where 'any' is the
 * forced-tool mode; every other backend speaks OpenAI's 'required' (Gemini
 * translates it to functionCallingConfig mode ANY server-side).
 * @param {string} chatCompletionSource - Source id from the generation data
 * @returns {string|null} Value for tool_choice, or null when not forcing
 */
export function getForcedToolChoice(chatCompletionSource) {
    if (!isPathfinderSubmoduleEnabled()) {
        return null;
    }

    const s = getSettings();
    if (!s.sidecarEnabled || !s.mandatoryTools) {
        return null;
    }

    return chatCompletionSource === 'claude' ? 'any' : 'required';
}

export function getActiveTunnelVisionBooks() {
    if (!isPathfinderSubmoduleEnabled()) {
        return [];
    }

    const s = getSettings();
    const books = Array.isArray(s.enabledLorebooks)
        ? s.enabledLorebooks.filter(b => isLorebookEnabled(b))
        : [];

    if (s.includeContextualLorebooks !== false) {
        books.push(...getContextualLorebooks());
    }

    return Array.from(new Set(books.filter(Boolean)));
}

function addBookSource(sources, name, type) {
    const bookName = String(name ?? '').trim();
    if (!bookName) {
        return;
    }

    const existing = sources.find(source => source.name === bookName);
    if (existing) {
        existing.types.add(type);
        return;
    }

    sources.push({
        name: bookName,
        types: new Set([type]),
    });
}

function getChatMetadata(ctx) {
    return ctx?.chatMetadata ?? ctx?.chat_metadata ?? {};
}

function getPowerUserSettings(ctx) {
    return ctx?.powerUserSettings ?? ctx?.power_user ?? {};
}

function getWorldInfoSettings(ctx) {
    return ctx?.worldInfoSettings ?? ctx?.world_info ?? {};
}

function hasActiveGroup(ctx) {
    return ctx?.groupId !== null && ctx?.groupId !== undefined && String(ctx.groupId).trim() !== '';
}

export function getContextualLorebookDetails() {
    const ctx = window?.SillyTavern?.getContext?.();
    const sources = [];
    const chatLorebook = getChatMetadata(ctx)?.[CHAT_LOREBOOK_METADATA_KEY];
    const personaLorebook = getPowerUserSettings(ctx)?.persona_description_lorebook;

    addBookSource(sources, chatLorebook, 'chat');
    addBookSource(sources, personaLorebook, 'persona');

    for (const character of getContextCharacters(ctx)) {
        const primaryBook = character?.data?.extensions?.world || character?.data?.character_book?.name;
        addBookSource(sources, primaryBook, hasActiveGroup(ctx) ? 'group' : 'character');

        const fileName = getCharacterFileName(character);
        const extraCharLore = getWorldInfoSettings(ctx)?.charLore?.find?.(entry => String(entry?.name ?? '') === fileName);
        if (Array.isArray(extraCharLore?.extraBooks)) {
            for (const book of extraCharLore.extraBooks) {
                addBookSource(sources, book, hasActiveGroup(ctx) ? 'group' : 'character');
            }
        }
    }

    return sources.map(source => ({
        name: source.name,
        types: [...source.types],
        type: [...source.types][0] ?? 'attached',
    }));
}

export function getContextualLorebooks() {
    return getContextualLorebookDetails().map(source => source.name);
}

function getContextCharacters(ctx) {
    if (!ctx?.characters?.length) {
        return [];
    }

    if (hasActiveGroup(ctx)) {
        const group = ctx.groups?.find?.(item => String(item?.id ?? '') === String(ctx.groupId ?? ''));
        const memberAvatars = Array.isArray(group?.members) ? group.members : [];
        return memberAvatars
            .map(avatar => ctx.characters.find(character => character?.avatar === avatar))
            .filter(Boolean);
    }

    const character = ctx.characters[ctx.characterId];
    return character ? [character] : [];
}

function getCharacterFileName(character) {
    const avatar = String(character?.avatar || '');
    return avatar.replace(/\.[^.]+$/, '');
}

export function getReadableBooks() {
    return getActiveTunnelVisionBooks().filter(b => canReadBook(b));
}

export function getWritableBooks() {
    return getActiveTunnelVisionBooks().filter(b => canWriteBook(b));
}

export function getDeletableBooks() {
    return getActiveTunnelVisionBooks().filter(b => canDeleteBook(b));
}

export function resolveTargetBook(requestedBook, writableBooks = null) {
    const books = writableBooks ?? getWritableBooks();
    if (books.length === 0) return null;
    if (requestedBook && books.includes(requestedBook)) {
        return requestedBook;
    }

    return books[0];
}

export function getBookListWithDescriptions() {
    const books = getActiveTunnelVisionBooks();
    return books.map(b => {
        const tree = getTree(b);
        const entryCount = tree ? countAllEntries(tree) : 0;
        return `📚 ${b} (${entryCount} entries)`;
    }).join('\n');
}

function countAllEntries(tree) {
    if (!tree) return 0;
    let count = (tree.entries || []).length;
    for (const child of tree.children || []) {
        count += countAllEntries(child);
    }
    return count;
}

export function preflightToolRuntimeState() {
    const books = getActiveTunnelVisionBooks();
    return {
        hasBooks: books.length > 0,
        bookCount: books.length,
        books,
    };
}

/**
 * Get entry content by UID from a lorebook
 * @param {string} bookName - Lorebook name
 * @param {number} uid - Entry UID
 * @returns {Promise<Object|null>} Entry object with uid, comment, content, etc.
 */
export async function getEntryContent(bookName, uid) {
    const ctx = window?.SillyTavern?.getContext?.();
    if (!ctx?.loadWorldInfo) {
        console.warn(`${PATHFINDER_LOG_PREFIX} Cannot fetch lorebook entry because loadWorldInfo is unavailable.`, {
            bookName,
            uid,
        });
        return null;
    }

    try {
        const bookData = await ctx.loadWorldInfo(bookName);
        if (!bookData?.entries) {
            console.warn(`${PATHFINDER_LOG_PREFIX} Lorebook "${bookName}" has no entries while fetching UID ${uid}.`);
            return null;
        }

        for (const entry of Object.values(bookData.entries)) {
            if (entry && entry.uid === uid) {
                return {
                    uid: entry.uid,
                    world: entry.world || bookName,
                    comment: entry.comment || entry.key?.[0] || '',
                    content: entry.content || '',
                    key: entry.key || [],
                    keysecondary: entry.keysecondary || [],
                    selective: entry.selective ?? false,
                    selectiveLogic: entry.selectiveLogic ?? 0,
                    caseSensitive: entry.caseSensitive,
                    matchWholeWords: entry.matchWholeWords,
                    constant: entry.constant ?? false,
                    decorators: entry.decorators || [],
                    disable: entry.disable ?? false,
                };
            }
        }
        console.warn(`${PATHFINDER_LOG_PREFIX} Entry ${uid} was not found in lorebook "${bookName}".`);
    } catch (err) {
        console.warn(`[Pathfinder] Failed to get entry ${uid} from ${bookName}:`, err);
    }

    return null;
}

/**
 * Get all entries from a lorebook with their content
 * @param {string} bookName - Lorebook name
 * @returns {Promise<Object[]>} Array of entry objects
 */
export async function getAllEntriesWithContent(bookName) {
    const ctx = window?.SillyTavern?.getContext?.();
    if (!ctx?.loadWorldInfo) {
        console.warn(`${PATHFINDER_LOG_PREFIX} Cannot fetch lorebook contents because loadWorldInfo is unavailable.`, {
            bookName,
        });
        return [];
    }

    try {
        const bookData = await ctx.loadWorldInfo(bookName);
        if (!bookData?.entries) {
            console.warn(`${PATHFINDER_LOG_PREFIX} Lorebook "${bookName}" has no entries while fetching all content.`);
            return [];
        }

        return Object.values(bookData.entries)
            .filter(entry => entry && !entry.disable)
            .map(entry => ({
                uid: entry.uid,
                world: entry.world || bookName,
                comment: entry.comment || entry.key?.[0] || '',
                content: entry.content || '',
                key: entry.key || [],
                keysecondary: entry.keysecondary || [],
                selective: entry.selective ?? false,
                selectiveLogic: entry.selectiveLogic ?? 0,
                caseSensitive: entry.caseSensitive,
                matchWholeWords: entry.matchWholeWords,
                constant: entry.constant ?? false,
                decorators: entry.decorators || [],
            }));
    } catch (err) {
        console.warn(`[Pathfinder] Failed to get entries from ${bookName}:`, err);
        return [];
    }
}
