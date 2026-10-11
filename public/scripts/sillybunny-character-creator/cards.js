import {
    characters,
    eventSource,
    event_types,
    flushCharacterSaveDebounced,
    getCharacters,
    getOneCharacter,
    getRequestHeaders,
    isGenerating,
    select_selected_character,
} from '../../script.js';
import {
    CARD_FIELDS,
    buildCharacterPatch,
    normalizeCardFields,
    projectCardFields,
    reconcileSavedFields,
} from './model.js';

function requireAvatar(avatar) {
    if (typeof avatar !== 'string' || !avatar.trim()) {
        throw new Error('A saved source character is required.');
    }
}

function requireIdleGeneration() {
    if (isGenerating()) {
        throw new Error('Stop the active chat generation before saving a character.');
    }
}

async function requireSuccess(response, action) {
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`${action} failed (${response.status})${detail ? `: ${detail}` : '.'}`);
    }
}

/** Fetch the pinned card directly: roster helpers do not report HTTP failures. */
export async function loadCreatorSource(avatar) {
    requireAvatar(avatar);
    const response = await fetch('/api/characters/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar }),
        cache: 'no-cache',
    });
    await requireSuccess(response, 'Loading the character');
    const character = await response.json();
    if (!character || typeof character !== 'object' || Array.isArray(character)) {
        throw new Error('The server returned an invalid character.');
    }
    return { avatar, fields: normalizeCardFields(character), character };
}

async function refreshSavedCharacter(avatar) {
    const previous = characters.find(character => character?.avatar === avatar);
    await getOneCharacter(avatar);
    const index = characters.findIndex(character => character?.avatar === avatar);
    if (index < 0 || characters[index] === previous) {
        throw new Error('The character was saved, but its roster entry could not be refreshed.');
    }
    if (document.getElementById('avatar_url_pole')?.value === avatar) {
        select_selected_character(index, { switchMenu: false });
    }
    await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: index, character: characters[index] } });
}

/** Save only reviewed fields; successful writes remain successful if refreshing fails. */
export async function saveCreatorChanges(draft, selectedFields) {
    const avatar = draft.sourceAvatar;
    requireAvatar(avatar);
    requireIdleGeneration();
    const snapshot = {
        sourceAvatar: avatar,
        baseline: structuredClone(draft.baseline),
        working: structuredClone(draft.working),
    };
    const selected = Array.from(selectedFields);
    const proposed = projectCardFields(snapshot);
    await flushCharacterSaveDebounced();
    const latest = await loadCreatorSource(avatar);
    requireIdleGeneration();
    const { patch, conflicts, changedFields, alreadySavedFields } = buildCharacterPatch(snapshot, selected, latest.fields);
    if (conflicts.length) {
        return { status: 'conflict', fields: latest.fields, conflicts, savedFields: {}, refreshError: null };
    }

    const savedFields = {};
    for (const field of [...changedFields, ...alreadySavedFields]) {
        savedFields[field] = structuredClone(proposed[field]);
    }
    if (changedFields.length) {
        const response = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(patch),
        });
        await requireSuccess(response, 'Saving the character');
    }

    // Once POST succeeds, a failed GET must not turn a committed write into a retry.
    let fields = { ...latest.fields, ...savedFields };
    let refreshError = null;
    if (changedFields.length) {
        try {
            fields = (await loadCreatorSource(avatar)).fields;
        } catch (error) {
            refreshError = error;
        }
    }
    reconcileSavedFields(draft, savedFields, fields);
    if (Object.keys(savedFields).length) {
        try {
            await refreshSavedCharacter(avatar);
        } catch (error) {
            refreshError ??= error;
        }
    }
    return {
        status: changedFields.length ? 'saved' : 'unchanged',
        fields,
        conflicts: [],
        savedFields,
        refreshError,
    };
}

/** Create independently of the legacy form and leave the active chat selected. */
export async function createCreatorCard(fields) {
    requireIdleGeneration();
    const submitted = normalizeCardFields(fields);
    if (!submitted.name.trim()) {
        throw new Error('A character name is required.');
    }
    const body = new FormData();
    for (const field of CARD_FIELDS) {
        if (field === 'alternate_greetings') {
            for (const greeting of submitted.alternate_greetings) {
                body.append(field, greeting);
            }
        } else {
            body.append(field === 'name' ? 'ch_name' : field, submitted[field]);
        }
    }

    let response;
    try {
        response = await fetch('/api/characters/create', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body,
        });
    } catch (cause) {
        const error = new Error('The creation outcome is unknown. Check the character list before trying again.', { cause });
        error.creationOutcomeUnknown = true;
        throw error;
    }
    await requireSuccess(response, 'Creating the character');
    let avatar;
    try {
        avatar = await response.text();
        requireAvatar(avatar);
    } catch (cause) {
        const error = new Error('The server accepted creation but did not return its identity. Check the character list before trying again.', { cause });
        error.creationOutcomeUnknown = true;
        throw error;
    }

    let savedFields = submitted;
    let refreshError = null;
    try {
        savedFields = (await loadCreatorSource(avatar)).fields;
        await getCharacters({ refreshEditor: false });
        if (!characters.some(character => character?.avatar === avatar)) {
            throw new Error('The character was created, but its roster entry could not be refreshed.');
        }
    } catch (error) {
        refreshError = error;
    }
    return { avatar, fields: savedFields, refreshError };
}
