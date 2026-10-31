import { t } from '../i18n.js';

/**
 * The three places that Home offers, in the order of the Home tiles. Each has the key of its tile, a symbolic
 * icon, the copy slot of the line it says in the voice of an assistant, and a title. The Home tiles, the Home
 * menu and the last page of Welcome read these, so each string exists once. A title is translated when
 * `getTitle` runs, because the language can change after this module loads.
 */
export const HOME_DESTINATIONS = Object.freeze([
    Object.freeze({ key: 'getting-started', icon: 'fa-solid fa-list-check', lineSlot: 'HOME-ROW-GS-LINE', getTitle: () => t`Getting Started` }),
    Object.freeze({ key: 'help', icon: 'fa-solid fa-circle-question', lineSlot: 'HOME-ROW-HELP', getTitle: () => t`Help` }),
    Object.freeze({ key: 'extras', icon: 'fa-solid fa-box-open', lineSlot: 'HOME-ROW-EXTRAS', getTitle: () => t`Bundled Extras` }),
]);

/**
 * @param {string} key
 * @returns {typeof HOME_DESTINATIONS[number]}
 */
export function getHomeDestination(key) {
    const destination = HOME_DESTINATIONS.find(candidate => candidate.key === key);
    if (!destination) {
        throw new Error(`Unknown Home destination: ${key}`);
    }
    return destination;
}
