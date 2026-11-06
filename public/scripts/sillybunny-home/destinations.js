import { t } from '../i18n.js';

/**
 * The three places that Home offers, in the order of the Home tiles. Each has the key of its tile, a symbolic
 * icon, the line it says in the voice of an assistant, and a title. The Home tiles, the Home menu and the last
 * page of Welcome read these, so each string exists once. A title and a line are translated when `getTitle` and
 * `getLine` run, because the language can change after this module loads.
 */
export const HOME_DESTINATIONS = Object.freeze([
    Object.freeze({ key: 'getting-started', icon: 'fa-solid fa-list-check', getLine: () => t`Are you new? Did you need a refresher? We've prepared a checklist for you to follow.`, getTitle: () => t`Getting Started` }),
    Object.freeze({ key: 'help', icon: 'fa-solid fa-circle-question', getLine: () => t`Want some extra help? Consult our help handbook at any time.`, getTitle: () => t`Help` }),
    Object.freeze({ key: 'extras', icon: 'fa-solid fa-box-open', getLine: () => t`Goodies I found just for you!`, getTitle: () => t`Bundled Extras` }),
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
