import { t } from '../i18n.js';

/**
 * The words of the Assistants section of Home and of the pictures above a greeting. They are read when a card or a
 * picture is made, not when this file loads, so they follow the language that the account has chosen.
 */

/**
 * @param {string} id The id of an assistant card: `reisen`, `tewi`, `pointer` for the character in the third slot, or
 *   `own` for the third slot while it holds none.
 * @returns {string} The subtitle under the name of the card, or an empty string for an unknown id.
 */
export function getAssistantSubtitle(id) {
    switch (id) {
        case 'reisen':
            return t`Did you need help with setup or troubleshooting? Leave it to me!`;
        case 'tewi':
            return t`Gege~ Are you a little down on your luck? Ask me anything!`;
        case 'pointer':
            return t`Chosen from your character library.`;
        case 'own':
            return t`Pick any character from your library as a third assistant.`;
        default:
            return '';
    }
}

/**
 * @param {string} assistantId The id of an assistant that has a greeting picture.
 * @returns {string} What the picture shows, for people who cannot see it, or an empty string for an unknown id.
 */
export function getGreetingArtAlt(assistantId) {
    switch (assistantId) {
        case 'reisen':
            return t`Early one evening, Reisen waves from her low desk among stacks of paperwork, tea and a mortar of herbs, while Tewi's ear peeks round the door.`;
        case 'tewi':
            return t`Late at night, Tewi rests her chin on her hands at the desk beside a newspaper and carrots, while Reisen sleeps over her papers under a blanket.`;
        default:
            return '';
    }
}
