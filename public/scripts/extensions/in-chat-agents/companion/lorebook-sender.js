const EMPTY_RESULT = 'lorebook has nothing durable this turn.';
const FALLBACK_BOOK_NAME = 'Lorebook Scout';
const TITLE_PATTERN = /^\s*\*\*(?!keys\b)(.+?)\*\*\s*$/i;
const KEYS_PATTERN = /^\s*(?:\*\*Keys:\*\*|\*\*Keys\*\*:|Keys:)\s*(.+?)\s*$/i;

let writeChain = Promise.resolve();

export function isLorebookAgent(agent) {
    return Array.isArray(agent?.tags)
        && agent.tags.some(tag => String(tag ?? '').trim().toLowerCase() === 'lorebook');
}

export function parseLorebookEntries(value) {
    const text = String(value ?? '').replaceAll(/\r\n?/g, '\n').trim();
    if (!text || text.toLowerCase() === EMPTY_RESULT) {
        return [];
    }

    const entries = [];
    let current = null;

    const finishEntry = () => {
        if (!current) {
            return;
        }

        const content = current.body.join('\n').trim();
        if (!content) {
            throw new Error('Lorebook entry body is missing.');
        }

        entries.push({
            title: current.title,
            keys: current.keys ?? [current.title],
            content,
        });
    };

    for (const line of text.split('\n')) {
        const titleMatch = line.match(TITLE_PATTERN);
        if (titleMatch) {
            finishEntry();
            const title = titleMatch[1].trim().replace(/:\s*$/, '');
            if (!title) {
                throw new Error('Lorebook entry title is missing.');
            }
            current = { title, keys: null, body: [] };
            continue;
        }

        if (!current) {
            if (line.trim()) {
                throw new Error('Lorebook entry title is missing.');
            }
            continue;
        }

        const keysMatch = line.match(KEYS_PATTERN);
        if (keysMatch) {
            if (current.keys || current.body.some(value => value.trim())) {
                throw new Error('Lorebook Keys line is misplaced.');
            }

            const keys = [...new Set(keysMatch[1].split(',').map(key => key.trim()).filter(Boolean))];
            if (keys.length < 2) {
                throw new Error('Lorebook Keys line must contain at least 2 keys.');
            }
            current.keys = keys.slice(0, 5);
            continue;
        }

        current.body.push(line);
    }

    finishEntry();
    if (entries.length === 0) {
        throw new Error('No lorebook entries found.');
    }
    return entries;
}

function normalizeTitle(value) {
    return String(value ?? '').normalize().trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

function getCurrentCharacters(context) {
    const characters = Array.isArray(context.characters) ? context.characters : [];
    const hasGroup = context.groupId !== null
        && context.groupId !== undefined
        && String(context.groupId).trim() !== '';
    if (hasGroup) {
        const group = context.groups?.find(group => String(group?.id ?? '') === String(context.groupId));
        const members = new Set(Array.isArray(group?.members) ? group.members : []);
        return characters.filter(character => members.has(character?.avatar));
    }

    const characterId = Number(context.characterId);
    return Number.isInteger(characterId) && characters[characterId] ? [characters[characterId]] : [];
}

async function offerAuxiliaryLorebook(context, bookName) {
    if (normalizeTitle(bookName) !== normalizeTitle(FALLBACK_BOOK_NAME)) {
        return;
    }

    const charLore = Array.isArray(context.worldInfoSettings?.charLore) ? context.worldInfoSettings.charLore : [];
    const missingCharacters = getCurrentCharacters(context).filter(character => {
        const fileName = String(character?.avatar ?? '').replace(/\.[^/.]+$/, '');
        const extraBooks = charLore.find(entry => entry?.name === fileName)?.extraBooks;
        return !Array.isArray(extraBooks)
            || !extraBooks.some(name => normalizeTitle(name) === normalizeTitle(bookName));
    });
    if (missingCharacters.length === 0) {
        return;
    }

    if (typeof context.callGenericPopup !== 'function'
        || !context.POPUP_TYPE
        || typeof context.charUpdateAddAuxWorld !== 'function') {
        console.warn('[In-Chat Agents] Auxiliary lorebook confirmation is unavailable.');
        return;
    }

    const confirmed = await context.callGenericPopup(
        'Add Lorebook Scout as an Auxiliary Lorebook to the current chat automatically?',
        context.POPUP_TYPE.CONFIRM,
    );
    if (confirmed !== (context.POPUP_RESULT?.AFFIRMATIVE ?? 1)) {
        return;
    }

    for (const character of missingCharacters) {
        await context.charUpdateAddAuxWorld(character.avatar, bookName);
    }
}

async function getTargetBook(context) {
    const attachedBook = String(context.chatMetadata?.world_info ?? '').trim();
    if (attachedBook) {
        return attachedBook;
    }

    const findFallback = () => context.getWorldInfoNames?.()
        ?.find(name => normalizeTitle(name) === normalizeTitle(FALLBACK_BOOK_NAME));
    let bookName = findFallback();
    if (!bookName) {
        if (typeof context.createNewWorldInfo !== 'function') {
            throw new Error('Lorebook creation is unavailable.');
        }

        const created = await context.createNewWorldInfo(FALLBACK_BOOK_NAME);
        bookName = findFallback() ?? (created ? FALLBACK_BOOK_NAME : '');
        if (!bookName) {
            throw new Error('Could not create the fallback lorebook.');
        }
    }

    if (typeof context.updateChatMetadata === 'function') {
        context.updateChatMetadata({ world_info: bookName });
    } else if (context.chatMetadata) {
        context.chatMetadata.world_info = bookName;
    } else {
        throw new Error('Chat metadata is unavailable.');
    }

    if (typeof context.saveMetadata !== 'function') {
        throw new Error('Chat metadata saving is unavailable.');
    }
    await context.saveMetadata();
    return bookName;
}

async function sendLorebookEntries(content, context, notifier) {
    let entries;
    try {
        entries = parseLorebookEntries(content);
    } catch (error) {
        console.warn('[In-Chat Agents] Could not parse lorebook companion result.', error);
        notifier?.warning?.('Could not read lorebook entries. Use a bold title, an optional Keys line, and a body for each entry.');
        return null;
    }

    if (entries.length === 0) {
        notifier?.info?.('No durable lorebook entries to send.');
        return { bookName: null, created: 0, duplicates: 0 };
    }

    try {
        if (!context?.loadWorldInfo || !context?.createWorldInfoEntry || !context?.saveWorldInfo) {
            throw new Error('Lorebook APIs are unavailable.');
        }

        const bookName = await getTargetBook(context);
        await offerAuxiliaryLorebook(context, bookName);
        const bookData = await context.loadWorldInfo(bookName);
        if (!bookData?.entries || typeof bookData.entries !== 'object') {
            throw new Error(`Lorebook "${bookName}" could not be loaded.`);
        }

        const knownTitles = new Set(Object.values(bookData.entries)
            .map(entry => normalizeTitle(entry?.comment))
            .filter(Boolean));
        let duplicates = 0;
        let created = 0;

        for (const draft of entries) {
            const normalizedTitle = normalizeTitle(draft.title);
            if (knownTitles.has(normalizedTitle)) {
                duplicates++;
                continue;
            }

            const entry = context.createWorldInfoEntry(bookName, bookData);
            if (!entry || entry.uid === undefined) {
                throw new Error(`Could not create an entry in "${bookName}".`);
            }

            entry.comment = draft.title;
            entry.key = draft.keys;
            entry.content = draft.content;
            entry.selective = false;
            entry.constant = false;
            entry.disable = false;
            knownTitles.add(normalizedTitle);
            created++;
        }

        if (created > 0) {
            await context.saveWorldInfo(bookName, bookData, true);
            const duplicateNote = duplicates > 0 ? ` Skipped ${duplicates} duplicate${duplicates === 1 ? '' : 's'}.` : '';
            notifier?.success?.(`Added ${created} lorebook entr${created === 1 ? 'y' : 'ies'} to "${bookName}".${duplicateNote}`);
        } else {
            notifier?.info?.(`No new entries added to "${bookName}"; ${duplicates} already exist${duplicates === 1 ? 's' : ''}.`);
        }

        return { bookName, created, duplicates };
    } catch (error) {
        console.error('[In-Chat Agents] Could not send companion result to lorebook.', error);
        notifier?.error?.('Could not send entries to the lorebook.');
        return null;
    }
}

export function sendCompanionResultToLorebook(content, context = globalThis.SillyTavern?.getContext?.(), notifier = globalThis.toastr) {
    const run = writeChain.then(() => sendLorebookEntries(content, context, notifier));
    writeChain = run.then(() => undefined, () => undefined);
    return run;
}
