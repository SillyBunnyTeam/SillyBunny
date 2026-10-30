/**
 * Stands in for the assistant cards until they exist.
 * @typedef {object} PlaceholderAssistant
 * @property {string} id
 * @property {string} name
 * @property {string} slot Copy slot of the subtitle.
 * @property {string} art Name of the art placeholder.
 */

/** @type {readonly PlaceholderAssistant[]} */
export const PLACEHOLDER_ASSISTANTS = Object.freeze([
    { id: 'reisen', name: 'Reisen', slot: 'AS-REISEN-SUB', art: 'row-reisen' },
    { id: 'tewi', name: 'Tewi', slot: 'AS-TEWI-SUB', art: 'row-tewi' },
]);
