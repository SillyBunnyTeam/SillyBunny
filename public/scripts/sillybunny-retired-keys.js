/** Account storage keys that earlier versions wrote and no code reads any more: the deck view, the tutorial, and the Bunny Guide's marks. */
export const RETIRED_ACCOUNT_KEYS = Object.freeze([
    'WelcomePage_DeckView',
    'WelcomePage_TutorialStatus',
    'WelcomePage_TutorialIndex',
    'bundledAssistantGuideAvatar',
    'bundledAssistantGuideDeleted',
]);

/**
 * Browser storage keys of the same kind. Earlier versions mirrored the `WelcomePage_*` preferences into the browser,
 * and kept the choice of the Frontend Icon there.
 */
export const RETIRED_LOCAL_KEYS = Object.freeze([
    ...RETIRED_ACCOUNT_KEYS,
    'sb-frontend-icon',
]);

/**
 * @typedef {{ removeItem: (key: string) => void }} RemovableStore
 */

/**
 * Deletes the retired keys. A key that is not there stays absent, and the account storage saves the settings only for
 * a key that it removes, so running this at every start costs nothing once the keys are gone.
 * @param {object} stores
 * @param {RemovableStore} stores.account The account storage, which must be ready.
 * @param {RemovableStore} stores.local The browser storage.
 */
export function removeRetiredKeys({ account, local }) {
    for (const key of RETIRED_ACCOUNT_KEYS) {
        account.removeItem(key);
    }
    for (const key of RETIRED_LOCAL_KEYS) {
        try {
            local.removeItem(key);
        } catch {
            // Browser storage can be blocked; the keys are unread there, so leaving them does no harm.
        }
    }
}

/**
 * Removes the retired keys once the account settings have loaded, which is the first moment the account storage is
 * ready, and again at APP_READY for a start where the listener was added after the first event.
 * @param {object} deps
 * @param {{ on: (event: string, listener: () => void) => void }} deps.eventSource
 * @param {{ SETTINGS_LOADED: string, APP_READY: string }} deps.eventTypes
 * @param {RemovableStore} deps.accountStorage
 * @param {RemovableStore} deps.storage The browser storage.
 */
export function initRetiredKeys({ eventSource, eventTypes, accountStorage, storage }) {
    const remove = () => removeRetiredKeys({ account: accountStorage, local: storage });
    eventSource.on(eventTypes.SETTINGS_LOADED, remove);
    eventSource.on(eventTypes.APP_READY, remove);
}
