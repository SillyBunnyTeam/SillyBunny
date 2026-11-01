import { getHomeAssistants, getOptionalAssistants } from './assistant-registry.js';

const POINTER_SLOT = 'AS-POINTER-SUB';
const POINTER_ART = 'row-pointer';

/**
 * `available` has a card in the library. `missing` and `deleted` have none, and differ in why: the account recorded the
 * deletion of a `deleted` card, which is what a Restore will act on.
 * @typedef {'available' | 'missing' | 'deleted'} AssistantCardState
 *
 * @typedef {object} AssistantCard
 * @property {string} key Names the card in the DOM, `assistant-` and an id.
 * @property {string} id
 * @property {string} name
 * @property {string} slot Copy slot of the subtitle.
 * @property {{ name: string, avatar: string | null }} art `name` is the size key; an `avatar` is shown as the thumbnail of that card.
 * @property {string | null} avatar The avatar the card has in the library, or null while it has none.
 * @property {AssistantCardState} state
 *
 * @typedef {{ avatar: string, name: string }} LibraryCharacter
 * @typedef {object} AssistantLibrary What the cards are read from, on every render of Home.
 * @property {(assistant: import('./assistant-registry.js').AssistantEntry) => LibraryCharacter | null} findCard
 *   The card of a registry assistant, by the avatar it has now.
 * @property {(avatar: string) => LibraryCharacter | null} findAvatar
 * @property {(assistant: import('./assistant-registry.js').AssistantEntry) => boolean} isDeleted
 */

/**
 * @param {import('./assistant-registry.js').AssistantEntry} assistant
 * @param {AssistantLibrary} library
 * @param {boolean} showsCardArt Whether the card of the character is the art, in place of the box where art will go.
 * @returns {AssistantCard}
 */
function describeAssistant(assistant, library, showsCardArt) {
    const found = library.findCard(assistant);
    return {
        key: `assistant-${assistant.id}`,
        id: assistant.id,
        name: assistant.name,
        slot: assistant.slot,
        art: { name: assistant.art, avatar: showsCardArt ? (found?.avatar ?? null) : null },
        avatar: found?.avatar ?? null,
        state: found ? 'available' : (library.isDeleted(assistant) ? 'deleted' : 'missing'),
    };
}

/**
 * The cards of the Assistants section. The character the pointer names comes first unless it is Reisen or Tewi, who
 * have cards of their own after it; the optional assistants that are installed come last.
 * @param {object} options
 * @param {AssistantLibrary} options.library
 * @param {string | null | undefined} options.pointerAvatar The avatar the account's assistant pointer names.
 * @returns {AssistantCard[]}
 */
export function getAssistantCards({ library, pointerAvatar }) {
    const homeCards = getHomeAssistants().map(assistant => describeAssistant(assistant, library, false));
    const installed = getOptionalAssistants()
        .map(assistant => describeAssistant(assistant, library, true))
        .filter(card => card.state === 'available');

    const pointed = pointerAvatar ? library.findAvatar(pointerAvatar) : null;
    if (!pointed || homeCards.some(card => card.avatar === pointed.avatar)) {
        return [...homeCards, ...installed];
    }

    const optional = installed.find(card => card.avatar === pointed.avatar);
    if (optional) {
        return [optional, ...homeCards, ...installed.filter(card => card !== optional)];
    }
    const pointer = {
        key: 'assistant-pointer',
        id: 'pointer',
        name: pointed.name,
        slot: POINTER_SLOT,
        art: { name: POINTER_ART, avatar: pointed.avatar },
        avatar: pointed.avatar,
        state: 'available',
    };
    return [pointer, ...homeCards, ...installed];
}
