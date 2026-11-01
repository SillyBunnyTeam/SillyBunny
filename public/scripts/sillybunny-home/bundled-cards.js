import { getAssistantAvatars } from './assistant-registry.js';

/**
 * The avatar files of the cards that ship with SillyBunny: the default content (`default/content/index.json`
 * lists Seraphina and the Bunny Guide). Having one of them in the library says nothing about the user having gotten a
 * card of their own.
 *
 * Nahida is an assistant that earlier versions let the user install and that SillyBunny no longer ships. Her card
 * stays in the library of a user who installed her, and it must still not count as a card of their own, so her file
 * name stays here as a literal.
 */
export const BUNDLED_CARD_AVATARS = Object.freeze([
    'default_Seraphina.png',
    'default_SillyBunnyGuide.png',
    'default_AssistantNahida.png',
]);

/**
 * The avatar files of the two bundled assistants, Reisen and Tewi, from the assistant registry. They count as bundled
 * cards, and a chat with one of them picks the matching line for the done row of step 3.
 * @type {Readonly<{ reisen: readonly string[], tewi: readonly string[] }>}
 */
export const ASSISTANT_AVATARS = Object.freeze({ reisen: getAssistantAvatars('reisen'), tewi: getAssistantAvatars('tewi') });

/**
 * @param {string | null | undefined} avatar
 * @param {typeof ASSISTANT_AVATARS} [assistants]
 */
export function isBundledCard(avatar, assistants = ASSISTANT_AVATARS) {
    if (!avatar) {
        return false;
    }
    return BUNDLED_CARD_AVATARS.includes(avatar) || assistants.reisen.includes(avatar) || assistants.tewi.includes(avatar);
}

/**
 * The kind of card that finished the character step.
 * @param {string | null | undefined} avatar
 * @param {typeof ASSISTANT_AVATARS} [assistants]
 * @returns {import('./getting-started-storage.js').CharacterVariant}
 */
export function pickCharacterVariant(avatar, assistants = ASSISTANT_AVATARS) {
    if (avatar && assistants.reisen.includes(avatar)) {
        return 'reisen';
    }
    if (avatar && assistants.tewi.includes(avatar)) {
        return 'tewi';
    }
    return 'other';
}
