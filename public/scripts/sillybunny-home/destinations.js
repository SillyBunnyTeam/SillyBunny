import { t } from '../i18n.js';

/**
 * The three places that Home offers, in the order of the Home tiles. Each has the key of its tile, a symbolic
 * icon, the line it says in the voice of an assistant, and a title. The Home tiles, the Home menu and the last
 * page of Welcome read these, so each string exists once. A title and a line are translated when `getTitle` and
 * `getLine` run, because the language can change after this module loads. Getting Started also has the line and the
 * icon that it shows once every step is resolved (`getDoneLine`, `doneIcon`).
 */
export const HOME_DESTINATIONS = Object.freeze([
    Object.freeze({
        key: 'getting-started',
        icon: 'fa-solid fa-list-check',
        doneIcon: 'fa-solid fa-circle-check',
        getLine: () => t`Are you new? Did you need a refresher? We've prepared a checklist for you to follow.`,
        getDoneLine: () => t`All done! Open me once more to check off your list.`,
        getTitle: () => t`Getting Started`,
    }),
    Object.freeze({ key: 'help', icon: 'fa-solid fa-circle-question', getLine: () => t`Want some extra help? Consult our help handbook at any time.`, getTitle: () => t`Help` }),
    Object.freeze({ key: 'extras', icon: 'fa-solid fa-box-open', getLine: () => t`Goodies I found just for you!`, getTitle: () => t`Bundled Extras` }),
]);

/**
 * The icon and the voiced line of a destination, as the Home tile and the What's Next row of Welcome show them. A
 * destination without a finished state shows the same in both.
 * @param {string} key
 * @param {{ finished?: boolean }} [options]
 * @returns {{ icon: string, line: string }}
 */
export function getDestinationLook(key, { finished = false } = {}) {
    const destination = getHomeDestination(key);
    return finished && 'getDoneLine' in destination
        ? { icon: destination.doneIcon, line: destination.getDoneLine() }
        : { icon: destination.icon, line: destination.getLine() };
}

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
