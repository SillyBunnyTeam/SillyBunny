/**
 * The assistants that SillyBunny ships, in one list that Home, the Welcome Screen code, Getting Started and Bundled
 * Extras all read.
 *
 * - Reisen and Tewi come from the server: it seeds their cards, and the browser only looks for them. They have no
 *   portrait and no card of their own to create, so a missing card stays missing until the server puts it back.
 * - The Bunny Guide is the card the app creates for itself while Reisen has none.
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
 * @property {string} [portrait] The image of a card that the app creates.
 * @property {string} [characterName] The name on a card that the app creates.
 * @property {string} [title] The name by which a card of the assistant is recognised.
 * @property {string} [creator] The creator by which a card of the assistant is recognised, and the one a created card gets.
 * @property {string} [creatorNotes] The notes of a card that the app creates.
 * @property {string} [description] The description of a card that the app creates.
 * @property {string} [personality] The personality of a card that the app creates.
 * @property {string} [scenario] The scenario of a card that the app creates.
 * @property {string} [firstMessage] The greeting of a card that the app creates.
 * @property {GreetingArt} [greetingArt] The picture that Roleplay chats show above the main greeting of the card.
 *
 * `title`, `creator` and `characterName` are what the card of an assistant is recognised by. Reisen and Tewi, whose cards
 * only the server provides, have none of them, so code that reads them first asks `getCreationMethod`.
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
        greetingArt: {
            src: '/img/sillybunny/greeting-tewi.webp',
            src2x: '/img/sillybunny/greeting-tewi@2x.webp',
            width: 768,
            height: 512,
        },
    },
    {
        id: 'guide',
        name: 'Bunny Guide',
        avatarStorageKey: ASSISTANT_POINTER_KEY,
        identityStorageKey: 'bundledAssistantGuideAvatar',
        deletedStorageKey: 'bundledAssistantGuideDeleted',
        defaultAvatar: 'default_SillyBunnyGuide.png',
        fileName: 'default_SillyBunnyGuide',
        portrait: 'img/sillybunny-guide-assistant-portrait.png',
        characterName: 'Assistant',
        title: 'Bunny Guide',
        creator: 'purachina',
        creatorNotes: 'Automatically created bundled Bunny Guide character. Feel free to edit.',
        description: 'A calm built-in bunny assistant for explaining SillyBunny, SillyTavern, model providers, presets, personas, and related basics in plain English.',
        personality: 'Patient, beginner-friendly, calm, and practical.',
        scenario: 'You are the built-in Bunny Guide for SillyBunny. Help the user understand the interface, APIs, presets, prompt settings, personas, and world info in plain, approachable language.',
        firstMessage: 'Hi. I\'m the Bunny Guide. If anything in SillyBunny feels confusing, ask in plain English and I\'ll walk through it with you step by step.',
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

/**
 * How the app can bring the card of an assistant into the library by itself.
 * @param {Pick<AssistantEntry, 'portrait'>} assistant
 * @returns {'fallback' | null} Null for an assistant whose card only the server provides.
 */
export function getCreationMethod(assistant) {
    return assistant.portrait ? 'fallback' : null;
}

/**
 * The default assistant: Reisen once her card exists, and the Bunny Guide until then. Every caller that needs "the
 * assistant" asks here, so none of them decides it on its own.
 * @param {object} options
 * @param {(assistant: AssistantEntry) => boolean} options.hasCard Whether the library has the card of the assistant.
 * @returns {AssistantEntry}
 */
export function resolveDefaultAssistant({ hasCard }) {
    const reisen = getAssistant('reisen');
    return hasCard(reisen) ? reisen : getAssistant('guide');
}
