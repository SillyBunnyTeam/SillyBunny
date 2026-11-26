/**
 * The round pictures of the details window: a character, a conversation, and the tiled picture of a group that has none
 * of its own. Each is one element that is sized by `--sb-details-avatar-size`.
 */

import { createLazyImage } from '../../sillybunny-editor/lazy-image.js';
import { pickTileAvatars } from './details-logic.js';
import { getCardName, getGroupAvatarUrl, getThumbnailUrlFor } from './access.js';

// AdwAvatar draws initials on a gradient picked by a hash of the name when it has no picture.
const GRADIENTS = Object.freeze([
    ['#99c1f1', '#62a0ea'], ['#8ff0a4', '#57e389'], ['#f9f06b', '#f8e45c'], ['#ffbe6f', '#ffa348'],
    ['#f66151', '#ed333b'], ['#dc8add', '#c061cb'], ['#cdab8f', '#b5835a'], ['#c0bfbc', '#9a9996'],
]);

function hashOf(name) {
    let hash = 0;
    for (const char of name) {
        hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    }
    return hash;
}

function initialsOf(name) {
    const words = String(name).trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
        return '?';
    }
    return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words.at(-1)[0]).toUpperCase();
}

function gradientOf(name) {
    const [from, to] = GRADIENTS[hashOf(name) % GRADIENTS.length];
    return `linear-gradient(${from}, ${to})`;
}

function createFrame({ name, size, extraClass = '' }) {
    const frame = document.createElement('span');
    frame.className = `sb-details-avatar ${extraClass}`.trim();
    frame.style.setProperty('--sb-details-avatar-size', `${size}px`);
    frame.setAttribute('role', 'img');
    frame.setAttribute('aria-label', name);
    return frame;
}

function createPicture(src) {
    return createLazyImage(src);
}

function appendInitials(frame, name) {
    frame.style.background = gradientOf(name);
    const initials = document.createElement('span');
    initials.className = 'sb-details-avatar__initials';
    initials.textContent = initialsOf(name);
    initials.setAttribute('aria-hidden', 'true');
    frame.append(initials);
}

/** A picture in a circle, or initials on a gradient while there is no picture. */
export function createAvatar({ name, src = '', size = 36 }) {
    const frame = createFrame({ name, size });
    if (src) {
        frame.append(createPicture(src));
    } else {
        appendInitials(frame, name);
    }
    return frame;
}

/** The picture of a character card. A card that is gone shows its file name as initials. */
export function createCharacterAvatar(avatar, { size = 36 } = {}) {
    return createAvatar({ name: getCardName(avatar), src: getThumbnailUrlFor(avatar, size), size });
}

/**
 * Up to four member pictures tiled in one circle: two side by side, three with the third across the bottom, four in a grid.
 * @param {{ name: string, avatars: string[], size?: number }} options
 */
export function createTiledAvatar({ name, avatars, size = 128 }) {
    const shown = pickTileAvatars(avatars);
    const frame = createFrame({ name, size, extraClass: 'sb-details-avatar--tiled' });
    frame.dataset.count = String(shown.length);
    for (const avatar of shown) {
        const tile = document.createElement('span');
        tile.className = 'sb-details-avatar__tile';
        const src = getThumbnailUrlFor(avatar, size / 2);
        if (src) {
            tile.append(createPicture(src));
        } else {
            tile.style.background = gradientOf(getCardName(avatar));
        }
        frame.append(tile);
    }
    return frame;
}

/**
 * The picture that stands for a conversation: the character of a direct one, the uploaded picture of a group, or its
 * members tiled when none was uploaded.
 * @param {Record<string, any>} view The conversation.
 * @param {{ size?: number, name?: string }} [options]
 */
export function createConversationAvatar(view, { size = 128, name = '' } = {}) {
    if (view.kind === 'direct') {
        return createCharacterAvatar(view.characters[0], { size });
    }
    const label = name || view.name || 'Group';
    if (view.avatar) {
        return createAvatar({ name: label, src: getGroupAvatarUrl(view), size });
    }
    return createTiledAvatar({ name: label, avatars: view.characters, size });
}
