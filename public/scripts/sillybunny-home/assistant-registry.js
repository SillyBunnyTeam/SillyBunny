/**
 * The assistants that SillyBunny ships, in one list that Home, the Welcome Screen code, Getting Started and Bundled
 * Extras all read.
 *
 * Reisen and Tewi come from the server: it seeds their cards, and the browser only looks for them, so a missing card
 * stays missing until the server puts it back.
 *
 * @typedef {object} AssistantEntry
 * @property {string} id
 * @property {string} name The name that Home and Bundled Extras show.
 * @property {boolean} [home] Whether Home always lists the assistant, even before her card exists.
 * @property {string} [art] Name of the art on Home, and its size key.
 * @property {string} avatarStorageKey Account storage key of the avatar that the user chose for this assistant.
 * @property {string} identityStorageKey Account storage key of the avatar that this assistant's card has now.
 * @property {string} deletedStorageKey Account storage key that marks the card as deleted by the user.
 * @property {string} defaultAvatar The avatar file of the card as it is first named.
 * @property {string} fileName The name of the card file, without the extension.
 * @property {GreetingArt} [greetingArt] The picture that Roleplay chats show above the main greeting of the card.
 * @property {CardFraming} [cardFraming] How Home zooms the card's picture, for a card whose art draws the character smaller than the others.
 */

/**
 * @typedef {object} CardFraming
 * @property {number} zoom The scale of the picture inside the art box, which clips it.
 * @property {string} origin The `transform-origin` of the zoom, which keeps the face in the box.
 */

/**
 * A picture that is only shown, never part of a card or a chat file, so the model never sees it.
 *
 * @typedef {object} GreetingArt
 * @property {string} src The bundled file, served from this origin, with one file pixel per art pixel.
 * @property {string} src2x The same picture with every art pixel drawn as 2 by 2 file pixels.
 * @property {number} width The width of the picture in art pixels.
 * @property {number} height The height of the picture in art pixels.
 */

/** The account storage key of the Welcome Page Assistant, which is the default assistant unless the user chose another. */
export const ASSISTANT_POINTER_KEY = 'assistant';

/** @type {readonly AssistantEntry[]} */
export const ASSISTANTS = Object.freeze([
    {
        id: 'reisen',
        name: 'Reisen',
        home: true,
        art: 'row-reisen',
        avatarStorageKey: ASSISTANT_POINTER_KEY,
        identityStorageKey: 'bundledAssistantReisenIdentityAvatar',
        deletedStorageKey: 'bundledAssistantReisenDeleted',
        defaultAvatar: 'default_AssistantReisen.png',
        fileName: 'default_AssistantReisen',
        greetingArt: {
            src: '/img/sillybunny/greeting-reisen.webp',
            src2x: '/img/sillybunny/greeting-reisen@2x.webp',
            width: 768,
            height: 512,
        },
    },
    {
        id: 'tewi',
        name: 'Tewi',
        home: true,
        art: 'row-tewi',
        avatarStorageKey: 'bundledAssistantTewiAvatar',
        identityStorageKey: 'bundledAssistantTewiIdentityAvatar',
        deletedStorageKey: 'bundledAssistantTewiDeleted',
        defaultAvatar: 'default_AssistantTewi.png',
        fileName: 'default_AssistantTewi',
        cardFraming: Object.freeze({ zoom: 1.22, origin: '50% 22%' }),
        greetingArt: {
            src: '/img/sillybunny/greeting-tewi.webp',
            src2x: '/img/sillybunny/greeting-tewi@2x.webp',
            width: 768,
            height: 512,
        },
    },
].map(assistant => Object.freeze(assistant)));

/**
 * @param {string} id
 * @returns {AssistantEntry}
 * @throws {Error} When the registry does not list the assistant.
 */
export function getAssistant(id) {
    const assistant = ASSISTANTS.find(candidate => candidate.id === id);
    if (!assistant) {
        throw new Error(`The assistant registry has no assistant "${id}".`);
    }
    return assistant;
}

/** @returns {AssistantEntry[]} The assistants that Home lists, in order. */
export function getHomeAssistants() {
    return ASSISTANTS.filter(assistant => assistant.home === true);
}

/**
 * @param {string} id
 * @returns {readonly string[]} The avatar files that count as the assistant's card.
 */
export function getAssistantAvatars(id) {
    return Object.freeze([getAssistant(id).defaultAvatar]);
}
