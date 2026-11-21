/**
 * Helpers that need modules share. Not a need module itself: it lives beside `index.js`, because every file of `needs/`
 * is a need. Plain functions with no Playwright import.
 */

import { readFileSync } from 'node:fs';

/** The image that avatars and image messages use, served by the app itself. */
export const AVATAR_IMAGE = readFileSync(new URL('../../../public/img/ai4.png', import.meta.url));
export const AVATAR_IMAGE_URL = '/img/ai4.png';

const WORDS = ['amber', 'harbour', 'lantern', 'quiet', 'river', 'copper', 'window', 'garden', 'distant', 'bell', 'paper', 'orchard', 'slow', 'thread', 'morning', 'salt', 'ledger', 'meadow', 'cobalt', 'ember', 'willow', 'stone', 'drift', 'map'];

/** Deterministic filler text: `count` words from a fixed list, starting at `offset`. */
export function words(count, offset = 0) {
    return Array.from({ length: count }, (_, index) => WORDS[(offset + index * 7) % WORDS.length]).join(' ');
}

/** Deterministic sentences, each ending in a full stop. */
export function sentences(count, offset = 0) {
    return Array.from({ length: count }, (_, index) => {
        const text = words(8 + (index % 5), offset + index * 3);
        return `${text[0].toUpperCase()}${text.slice(1)}.`;
    }).join(' ');
}

/**
 * The account settings that `/api/settings/get` answers with, as the server has them now.
 * @param {{ post: Function }} api
 */
export async function readSettingsAnswer({ post }) {
    return (await post('/api/settings/get', { data: {} })).json();
}

/**
 * Creates a character card through the route the editor's Create button uses.
 * @param {Function} post The `post` of the seeding API.
 * @param {{ name: string, file: string, description?: string, personality?: string, scenario?: string, firstMessage?: string, example?: string, notes?: string, favorite?: boolean }} card
 */
export async function createCharacterCard(post, card) {
    await post('/api/characters/create', {
        data: {
            ch_name: card.name, file_name: card.file, description: card.description ?? '', personality: card.personality ?? '',
            scenario: card.scenario ?? '', first_mes: card.firstMessage ?? '', mes_example: card.example ?? '', creator_notes: card.notes ?? '',
            tags: '', talkativeness: '0.5', fav: String(card.favorite === true),
        },
    });
}

/** Whether a character file is on the server. */
export async function characterExists(post, avatar) {
    return (await post('/api/characters/get', { data: { avatar_url: avatar } }, { allow: [404, 500] })).ok();
}

/** Uploads an avatar image of a persona the way the persona editor does. */
export async function uploadPersonaAvatar(post, avatar) {
    await post('/api/avatars/upload', {
        multipart: { avatar: { name: avatar, mimeType: 'image/png', buffer: AVATAR_IMAGE }, overwrite_name: avatar },
    });
}

/** The extension settings of a `/api/settings/get` answer, created when missing. */
export function extensionSettings(settings) {
    settings.extension_settings ??= {};
    return settings.extension_settings;
}

/** Makes sure that extensions the data belongs to are not switched off in the settings of the boot. */
export function enableExtensions(settings, names) {
    const extensions = extensionSettings(settings);
    if (Array.isArray(extensions.disabledExtensions)) {
        extensions.disabledExtensions = extensions.disabledExtensions.filter(name => !names.includes(name));
    }
}

/** Replaces the entries of `list` that have an id of `items`, and adds the rest, keeping the order of `list`. */
export function mergeById(list, items) {
    const ids = new Set(items.map(item => item.id));
    return [...(Array.isArray(list) ? list : []).filter(entry => !ids.has(entry?.id)), ...items];
}

/** A chat record of a character or a user, with a fixed send date. */
export function chatMessage({ name, user = false, text, index, start, extra = {}, ...rest }) {
    return {
        name,
        is_user: user,
        is_system: false,
        send_date: new Date(start + index * 60_000).toISOString(),
        mes: text,
        extra,
        ...rest,
    };
}
