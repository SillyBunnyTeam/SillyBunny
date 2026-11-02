import { getHomeAssistants } from './assistant-registry.js';
import { NO_OFFERS, findOffers } from './managed-content.js';

const POINTER_SLOT = 'AS-POINTER-SUB';
const CHOOSE_SLOT = 'AS-CHOOSE-SUB';
const POINTER_ART = 'row-pointer';

// A collator compares without building one per comparison, which a library of thousands of names would otherwise do.
// The names tie by letter case and accents, so the avatar, which differs per file, breaks the tie and keeps the order stable.
const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' });
const AVATAR_COLLATOR = new Intl.Collator();

/** The same key in both states of the third slot, so focus finds the card again after the pointer changes. */
export const OWN_CARD_KEY = 'assistant-own';

/**
 * `available` has a card in the library. `missing` and `deleted` have none, and differ in why: the account recorded the
 * deletion of a `deleted` card, which is what a Restore will act on.
 * @typedef {'available' | 'missing' | 'deleted'} AssistantCardState
 *
 * A card with a character: `bundled` is Reisen or Tewi, who always have a card, and `pointer` is the character that the
 * account's assistant pointer names, in the third slot.
 * @typedef {object} AssistantCard
 * @property {string} key Names the card in the DOM, `assistant-` and an id.
 * @property {string} id
 * @property {'bundled' | 'pointer'} kind
 * @property {string} name
 * @property {string} slot Copy slot of the subtitle.
 * @property {{ name: string, avatar: string | null }} art `name` is the size key; an `avatar` is shown as the thumbnail of that card.
 * @property {string | null} avatar The avatar the card has in the library, or null while it has none.
 * @property {AssistantCardState} state
 * @property {import('./managed-content.js').ManagedOffers} offers What the card may offer for its bundled file.
 *
 * The third slot while the pointer names no character of its own. The view labels it and draws its icon.
 * @typedef {object} ChooseCard
 * @property {typeof OWN_CARD_KEY} key
 * @property {'own'} id
 * @property {'choose'} kind
 * @property {null} name
 * @property {string} slot
 * @property {null} art
 * @property {null} avatar
 * @property {'available'} state
 * @property {import('./managed-content.js').ManagedOffers} offers
 *
 * @typedef {{ avatar: string, name: string }} LibraryCharacter
 * @typedef {object} AssistantLibrary What the cards are read from, on every render of Home.
 * @property {(assistant: import('./assistant-registry.js').AssistantEntry) => LibraryCharacter | null} findCard
 *   The card of a registry assistant, by the avatar it has now.
 * @property {(avatar: string) => LibraryCharacter | null} findAvatar
 * @property {(assistant: import('./assistant-registry.js').AssistantEntry) => boolean} isDeleted
 * @property {() => LibraryCharacter[]} listCharacters Every character of the library, not its groups.
 *
 * @typedef {object} PickerEntry
 * @property {string} avatar
 * @property {string} name
 * @property {boolean} selected Whether the pointer names the character.
 */

/**
 * What the server knows of the bundled files, and what the user kept their cards against.
 * @typedef {object} ManagedState
 * @property {import('./managed-content.js').ManagedItem[] | null} items Null while the status is not known.
 * @property {Map<string, number>} dismissed
 */

/** @type {ManagedState} */
const UNKNOWN_MANAGED = Object.freeze({ items: null, dismissed: new Map() });

/**
 * @param {import('./assistant-registry.js').AssistantEntry} assistant
 * @param {AssistantLibrary} library
 * @param {ManagedState} managed
 * @returns {AssistantCard}
 */
function describeAssistant(assistant, library, managed) {
    const found = library.findCard(assistant);
    const state = found ? 'available' : (library.isDeleted(assistant) ? 'deleted' : 'missing');
    return {
        key: `assistant-${assistant.id}`,
        id: assistant.id,
        kind: 'bundled',
        name: assistant.name,
        slot: assistant.slot,
        art: { name: assistant.art, avatar: null },
        avatar: found?.avatar ?? null,
        state,
        offers: findOffers({ filename: assistant.defaultAvatar, cardState: state, items: managed.items, dismissed: managed.dismissed }),
    };
}

/**
 * @param {LibraryCharacter} character
 * @returns {AssistantCard}
 */
function describePointer(character) {
    return {
        key: OWN_CARD_KEY,
        id: 'pointer',
        kind: 'pointer',
        name: character.name,
        slot: POINTER_SLOT,
        art: { name: POINTER_ART, avatar: character.avatar },
        avatar: character.avatar,
        state: 'available',
        offers: NO_OFFERS,
    };
}

/** @type {ChooseCard} */
const CHOOSE_CARD = Object.freeze({
    key: OWN_CARD_KEY, id: 'own', kind: 'choose', name: null, slot: CHOOSE_SLOT, art: null, avatar: null, state: 'available', offers: NO_OFFERS,
});

/**
 * The avatars of the cards that Reisen and Tewi have now. A character with one of them has a card of its own, so it is
 * never the third one.
 * @param {AssistantLibrary} library
 * @returns {Set<string>}
 */
function getBundledAvatars(library) {
    const avatars = getHomeAssistants().map(assistant => library.findCard(assistant)?.avatar).filter(Boolean);
    return new Set(avatars);
}

/**
 * The cards of the Assistants section: Reisen, Tewi, then the third slot. The slot is the card to choose from until the
 * pointer names a character of the library that is neither Reisen nor Tewi, and then it is that character's card.
 * @param {object} options
 * @param {AssistantLibrary} options.library
 * @param {string | null | undefined} options.pointerAvatar The avatar the account's assistant pointer names.
 * @param {ManagedState} [options.managed] Without it, no card offers Restore or Update.
 * @returns {(AssistantCard | ChooseCard)[]}
 */
export function getAssistantCards({ library, pointerAvatar, managed = UNKNOWN_MANAGED }) {
    const bundledCards = getHomeAssistants().map(assistant => describeAssistant(assistant, library, managed));
    const pointed = pointerAvatar ? library.findAvatar(pointerAvatar) : null;
    if (!pointed || bundledCards.some(card => card.avatar === pointed.avatar)) {
        return [...bundledCards, CHOOSE_CARD];
    }
    return [...bundledCards, describePointer(pointed)];
}

/**
 * The characters that the picker lists: the library by name, without Reisen and Tewi, who always have a card.
 * @param {object} options
 * @param {AssistantLibrary} options.library
 * @param {string | null | undefined} options.pointerAvatar
 * @returns {PickerEntry[]}
 */
export function getAssistantPickerEntries({ library, pointerAvatar }) {
    const bundledAvatars = getBundledAvatars(library);
    return library.listCharacters()
        .filter(character => !bundledAvatars.has(character.avatar))
        .map(character => ({ avatar: character.avatar, name: character.name, selected: character.avatar === pointerAvatar }))
        .sort((a, b) => NAME_COLLATOR.compare(a.name, b.name) || AVATAR_COLLATOR.compare(a.avatar, b.avatar));
}
