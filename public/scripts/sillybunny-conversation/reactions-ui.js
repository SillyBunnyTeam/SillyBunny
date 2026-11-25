/**
 * The interface of reactions in the workspace: the chips under a message, the list of who reacted, the quick row that
 * the toolbar and the message menu show, and More Reactions, which opens the emoji chooser. The rules (what a reaction
 * is, how it is counted) are in `reaction-model.js`; this file only draws them and writes the user's choice.
 */

import { getThumbnailUrl } from '../../script.js';
import { openPopover } from '../sillybunny-action-menu.js';
import { getConversationStore, getCurrentCharAvatar, persistConversationStore } from './context.js';
import { emojiKey } from './emoji/emoji-validate.js';
import { getConversationMessages, updateConversationChatMessageReactions } from './conversation-store.js';
import { getCharacterForAvatar } from './media.js';
import {
    DEFAULT_QUICK_REACTIONS,
    USER_REACTOR,
    describeReactionChip,
    getQuickReactions,
    groupReactions,
    pushReactionRecent,
    readReactionRecents,
    readReactions,
    toggleUserReaction,
} from './reaction-model.js';

/** What the toolbar shows of the quick row: it has no room for more, so the menu holds the rest. */
export const TOOLBAR_QUICK_SLOTS = 2;
export const MENU_QUICK_SLOTS = 6;
const MESSAGE_SELECTOR = '.sb-conversation-message';
const CHIP_SELECTOR = '.sb-conversation-message-reaction-chip';
const OPEN_CLASS = 'has-open-menu';
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP_PX = 10;
const CLICK_SWALLOW_MS = 700;
const CHOOSER_MODULE = './emoji/emoji-chooser.js';
const MORE_REACTIONS_LABEL = 'More Reactions';
const YOU_LABEL = 'You';
const FALLBACK_CHARACTER_LABEL = 'Character';

function toast(kind, text) {
    globalThis.toastr?.[kind]?.(text);
}

// ---------------------------------------------------------------------------------------------------------------------
// Recents and the quick row

function readRecents() {
    return readReactionRecents(getConversationStore().reactionRecents);
}

/** The emoji of the quick row: the user's recent reactions, topped up from the default six. */
export function getQuickReactionRow(size) {
    return getQuickReactions(readRecents(), size);
}

/** The name of an emoji for a label, when the settings or the default six know it. An empty text otherwise: the emoji itself is then the label. */
export function getReactionName(emoji) {
    const key = emojiKey(emoji);
    return [...readRecents(), ...DEFAULT_QUICK_REACTIONS].find(item => emojiKey(item.e) === key)?.n ?? '';
}

function rememberReaction(emoji, name) {
    const store = getConversationStore();
    const recents = readReactionRecents(store.reactionRecents);
    if (recents[0] && emojiKey(recents[0].e) === emojiKey(emoji)) {
        return;
    }
    store.reactionRecents = pushReactionRecent(recents, { e: emoji, n: name || getReactionName(emoji) });
    persistConversationStore();
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing the user's reaction

function findMessage(messageId) {
    const avatar = getCurrentCharAvatar();
    return avatar && messageId ? getConversationMessages(avatar).find(message => message.id === messageId) ?? null : null;
}

/** Whether the user has reacted to the message with the emoji. */
export function hasUserReaction(messageId, emoji) {
    const key = emojiKey(emoji);
    return readReactions(findMessage(messageId)).some(entry => entry.by === USER_REACTOR && emojiKey(entry.emoji) === key);
}

/**
 * The user pressing an emoji of a message: the reaction is taken back when it is there, and added when it is not.
 * @returns {'added'|'removed'|'refused'|'invalid'}
 */
export function reactConversationMessage(messageId, emoji, { name = '' } = {}) {
    const avatar = getCurrentCharAvatar();
    if (!avatar || !messageId) {
        return 'invalid';
    }

    let status = 'invalid';
    updateConversationChatMessageReactions(avatar, messageId, (entries) => {
        const result = toggleUserReaction(entries, emoji);
        status = result.status;
        return result.entries;
    });
    if (status === 'added') {
        rememberReaction(emoji, name);
    } else if (status === 'refused') {
        // The maintainer words what a message that holds 20 distinct emoji says.
        toast('info', 'TODO(copy)');
    }
    return status;
}

// ---------------------------------------------------------------------------------------------------------------------
// The toolbar and the menu

/** The reaction row shows the emoji as text, with the name as the label, and says whether the user has chosen it. */
function paintQuickButton(button, { e, n }, pressed) {
    const label = n || e;
    if (button.dataset.reaction !== e) {
        button.textContent = e;
        button.dataset.reaction = e;
        button.title = label;
        button.setAttribute('aria-label', label);
    }
    button.setAttribute('aria-pressed', String(pressed));
}

export function getUserReactionKeys(message) {
    return new Set(readReactions(message).filter(entry => entry.by === USER_REACTOR).map(entry => emojiKey(entry.emoji)));
}

/** The reaction buttons of a message's toolbar: the first emoji of the quick row, and More Reactions. */
export function createToolbarReactionButtons(message) {
    const mine = getUserReactionKeys(message);
    const buttons = getQuickReactionRow(TOOLBAR_QUICK_SLOTS).map((reaction) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sb-conversation-reaction-button';
        button.dataset.sbConversationAction = 'react-message';
        button.dataset.messageId = message.id;
        paintQuickButton(button, reaction, mine.has(emojiKey(reaction.e)));
        return button;
    });

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'sb-conversation-reaction-button sb-conversation-reaction-more';
    more.title = MORE_REACTIONS_LABEL;
    more.setAttribute('aria-label', MORE_REACTIONS_LABEL);
    more.setAttribute('aria-haspopup', 'dialog');
    more.dataset.sbConversationAction = 'open-reaction-chooser';
    more.dataset.messageId = message.id;
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-face-smile';
    icon.setAttribute('aria-hidden', 'true');
    more.append(icon);
    return [...buttons, more];
}

/**
 * Brings the toolbar of a message up to date with the recent reactions, which change without a message changing. Called
 * when the pointer or the focus reaches the message, so that a toolbar nobody looks at costs nothing.
 */
export function syncToolbarReactions(item) {
    const buttons = item.querySelectorAll(':scope .sb-conversation-message-actions > .sb-conversation-reaction-button:not(.sb-conversation-reaction-more)');
    if (!buttons.length) {
        return;
    }
    const mine = getPressedKeys(item);
    const row = getQuickReactionRow(TOOLBAR_QUICK_SLOTS);
    buttons.forEach((button, index) => {
        if (row[index]) {
            paintQuickButton(button, row[index], mine.has(emojiKey(row[index].e)));
        }
    });
}

/** The reactions that the user has made to the message of a row, read from its chips. */
export function getPressedKeys(item) {
    return new Set([...item.querySelectorAll(`${CHIP_SELECTOR}[aria-pressed="true"]`)].map(chip => emojiKey(chip.dataset.reaction)));
}

/**
 * The reaction section of the message menu and its sheet: the whole quick row, and More Reactions.
 * @param {HTMLElement} item The message row.
 * @param {HTMLElement} trigger What opened the menu; the chooser opens at it.
 * @returns {import('../sillybunny-action-menu.js').ActionMenuReaction[]}
 */
export function buildMenuReactions(item, trigger) {
    const messageId = item.dataset.messageId || '';
    const mine = getPressedKeys(item);
    const reactions = getQuickReactionRow(MENU_QUICK_SLOTS).map(({ e, n }) => ({
        text: e,
        label: n || e,
        pressed: mine.has(emojiKey(e)),
        onSelect: () => void reactConversationMessage(messageId, e, { name: n }),
    }));
    reactions.push({
        text: '',
        icon: 'fa-solid fa-face-smile',
        label: MORE_REACTIONS_LABEL,
        onSelect: () => void openReactionChooser(messageId, trigger),
    });
    return reactions;
}

// ---------------------------------------------------------------------------------------------------------------------
// More Reactions

/**
 * Opens the emoji chooser for a message. The chooser is its own module and loads when it is first needed.
 * @param {string} messageId
 * @param {HTMLElement} trigger The control that the chooser opens at, and returns the focus to.
 */
export async function openReactionChooser(messageId, trigger) {
    let chooser = null;
    try {
        chooser = await import(CHOOSER_MODULE);
    } catch (error) {
        console.warn('Conversation Mode: the emoji chooser could not be loaded', error);
    }
    if (typeof chooser?.openEmojiChooser !== 'function') {
        toast('warning', 'TODO(copy)');
        return;
    }

    const item = trigger.closest(MESSAGE_SELECTOR);
    // The toolbar shows only while the pointer is over the message, and the chooser takes the pointer away.
    item?.classList.add(OPEN_CLASS);
    chooser.openEmojiChooser({
        trigger,
        kind: 'react',
        bounds: document.getElementById('sb_conversation_timeline'),
        isPicked: emoji => hasUserReaction(messageId, emoji),
        onPick: (emoji, { name = '' } = {}) => void reactConversationMessage(messageId, emoji, { name }),
        onClose: () => item?.classList.remove(OPEN_CLASS),
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// The chips

function getReactorName(by) {
    return by === USER_REACTOR
        ? YOU_LABEL
        : getCharacterForAvatar(by)?.name || String(by).replace(/\.[a-z0-9]+$/i, '') || FALLBACK_CHARACTER_LABEL;
}

/** The reactors of a chip in the order that the list shows them: the user first, then the others as they came. */
function sortReactors(reactors) {
    return [...reactors].sort((left, right) => Number(right.by === USER_REACTOR) - Number(left.by === USER_REACTOR));
}

function createChip(messageId, chip) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sb-conversation-message-reaction-chip';
    button.setAttribute('aria-pressed', String(chip.mine));
    button.setAttribute('aria-label', describeReactionChip(chip, getReactionName(chip.emoji)));
    // A hint for the pointer. The list of reactors is also one command away for the keyboard and a finger (see bindReactionChips).
    button.title = sortReactors(chip.reactors).map(reactor => getReactorName(reactor.by)).join(', ');
    button.dataset.sbConversationAction = 'react-message';
    button.dataset.messageId = messageId;
    button.dataset.reaction = chip.emoji;

    const emoji = document.createElement('span');
    emoji.className = 'sb-conversation-reaction-emoji';
    emoji.textContent = chip.emoji;
    button.append(emoji);
    if (chip.count > 1) {
        const count = document.createElement('span');
        count.className = 'sb-conversation-reaction-count';
        count.textContent = String(chip.count);
        button.append(count);
    }
    return button;
}

/** The row of chips under a message, or null when it has no reaction. */
export function createReactionChips(message) {
    const chips = groupReactions(readReactions(message));
    if (!chips.length) {
        return null;
    }
    const row = document.createElement('div');
    row.className = 'sb-conversation-message-reactions';
    row.append(...chips.map(chip => createChip(message.id, chip)));
    return row;
}

// ---------------------------------------------------------------------------------------------------------------------
// Who reacted

function createReactorList(reactors) {
    const list = document.createElement('ul');
    list.className = 'sb-reaction-people';
    // A list whose bullets are removed loses its role in Safari.
    list.setAttribute('role', 'list');
    for (const { by } of sortReactors(reactors)) {
        const row = document.createElement('li');
        row.className = 'sb-reaction-person';
        const picture = document.createElement(by === USER_REACTOR ? 'i' : 'img');
        picture.className = 'sb-reaction-person-picture';
        if (by === USER_REACTOR) {
            picture.classList.add('fa-solid', 'fa-user');
        } else {
            picture.alt = '';
            picture.src = getThumbnailUrl('avatar', by);
        }
        picture.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.className = 'sb-reaction-person-name';
        name.textContent = getReactorName(by);
        row.append(picture, name);
        list.append(row);
    }
    return list;
}

/** Opens the list of who reacted with the emoji of a chip, at the chip. */
export function openReactionPeople(chipButton) {
    const message = findMessage(chipButton.dataset.messageId);
    const key = emojiKey(chipButton.dataset.reaction || '');
    const chip = groupReactions(readReactions(message)).find(candidate => candidate.key === key);
    if (!chip) {
        return;
    }
    openPopover({
        trigger: chipButton,
        title: getReactionName(chip.emoji) || chip.emoji,
        content: createReactorList(chip.reactors),
        bounds: document.getElementById('sb_conversation_timeline'),
    });
}

const getChip = target => (target instanceof Element ? target.closest(CHIP_SELECTOR) : null);

/**
 * The commands that open the list of who reacted: the secondary click, the Menu key and Shift+F10, and a long press on a
 * touch screen, which sends no secondary click on every platform. The same list serves all of them, so a chip never needs
 * a hover to say who is behind it.
 */
export function bindReactionChips() {
    let press = null;
    let swallowClicksUntil = 0;

    const cancelPress = () => {
        if (press) {
            clearTimeout(press.timer);
            press = null;
        }
    };

    document.addEventListener('contextmenu', (event) => {
        const chip = getChip(event.target);
        if (!(chip instanceof HTMLElement) || event.shiftKey) {
            return;
        }
        event.preventDefault();
        // A long press opens the list by its own timer, and the browser then sends this event too: opening again would close it.
        if (Date.now() >= swallowClicksUntil) {
            openReactionPeople(chip);
        }
    });

    window.addEventListener('keydown', (event) => {
        const isMenuKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
        const chip = isMenuKey ? getChip(document.activeElement) : null;
        if (!(chip instanceof HTMLElement)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        openReactionPeople(chip);
    }, true);

    document.addEventListener('pointerdown', (event) => {
        const chip = getChip(event.target);
        if (!(chip instanceof HTMLElement) || event.pointerType === 'mouse') {
            return;
        }
        cancelPress();
        press = {
            x: event.clientX,
            y: event.clientY,
            timer: setTimeout(() => {
                press = null;
                swallowClicksUntil = Date.now() + CLICK_SWALLOW_MS;
                openReactionPeople(chip);
            }, LONG_PRESS_MS),
        };
    }, { passive: true });

    document.addEventListener('pointermove', (event) => {
        if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP_PX) {
            cancelPress();
        }
    }, { passive: true });
    for (const type of ['pointerup', 'pointercancel']) {
        document.addEventListener(type, cancelPress, { passive: true });
    }

    // The click that ends a long press would toggle the reaction that the list is about.
    window.addEventListener('click', (event) => {
        if (Date.now() < swallowClicksUntil && getChip(event.target)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
}
