/**
 * Gives the Echo, Whisper and Ripple chat styles a character's current expression sprite
 * in place of the profile picture in their large picture slot.
 *
 * The module only marks message elements with `data-sb-expression` and `--sb-message-expression`.
 * `public/css/sillybunny-chat-styles.css` paints the sprite. It writes no persistent data, and it
 * never touches `--mes-avatar-url`, `--sb-message-avatar` or the avatar image, which other code owns.
 */

import { eventSource, event_types } from '../../events.js';

const STYLE_CLASSES = ['echostyle', 'whisperstyle', 'ripplestyle'];
const PROPERTY_NAME = '--sb-message-expression';
const ATTRIBUTE_NAME = 'data-sb-expression';
const NEUTRAL_LABEL = 'neutral';
const RESET_LABEL = '#reset';
const DEFAULT_SPRITE_PATH_PREFIX = '/img/default-expressions/';
const PASS_DELAY_MS = 25;

// The value of `system_message_types.NARRATOR`. The constant lives in a module that pulls in the whole
// application, which would make the pure functions below impossible to import in a unit test.
const NARRATOR_MESSAGE_TYPE = 'narrator';

/**
 * @typedef {object} SpriteGroup
 * @property {string} label
 * @property {{ imageSrc: string }[]} files
 */

/**
 * @typedef {object} SpriteHost
 * @property {() => Promise<string[]>} getExpressionsList
 * @property {(folder: string) => Promise<SpriteGroup[]>} getSpritesList
 * @property {(message: object, name: string) => string} getSpriteFolderName
 * @property {(folderKey: string) => string | undefined} getLastExpression
 * @property {() => { chat: object[], groupId: string | null, name2: string }} getContext
 * @property {() => string | null | undefined} getFallbackExpression
 */

/**
 * The extension keeps the current expression under the first segment of the sprite folder.
 * @param {string} spriteFolderName
 * @returns {string}
 */
export function getFolderKey(spriteFolderName) {
    return String(spriteFolderName ?? '').split('/')[0];
}

/**
 * Only messages of a character carry a sprite. User, system and narrator messages do not.
 * @param {object | null | undefined} message
 * @returns {boolean}
 */
export function isSpriteEligibleMessage(message) {
    if (!message || typeof message !== 'object') {
        return false;
    }

    return !message.is_user && !message.is_system && message.extra?.type !== NARRATOR_MESSAGE_TYPE;
}

/**
 * Resolves the sprite folder of a message the way the extension's module worker does: a single-character
 * chat uses the card's name when the folder is just the message's own name, so a message from before the
 * card was renamed keeps its sprite. A message with a forced avatar was sent as someone else, and keeps
 * the folder of its own name.
 * @param {object} message
 * @param {Pick<SpriteHost, 'getSpriteFolderName'>} host
 * @param {{ groupId: string | null, name2: string }} context
 * @returns {string}
 */
export function resolveMessageFolder(message, host, context) {
    const folder = host.getSpriteFolderName(message, message.name);

    if (folder === message.name && !context.groupId && context.name2 && !message.force_avatar) {
        return context.name2;
    }

    return folder;
}

/**
 * Keeps one source per label for the labels the extension knows. The default emoji set never counts.
 * Each group already lists its main file first.
 * @param {SpriteGroup[]} groups
 * @param {string[]} validLabels
 * @returns {Map<string, string>}
 */
export function buildValidSprites(groups, validLabels) {
    const valid = new Set(validLabels);
    /** @type {Map<string, string>} */
    const sprites = new Map();

    for (const group of Array.isArray(groups) ? groups : []) {
        const src = group?.files?.[0]?.imageSrc;

        if (!valid.has(group?.label) || typeof src !== 'string' || !src || src.startsWith(DEFAULT_SPRITE_PATH_PREFIX)) {
            continue;
        }

        if (!sprites.has(group.label)) {
            sprites.set(group.label, src);
        }
    }

    return sprites;
}

/**
 * Picks the sprite of the current expression, else of the fallback expression, else of `neutral`.
 * @param {Map<string, string>} sprites The valid sprites of the character, by label.
 * @param {string | null | undefined} current
 * @param {string | null | undefined} fallback
 * @returns {{ label: string, src: string } | null}
 */
export function pickSprite(sprites, current, fallback) {
    const candidates = [current, fallback, NEUTRAL_LABEL];

    for (const label of candidates) {
        if (!label || label === RESET_LABEL || label.startsWith('#')) {
            continue;
        }

        const src = sprites.get(label);

        if (src) {
            return { label, src };
        }
    }

    return null;
}

/**
 * @param {Document} [doc]
 * @returns {boolean}
 */
function hasChatStyleWithSprites(doc = document) {
    return STYLE_CLASSES.some(name => doc.body.classList.contains(name));
}

/**
 * @param {SpriteHost} host
 */
export function initChatStyleSprites(host) {
    /** @type {Map<string, Promise<SpriteGroup[]>>} */
    let spriteCache = new Map();
    let passToken = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;

    function getGroups(folder) {
        let promise = spriteCache.get(folder);

        if (!promise) {
            promise = Promise.resolve(host.getSpritesList(folder)).catch(() => []);
            spriteCache.set(folder, promise);
        }

        return promise;
    }

    function clearMark(element) {
        if (element.hasAttribute(ATTRIBUTE_NAME)) {
            element.removeAttribute(ATTRIBUTE_NAME);
        }

        if (element.style.getPropertyValue(PROPERTY_NAME)) {
            element.style.removeProperty(PROPERTY_NAME);
        }
    }

    function setMark(element, label, src) {
        const value = `url(${JSON.stringify(src)})`;

        if (element.getAttribute(ATTRIBUTE_NAME) !== label) {
            element.setAttribute(ATTRIBUTE_NAME, label);
        }

        if (element.style.getPropertyValue(PROPERTY_NAME) !== value) {
            element.style.setProperty(PROPERTY_NAME, value);
        }
    }

    async function runPass() {
        const token = ++passToken;

        if (!hasChatStyleWithSprites()) {
            document.querySelectorAll(`#chat .mes[${ATTRIBUTE_NAME}]`).forEach(clearMark);
            return;
        }

        const context = host.getContext();
        const entries = [];

        document.querySelectorAll('#chat .mes[mesid]').forEach(element => {
            const message = context.chat?.[Number(element.getAttribute('mesid'))];
            const folder = isSpriteEligibleMessage(message) ? resolveMessageFolder(message, host, context) : '';
            entries.push({ element, folder });
        });

        const folders = [...new Set(entries.map(entry => entry.folder).filter(Boolean))];
        const validLabels = folders.length ? await host.getExpressionsList() : [];
        const spritesByFolder = new Map();

        await Promise.all(folders.map(async folder => {
            spritesByFolder.set(folder, buildValidSprites(await getGroups(folder), validLabels));
        }));

        // A newer pass has started while this one waited for sprite lists, so its result is stale.
        if (token !== passToken) {
            return;
        }

        const fallback = host.getFallbackExpression();

        for (const { element, folder } of entries) {
            const sprites = folder ? spritesByFolder.get(folder) : null;
            const picked = sprites ? pickSprite(sprites, host.getLastExpression(getFolderKey(folder)), fallback) : null;

            if (picked) {
                setMark(element, picked.label, picked.src);
            } else {
                clearMark(element);
            }
        }
    }

    function schedule() {
        if (timer !== null) {
            return;
        }

        timer = setTimeout(() => {
            timer = null;
            runPass().catch(error => console.debug('Chat style sprites: pass failed', error));
        }, PASS_DELAY_MS);
    }

    function resetAndSchedule() {
        spriteCache = new Map();
        schedule();
    }

    eventSource.on(event_types.CHAT_CHANGED, resetAndSchedule);

    for (const type of [
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_DELETED,
        event_types.MORE_MESSAGES_LOADED,
        event_types.GROUP_UPDATED,
        event_types.GROUP_MEMBER_DRAFTED,
    ]) {
        eventSource.on(type, schedule);
    }

    // A streamed reply is in the chat from its first token, but its render event comes when the stream ends.
    // Without this the reply would show the avatar for the whole stream and change to the sprite at the end.
    const chat = document.getElementById('chat');
    if (chat) {
        new MutationObserver(schedule).observe(chat, { childList: true });
    }

    document.addEventListener('sb:expression-changed', schedule);
    document.addEventListener('sb:expression-sprites-changed', resetAndSchedule);
    document.addEventListener('sb:chat-style-updated', schedule);

    schedule();
}
